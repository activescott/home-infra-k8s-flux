"""Ensure every mailbox account has the archive-all Sieve script active.

Per-account Sieve scripts are not in Stalwart's configuration registry -- the Account object
has no script field -- so stalwart-cli cannot set them and they cannot be declared in
plan.ndjson. The only way in is to authenticate *as* the user, which is what the
`automation` principal's `impersonate` permission is for: ManageSieve accepts a composite
login `<target>%<impersonator>` with the impersonator's password. Both halves must be full
addresses -- bare account names are rejected with "localhost.local", because the domain
cannot be inferred.

The account list is fetched over the management JMAP API with the same credentials. That
used to be an initContainer running `stalwart-cli query Account --json`, which cannot work:
the CLI writes to stdout and its image is distroless, so there is no shell to redirect with
and no way to hand the output to the next container.

SAFETY. Users write their own rules into the same script, because they have nowhere else to
put them: ingest runs only the account's active script, and Bulwark manages a single
account-scoped script it cannot rename or choose. So this merges rather than replaces. The
admin content is delimited by marker comments and only that region is rewritten; every other
byte of the script is preserved.

Matching on the script *name* is not enough, and assuming otherwise destroyed a day of
hand-written rules on 2026-09-13: Bulwark edits the script named `archive-all`, so user rules
arrive inside the very script this job owns and are indistinguishable from body drift. An
active script with no managed block is now reported and skipped, never overwritten.

The only writes are:
  - install and activate the managed block where no script is active at all
  - wrap the legacy unmarked body in markers, once, to migrate an account
  - refresh the managed region in place when it has drifted from what git says
"""

import base64
import json
import os
import socket
import ssl
import sys
import urllib.request

API_URL = os.environ.get(
    "STALWART_URL", "http://stalwart-admin.email-stalwart.svc.cluster.local:8080"
)
HOST = os.environ.get("SIEVE_HOST", "stalwart-sieve.email-stalwart.svc.cluster.local")
PORT = int(os.environ.get("SIEVE_PORT", "4190"))
IMPERSONATOR = os.environ["STALWART_USER"]
PASSWORD = os.environ["STALWART_PASSWORD"]
SCRIPT_NAME = os.environ.get("SIEVE_SCRIPT_NAME", "archive-all")
SCRIPT_BODY = os.environ.get(
    "SIEVE_SCRIPT_BODY", 'require ["include"];\r\ninclude :global "archive-all";\r\n'
)
# Comments delimiting the admin-owned region. Bulwark preserves comments that are not part
# of its own metadata block, and preserves Sieve it cannot model as an "External rule", so
# these survive a round-trip through its filter editor.
MANAGED_BEGIN = os.environ.get(
    "SIEVE_MANAGED_BEGIN",
    "# >>> BEGIN stalwart-sieve-reconcile managed block -- do not edit <<<",
)
MANAGED_END = os.environ.get(
    "SIEVE_MANAGED_END", "# >>> END stalwart-sieve-reconcile managed block <<<"
)
# Used only to spot copies of the admin include that have escaped the managed region.
INCLUDE_STATEMENT = os.environ.get(
    "SIEVE_INCLUDE_STATEMENT", 'include :global "archive-all"'
)
# Accounts that never receive mail, so an archive copy would be pointless.
SKIP = {s for s in os.environ.get("SIEVE_SKIP_ACCOUNTS", "admin,automation").split(",") if s}
DRY_RUN = os.environ.get("SIEVE_DRY_RUN", "").lower() in ("1", "true", "yes")


class SieveError(Exception):
    pass


