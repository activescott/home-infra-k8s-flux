#!/usr/bin/env bash
# Send a test message through the relay and check that its access controls still hold.
#
# The SASL passwords live in the relay's own Secret and nowhere else. This script never
# reads them: the python it pipes in runs *inside* the pod and reads them from that
# container's environment, so nothing sensitive reaches your shell or its history.
#
# It authenticates over the submission port like an application would, rather than calling
# sendmail(1) inside the container -- local injection bypasses SASL and
# smtpd_sender_login_maps entirely and would prove nothing about access control.
#
# By default it does not just send: it also proves the two controls that are supposed to
# refuse, and exits non-zero if either one lets a message through. A send on its own only
# demonstrates that the relay works, which is the failure mode nobody worries about.
#
# --send-only exists for the cases where extra noise is the problem rather than weaker
# coverage: submitting to mail-tester.com or similar, and testing after the delivery-failure
# alert is in place, where deliberately failing an auth would page someone.
#
# Usage:
#   ./send-test-email.sh <recipient> [app]  # app: fernfiles (default) | ramblefeed | tinkerbell
#   ./send-test-email.sh --send-only <recipient> [app]
#
# Environment:
#   KUBE_CONTEXT   kubectl context to use (default: nas)
#
# A delivered message logs `status=sent (250 2.0.0 Ok <...>)`; check it with
#   kubectl --context nas -n email-relay logs deploy/relay --tail=20 | grep status=
#
# Note productpoet.com cannot be used as a sender even though it is onboarded for Email
# Sending: it is parked with no A and no MX, so reject_unknown_sender_domain refuses it
# before the relay ever dials Cloudflare.

set -euo pipefail

context="${KUBE_CONTEXT:-nas}"
namespace=email-relay

usage() {
  echo "usage: $0 <recipient> [fernfiles|ramblefeed|tinkerbell]" >&2
  echo "       $0 --send-only <recipient> [fernfiles|ramblefeed|tinkerbell]" >&2
  exit 64
}

mode=access
if [[ "${1:-}" == "--send-only" ]]; then
  mode=send
  shift
fi

recipient="${1:-}"
app="${2:-fernfiles}"
[[ -n "$recipient" ]] || usage

# `foreign` is a domain this login must NOT be allowed to send as -- any of the others will
# do, so each app's checks use a different one.
case "$app" in
  fernfiles) login=fernfiles@relay.local; sender=noreply@fernfiles.com; foreign=noreply@ramblefeed.com ;;
  ramblefeed) login=ramblefeed@relay.local; sender=noreply@ramblefeed.com; foreign=noreply@tinkerbellbot.com ;;
  tinkerbell) login=tinkerbell@relay.local; sender=noreply@tinkerbellbot.com; foreign=noreply@fernfiles.com ;;
  *) usage ;;
esac

echo "sending as $sender (login $login) to $recipient on context $context, mode $mode"

# One python program for both modes. In access mode two of the three attempts MUST be
# refused; a pass there is a regression, not a success, so the exit status reflects the
# expectations rather than the send outcomes.
kubectl --context "$context" -n "$namespace" exec -i deploy/relay -- \
  python3 - "$mode" "$login" "$sender" "$foreign" "$recipient" <<'PY'
import os
import smtplib
import sys
from datetime import datetime, timezone

mode, login, sender, foreign, recipient = sys.argv[1:6]
users = dict(p.split(":", 1) for p in os.environ["SMTPD_SASL_USERS"].split(","))
stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
domain = sender.split("@", 1)[1]
failures = []


def body(subject, sender, recipient):
    """A test message that tells its reader what to look for without them
    having to remember the design."""
    return "\r\n".join(
        [
            f"From: {sender}",
            f"To: {recipient}",
            f"Subject: {subject}",
            "Auto-Submitted: auto-generated",  # keeps autoresponders and vacation replies quiet
            "",
            "This is a TEST message. Nothing is wrong; someone ran",
            "apps/production/email-relay/send-test-email.sh in home-infra-k8s-flux.",
            "",
            f"  sent at    {stamp}",
            f"  from       {sender}",
            f"  SASL login {login}",
            "  path       app -> Postfix null client (email-relay) -> Cloudflare Email",
            "             Sending on smtp.mx.cloudflare.net:465 -> your MX",
            "",
            "WHAT TO CHECK, in the raw source / original message headers:",
            "",
            "1. Authentication-Results -- all three must say pass:",
            f"     dkim=pass header.i=@{domain} header.s=cf-bounce",
            "     spf=pass",
            f"     dmarc=pass ... header.from={domain}",
            "",
            f"   The DKIM signature that matters is the one with d={domain} and",
            "   s=cf-bounce, signed with this domain's own key. A second DKIM signature",
            "   from d=cloudflare-email.net s=cf2024-1 is Cloudflare signing as itself and",
            "   is expected -- it is not a substitute for the first one.",
            "",
            f"2. Return-Path: <bounces@cf-bounce.{domain}>",
            "   This is what makes SPF align with the From domain under relaxed alignment,",
            "   which is what DMARC is passing on.",
            "",
            "3. NO Received header naming a pod. The relay strips its own via header_checks;",
            "   if you see `by relay-<hash>-<id> (Postfix)` or a 172.16.x.x address, that",
            "   protection has regressed and internal topology is reaching recipients.",
            "",
            "IF SOMETHING FAILS:",
            "",
            "   dkim=fail   -> the cf-bounce._domainkey record for the domain is wrong or",
            "                  missing; compare against Cloudflare's Email Sending settings.",
            "   spf=fail    -> check the TXT record on cf-bounce.<domain>.",
            "   dmarc=fail  -> alignment, not signing: SPF and DKIM can both pass while the",
            "                  From domain matches neither.",
            "",
            "   Relay-side, match by the timestamp above -- NOT by Message-ID. Cloudflare",
            "   rewrites it, so the ID on the delivered message does not appear in the",
            "   relay's log at all; the relay records its own, @relay.email-relay.svc.",
            "     kubectl --context nas -n email-relay logs deploy/relay | grep status=",
            "",
        ]
    )


def attempt(label, login, password, sender, expect_accepted):
    subject = f"[email-relay test] {sender} -- {stamp}"
    try:
        with smtplib.SMTP("127.0.0.1", 587, timeout=30) as s:
            s.login(login, password)
            s.sendmail(sender, [recipient], body(subject, sender, recipient))
        outcome, detail = True, "accepted"
    except smtplib.SMTPException as e:
        outcome, detail = False, f"{type(e).__name__}: {e}"

    ok = outcome == expect_accepted
    print(f"[{'ok' if ok else 'REGRESSION'}] {label}: {detail}")
    if not ok:
        failures.append(label)


# The happy path. Sends a real message, in both modes.
attempt(f"{sender} accepted", login, users[login], sender, True)

if mode == "access":
    # smtpd_sender_login_maps: one app must not be able to send as another's domain.
    attempt(f"{foreign} refused", login, users[login], foreign, False)

    # SASL is genuinely enforced, rather than the connection being permitted by mynetworks.
    attempt("bad password refused", login, "not-the-password", sender, False)

sys.exit(1 if failures else 0)
PY
