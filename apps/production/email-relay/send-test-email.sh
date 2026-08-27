#!/usr/bin/env bash
# Send a test message through the relay, or check that its access controls still hold.
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

if [[ "$mode" == send ]]; then
  echo "sending as $sender (login $login) to $recipient via $namespace/relay on context $context"
  kubectl --context "$context" -n "$namespace" exec -i deploy/relay -- \
    python3 - "$login" "$sender" "$recipient" <<'PY'
import os, smtplib, sys

login, sender, recipient = sys.argv[1:4]
users = dict(p.split(":", 1) for p in os.environ["SMTPD_SASL_USERS"].split(","))
with smtplib.SMTP("127.0.0.1", 587, timeout=30) as s:
    s.login(login, users[login])
    s.sendmail(
        sender,
        [recipient],
        f"From: {sender}\r\nTo: {recipient}\r\n"
        "Subject: email-relay test\r\n\r\n"
        "Sent through the email-relay Postfix null client to Cloudflare Email Sending.\r\n"
        "Check the received headers for SPF, DKIM and DMARC results.\r\n",
    )
print("accepted by postfix for delivery")
PY
  exit 0
fi

# Access checks. Two of the three MUST be refused; a pass there is a regression, not a
# success, so the exit status reflects the expectations rather than the send outcomes.
echo "sending as $sender (login $login) to $recipient and checking access controls, context $context"
kubectl --context "$context" -n "$namespace" exec -i deploy/relay -- \
  python3 - "$login" "$sender" "$foreign" "$recipient" <<'PY'
import os, smtplib, sys

login, sender, foreign, recipient = sys.argv[1:5]
users = dict(p.split(":", 1) for p in os.environ["SMTPD_SASL_USERS"].split(","))
failures = []


def attempt(label, login, password, sender, expect_accepted):
    try:
        with smtplib.SMTP("127.0.0.1", 587, timeout=30) as s:
            s.login(login, password)
            s.sendmail(
                sender,
                [recipient],
                f"From: {sender}\r\nTo: {recipient}\r\n"
                f"Subject: email-relay access check -- {label}\r\n\r\n{label}\r\n",
            )
        outcome, detail = True, "accepted"
    except smtplib.SMTPException as e:
        outcome, detail = False, f"{type(e).__name__}: {e}"

    ok = outcome == expect_accepted
    print(f"[{'ok' if ok else 'REGRESSION'}] {label}: {detail}")
    if not ok:
        failures.append(label)


# The happy path. Sends a real message.
attempt(f"{sender} accepted", login, users[login], sender, True)

# smtpd_sender_login_maps: one app must not be able to send as another's domain.
attempt(f"{foreign} refused", login, users[login], foreign, False)

# SASL is genuinely enforced, rather than the connection being permitted by mynetworks.
attempt("bad password refused", login, "not-the-password", sender, False)

sys.exit(1 if failures else 0)
PY