class Sieve:
    """Enough of RFC 5804 (ManageSieve) to list, fetch, upload and activate a script."""

    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=20)
        self.buf = b""
        self.read_response()  # server greeting and capabilities
        self.starttls()

    def starttls(self):
        """Stalwart refuses AUTHENTICATE on an unencrypted ManageSieve connection --
        `NO (ENCRYPT-NEEDED) "Cannot authenticate over plain-text."` -- so this is required,
        not optional hardening.

        Certificate verification is off deliberately. The connection is a single in-cluster
        hop to a ClusterIP, and the certificate is issued for mail.activescott.com while we
        dial a .svc.cluster.local name, so it could never validate as-addressed. What is
        being satisfied here is the server's requirement that the channel be encrypted; we
        are not crossing a network where the server's identity is in question.
        """
        status, _ = self.cmd("STARTTLS")
        if status != "OK":
            raise SieveError("STARTTLS refused")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self.sock = ctx.wrap_socket(self.sock, server_hostname="mail.activescott.com")
        self.buf = b""
        self.read_response()  # capabilities are re-sent after the TLS handshake

    def _line(self):
        while b"\r\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SieveError("connection closed by server")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\r\n", 1)
        return line.decode("utf-8", "replace")

    def read_response(self):
        """Read until a completion response. Returns (status, [lines/literals])."""
        payload = []
        while True:
            line = self._line()
            if line.startswith("{"):
                # Literal: {n} or {n+}, followed by exactly n octets.
                count = int(line[1:].rstrip("+}"))
                while len(self.buf) < count:
                    chunk = self.sock.recv(65536)
                    if not chunk:
                        raise SieveError("connection closed mid-literal")
                    self.buf += chunk
                payload.append(self.buf[:count].decode("utf-8", "replace"))
                self.buf = self.buf[count:]
                if self.buf.startswith(b"\r\n"):
                    self.buf = self.buf[2:]
                continue
            if line.startswith(("OK", "NO", "BYE")):
                return line.split(" ", 1)[0], payload
            payload.append(line)

    def cmd(self, text):
        self.sock.sendall((text + "\r\n").encode("utf-8"))
        return self.read_response()

    def authenticate(self, authcid, password):
        blob = base64.b64encode(
            b"\0" + authcid.encode("utf-8") + b"\0" + password.encode("utf-8")
        ).decode("ascii")
        status, _ = self.cmd('AUTHENTICATE "PLAIN" "%s"' % blob)
        if status != "OK":
            raise SieveError("authentication rejected for %s" % authcid)

    def list_scripts(self):
        """Returns (name -> is_active)."""
        status, lines = self.cmd("LISTSCRIPTS")
        if status != "OK":
            raise SieveError("LISTSCRIPTS failed")
        out = {}
        for line in lines:
            line = line.strip()
            if not line.startswith('"'):
                continue
            end = line.index('"', 1)
            out[line[1:end]] = "ACTIVE" in line[end:].upper()
        return out

    def get_script(self, name):
        status, payload = self.cmd('GETSCRIPT "%s"' % name)
        if status != "OK":
            raise SieveError("GETSCRIPT %s failed" % name)
        return payload[0] if payload else ""

    def put_script(self, name, body):
        data = body.encode("utf-8")
        self.sock.sendall(('PUTSCRIPT "%s" {%d+}\r\n' % (name, len(data))).encode("utf-8"))
        self.sock.sendall(data + b"\r\n")
        status, payload = self.read_response()
        if status != "OK":
            raise SieveError("PUTSCRIPT %s rejected: %s" % (name, " ".join(payload)))

    def set_active(self, name):
        status, payload = self.cmd('SETACTIVE "%s"' % name)
        if status != "OK":
            raise SieveError("SETACTIVE %s failed: %s" % (name, " ".join(payload)))

    def close(self):
        try:
            self.cmd("LOGOUT")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def normalise(text):
    """Compare bodies ignoring line-ending and trailing-whitespace differences only."""
    return "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").strip().split("\n"))


def managed_region():
    """The admin-owned block: git's script body between the two marker comments."""
    body = SCRIPT_BODY.replace("\r\n", "\n").strip("\n")
    return "\r\n".join([MANAGED_BEGIN] + body.split("\n") + [MANAGED_END])


def split_managed(body):
    """Locate the managed region. Returns (start, end_exclusive), or None if absent."""
    start = body.find(MANAGED_BEGIN)
    if start == -1:
        return None
    end = body.find(MANAGED_END, start + len(MANAGED_BEGIN))
    if end == -1:
        return None
    return start, end + len(MANAGED_END)


def merge_managed(body, span):
    """Rewrite only the managed region, preserving every other byte of the script."""
    start, end = span
    return body[:start] + managed_region() + body[end:]


def stray_includes(body, span):
    """Count admin include statements that have escaped the managed region.

    Harmless if it happens -- two identical fileinto calls to one mailbox are a no-op per
    RFC 5228 -- but it means the editor relocated our content, which is worth reporting.
    """
    outside = body if span is None else body[: span[0]] + body[span[1] :]
    return outside.count(INCLUDE_STATEMENT)


def install(sieve, name, previous=None):
    """Write the managed block as `name` and activate it, logging what it replaced."""
    if previous and previous.strip():
        print("  previous body of %r follows (job log is the only backup):" % name)
        for line in previous.replace("\r\n", "\n").rstrip("\n").split("\n"):
            print("  | %s" % line)
    sieve.put_script(name, managed_region() + "\r\n")
    sieve.set_active(name)


