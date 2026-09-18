# Handoff — in-progress work index

Each line below is one unfinished task, linking to its detailed plan/summary
under this directory. When you start work, add a line; when work fully
completes, remove the line. Keep entries to one line — detail belongs in the
linked spec doc. An optional "Next up" section lists known upcoming work in
order.

## In progress

- Renovate follow-ups (setup complete 2026-09-03; open loose ends in summary "Remaining / future": Micah's wp-admin DB-upgrade click after WP 7.0.4, grafana sidecar hot-reload 401, k3s upgrade then raise kubectl cap, gpu-agent Dependabot triage) — [summary](renovate-setup/summary.md)
- 1Password backup of repo plaintext secrets: `scripts/onepassword-secrets.mts` written, verified, and all 56 files pushed; left to do is spot-checking items in the UI and deleting the legacy monolithic `home-infra kubernetes secrets` item — [summary](onepassword-secret-backup/summary.md)
- Age-key-only secrets (#159): [plan](age-key-only-secrets/plan.md) written and awaiting Scott's approval. Implementation (new `show`/`edit`/`new`/`rotate-age-key` commands, one-time `migrate --verify`, removal of `push`/`pull`) has not started.
- Sieve reconciler fix is deployed and the alert chain is verified firing/resolving, but the rules it destroyed on 2026-09-13 still need re-authoring in Bulwark, and the 04:43 run after that is the real proof they survive — [summary](sieve-user-rules-coexistence/summary.md)
