# Handoff — in-progress work index

Each line below is one unfinished task, linking to its detailed plan/summary
under this directory. When you start work, add a line; when work fully
completes, remove the line. Keep entries to one line — detail belongs in the
linked spec doc. An optional "Next up" section lists known upcoming work in
order.

## In progress

- Renovate follow-ups (setup complete 2026-09-03; open loose ends in summary "Remaining / future": Micah's wp-admin DB-upgrade click after WP 7.0.4, grafana sidecar hot-reload 401, k3s upgrade then raise kubectl cap, gpu-agent Dependabot triage) — [summary](renovate-setup/summary.md)
- 1Password backup of repo plaintext secrets: `scripts/onepassword-secrets.mts` written, verified, and all 56 files pushed; left to do is spot-checking items in the UI and deleting the legacy monolithic `home-infra kubernetes secrets` item — [summary](onepassword-secret-backup/summary.md)
- Olya's live instructions/config made read-only at the Kubernetes level (activeassistant#71): manifests/scripts in this repo plus an `AGENTS.md` §6 rewrite in `activescott/activeassistant` — [plan](olya-readonly-instructions/plan.md)
- Sieve reconciler fix is deployed and the alert chain is verified firing/resolving, but the rules it destroyed on 2026-09-13 still need re-authoring in Bulwark, and the 04:43 run after that is the real proof they survive — [summary](sieve-user-rules-coexistence/summary.md)