def reconcile(address):
    sieve = Sieve(HOST, PORT)
    try:
        sieve.authenticate("%s%%%s" % (address, IMPERSONATOR), PASSWORD)
        scripts = sieve.list_scripts()
        active = next((n for n, is_active in scripts.items() if is_active), None)

        if active is None:
            if DRY_RUN:
                return "would-install", "no script is active"
            install(sieve, SCRIPT_NAME)
            return "installed", "no script was active"

        current = sieve.get_script(active)
        span = split_managed(current)

        if MANAGED_BEGIN in current and span is None:
            return "skipped", "%r has an unterminated managed block" % active

        if span is not None:
            merged = merge_managed(current, span)
            extra = stray_includes(merged, split_managed(merged))
            note = "" if not extra else " (%d stray include(s) outside the block)" % extra
            if normalise(merged) == normalise(current):
                return "ok", "managed block already current" + note
            if DRY_RUN:
                return "would-update", "managed block drifted" + note
            print("  previous body of %r follows (job log is the only backup):" % active)
            for line in current.replace("\r\n", "\n").rstrip("\n").split("\n"):
                print("  | %s" % line)
            sieve.put_script(active, merged)
            sieve.set_active(active)
            return "updated", "managed block refreshed, user rules preserved" + note

        # No markers. Only the exact body this job used to write is safe to touch -- anything
        # else is a script somebody wrote by hand, and overwriting it is the 2026-09-13 bug.
        if active == SCRIPT_NAME and normalise(current) == normalise(SCRIPT_BODY):
            if DRY_RUN:
                return "would-migrate", "legacy unmarked body"
            install(sieve, SCRIPT_NAME)
            return "migrated", "legacy body wrapped in managed markers"

        return "skipped", "%r has no managed block -- not overwriting" % active
    finally:
        sieve.close()


def fetch_accounts():
    """List accounts over the management JMAP API.

    Shape taken from the CLI's own source rather than guessed: an x:Foo/query chained into
    an x:Foo/get by a #ids back-reference, with Stalwart's own capability URN alongside core.

    The `x:` prefix is not decoration. Registry object names are canonicalised with it
    (canonicalise_with_prefix in the CLI's schema resolver), and a bare "Account/query" comes
    back as unknownMethod.
    """
    body = json.dumps({
        "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
        "methodCalls": [
            ["x:Account/query", {}, "q"],
            ["x:Account/get", {
                "#ids": {"resultOf": "q", "name": "x:Account/query", "path": "/ids"},
                "properties": ["name", "emailAddress"],
            }, "g"],
        ],
    }).encode()
    auth = base64.b64encode(
        ("%s:%s" % (IMPERSONATOR, PASSWORD)).encode("utf-8")
    ).decode("ascii")
    req = urllib.request.Request(
        API_URL.rstrip("/") + "/jmap",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Basic " + auth},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    for name, args, _tag in payload.get("methodResponses", []):
        if name == "x:Account/get":
            return args.get("list", [])
    raise SieveError("no x:Account/get response: %s" % json.dumps(payload)[:300])


def main():
    items = fetch_accounts()

    addresses = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        address = item.get("emailAddress") or name
        if name in SKIP or address in SKIP:
            continue
        if address:
            addresses.append(address)

    if not addresses:
        print("no accounts to reconcile (after skipping %s)" % ", ".join(sorted(SKIP)))
        return 0

    failures = 0
    skipped = 0
    for address in sorted(addresses):
        try:
            outcome, detail = reconcile(address)
        except Exception as exc:  # noqa: BLE001 - one bad account must not stop the rest
            outcome, detail = "ERROR", str(exc)
            failures += 1
        if outcome == "skipped":
            skipped += 1
        print("%-34s %-14s %s" % (address, outcome, detail))
        if outcome in ("skipped", "ERROR"):
            # ALERT TOKEN. Alloy matches this exact phrase into
            # loki_process_custom_stalwart_sieve_unmanaged_total, which the
            # StalwartSieveArchiveRuleMissing rule alerts on. Changing the wording
            # silently disables the alert -- a broken selector looks identical to a
            # healthy run, because the counter simply never appears. Change it in
            # apps/production/monitoring/alloy/helmrelease.yaml in the same commit.
            #
            # Emitted per account, so the counter measures accounts-not-archiving
            # rather than runs-that-had-a-problem. A skip is this job correctly
            # declining to overwrite somebody's script, but the consequence is the same
            # as a crash: that mailbox gets no archive copy, and the whole point of
            # archive-all is that deleting from the Inbox does not destroy mail. Silent
            # is the one thing it must not be.
            print(
                "ERROR sieve-reconcile: archive rule not applied: %s: %s"
                % (address, detail)
            )

    # Deliberately not part of the alert selector -- the per-account lines above are what
    # the counter counts, and matching this too would double-count every run.
    print(
        "\n%d account(s): %d failed, %d skipped for having no managed block"
        % (len(addresses), failures, skipped)
    )
    if skipped:
        print(
            "Recover a skipped account by re-adding the managed block to its active\n"
            "script (Bulwark keeps it as a locked External rule), or by deactivating\n"
            "that script so this job installs a fresh one."
        )
    # Exit status still tracks hard failures only. A skip is a correct refusal, and making
    # it non-zero would leave the CronJob permanently Failed for as long as one account
    # has hand-written rules -- noise that would train the operator to ignore it. The
    # alert is the signal for that case.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
