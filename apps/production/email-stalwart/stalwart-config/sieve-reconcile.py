"""Ensure every mailbox account has the archive-all Sieve script active.

Per-account Sieve scripts are not in Stalwart's configuration registry -- the Account object
has no script field -- so stalwart-cli cannot set them and they cannot be declared in
plan.ndjson. The only way in is to authenticate *as* the user, which is what the
`automation` principal's `impersonate` permission is for: ManageSieve accepts a composite
login `<target>%<impersonator>` with the impersonator's password.

The account list comes from /work/accounts.json, written by an initContainer running
`stalwart-cli query Account --json` with the same credentials.

SAFETY. This never overwrites a script somebody else wrote. An account whose active script
is not ours is reported and skipped. The only writes are:
  - install and activate ours where no script is active at all
  - update our own script in place when its body has drifted from what git says
"""

import base64
import json
import os
import socket
import sys

HOST = os.environ.get("SIEVE_HOST", "stalwart-sieve.email-stalwart.svc.cluster.local")
PORT = int(os.environ.get("SIEVE_PORT", "4190"))
IMPERSONATOR = os.environ["STALWART_USER"]
PASSWORD = os.environ["STALWART_PASSWORD"]
SCRIPT_NAME = os.environ.get("SIEVE_SCRIPT_NAME", "archive-all")
SCRIPT_BODY = os.environ.get(
    "SIEVE_SCRIPT_BODY", 'require ["include"];\r\ninclude :global "archive-all";\r\n'
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


def reconcile(address):
    sieve = Sieve(HOST, PORT)
    try:
        sieve.authenticate("%s%%%s" % (address, IMPERSONATOR), PASSWORD)
        scripts = sieve.list_scripts()
        active = next((n for n, is_active in scripts.items() if is_active), None)

        if active is not None and active != SCRIPT_NAME:
            return "skipped", "another script is active: %r -- not overwriting" % active

        if SCRIPT_NAME in scripts:
            current = sieve.get_script(SCRIPT_NAME)
            if normalise(current) == normalise(SCRIPT_BODY) and active == SCRIPT_NAME:
                return "ok", "already current"
            if DRY_RUN:
                return "would-update", "body drifted or not active"
            sieve.put_script(SCRIPT_NAME, SCRIPT_BODY)
            sieve.set_active(SCRIPT_NAME)
            return "updated", "body drifted or was inactive"

        if DRY_RUN:
            return "would-install", "no script present"
        sieve.put_script(SCRIPT_NAME, SCRIPT_BODY)
        sieve.set_active(SCRIPT_NAME)
        return "installed", "no script was present"
    finally:
        sieve.close()


def main():
    with open("/work/accounts.json") as handle:
        raw = json.load(handle)

    # `stalwart-cli query --json` shape is not contractual, so accept the plausible forms
    # rather than assuming one and failing obscurely at 03:00.
    items = raw.get("items", raw) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        print("unexpected accounts.json shape: %r" % type(items).__name__, file=sys.stderr)
        return 2

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

    print(
        "\n%d account(s): %d failed, %d skipped for having their own script"
        % (len(addresses), failures, skipped)
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
