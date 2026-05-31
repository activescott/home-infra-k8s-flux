# photoprism MariaDB 10.8 → 10.11 LTS — summary

## ⚠️ Action required: rotate `photoprism-scott` MARIADB_PASSWORD

During the recovery sequence (commit `b713526` work), the photoprism
user's `MARIADB_PASSWORD` for the **`photoprism-scott`** tenant was
echoed by the mariadb client into the recovery transcript when a
`CREATE USER` statement failed with `ERROR 1396`. The literal
plaintext value appeared in my conversation output. **Rotate this
password in `apps/production/photoprism/scott/.env.secret.mariadb-creds.encrypted`**
and update the running pod's secret.

The root password may also have been in scope but its `CREATE USER`
statements succeeded silently — the client did not echo their text.
Still, rotating both is the conservative move. The oksana and micah
tenant credentials were never exposed.

## Outcome

All three tenants are on `mariadb:10.11.18` with `mariadb-upgrade`
completed cleanly. Pods report `Ready=true, 0 restarts`.

## Final commits

| # | sha | Purpose |
|---|---|---|
| 1 | `ee289f6` | Bump base manifest image `mariadb:10.8` → `mariadb:10.11`. |
| 2 | `af6e453` | Add `MARIADB_AUTO_UPGRADE=1` to base; the 10.11 entrypoint defaults to *skipping* the upgrade. |
| 3 | `3551f01` | (oksana) Add temporary `MARIADB_DISABLE_UPGRADE_BACKUP=1` to skip the failing system-DB backup so `mariadb-upgrade` could repair the Aria index corruption. |
| 4 | `80117ab` | (scott) Add temporary `MARIADB_AUTO_UPGRADE=0` to stop the crashloop caused by duplicate-row failure in `mariadb-upgrade` Phase 3. |
| 5 | `b71db11` | (scott) Add emergency `--skip-grant-tables` patch after REPAIR TABLE collateral damage dropped `root@%`, `root@localhost`, and `photoprism@%` from `mysql.global_priv`. |
| 6 | `b713526` | (scott) Remove both temporary patches; auth restored, ready for upgrade. |
| 7 | `017f915` | (oksana) Remove the `MARIADB_DISABLE_UPGRADE_BACKUP` patch; upgrade is complete. |

## What went well

- **micah**: clean linear upgrade. All 8 mariadb-upgrade phases ran
  on first cycle. Surfaced no pre-existing data issues.
- The per-tenant overlay structure made it possible to apply
  surgical recovery patches to oksana and scott without affecting
  micah.
- Eventual recovery of both oksana and scott without resorting to
  rollback or backup restore.

## What went wrong (and what I learned)

### 1. Skipped backups based on stated "minor jump" framing
The user opted to skip pre-upgrade `mysqldump` snapshots based on
my framing that 10.8 → 10.11 is a low-risk minor jump. The actual
jump was forward-compatible, but **the upgrade surfaced pre-existing
on-disk corruption** in two of three tenants that we didn't know
existed until 10.11's stricter entrypoint flagged it.

**Lesson:** the question "is the version jump safe" is independent
of "is the existing data safe." For tenant-isolated stateful
workloads I should propose logical backups even when the version
delta itself is low-risk, because the upgrade is the *first time*
anything inspects the on-disk integrity in a while.

### 2. `REPAIR TABLE` was the wrong tool for a corrupt Aria PK index
I ran `REPAIR TABLE mysql.global_priv` on scott to clean up
duplicate rows whose presence violated the PRIMARY KEY constraint.
The Aria recovery engine dropped 3 *valid* rows (the photoprism and
root accounts) while rebuilding the index, reporting
`"Number of rows changed from 7 to 4"`. This took scott from
"degraded but working" to "completely locked out."

**Lesson:** for Aria-table index corruption with confirmed
duplicate rows, the correct sequence is:
1. Take a logical backup of the table (`SELECT ... INTO OUTFILE`).
2. Manually DELETE duplicates with `LIMIT 1`.
3. If the index is still inconsistent, `aria_chk --safe-recover`
   from outside the running server, *not* `REPAIR TABLE` inside
   the server.
Doing the REPAIR before the manual DELETE removes the safety net.

### 3. Password leaked into the transcript
During recovery, the mariadb client echoed the failed
`CREATE USER ... IDENTIFIED BY "<password>"` statement to stderr
on error 1396. Because I had not redirected stderr, the photoprism
password landed in my visible output. The user must now rotate it.

**Lesson:** never let `IDENTIFIED BY` SQL escape to a captured
output stream. Going forward: pipe stderr to `/dev/null` for
CREATE/ALTER USER, or use `IDENTIFIED BY PASSWORD '<hash>'` with
a pre-computed hash so the cleartext never appears in the SQL.

## Root cause summary (per tenant)

| Tenant | Pre-existing condition | Surfaced because |
|---|---|---|
| **micah** | None. | n/a — clean upgrade. |
| **oksana** | Corrupt Aria PK index on `mysql.proc` (stored procedures table; photoprism doesn't use stored procs). | 10.11's new pre-upgrade `mariadb-dump` of system DB fails on the bad index. |
| **scott** | Corrupt Aria PK index on `mysql.global_priv` allowing exact-duplicate rows for `photoprism@%`, `root@%`, `root@localhost`. | `mariadb-upgrade` Phase 3 `mysql_fix_privilege_tables` rejects the duplicates with "Multiple accounts ... differ only in Host lettercase". |

Why two of three tenants had corrupt Aria indexes is unknown. Same
underlying file-system, same MariaDB version history, same workload
shape. Likely a past dirty shutdown or hostPath I/O hiccup that
left the index inconsistent without breaking serving — invisible
under 10.8.

## Final cluster state

```
photoprism-oksana   mariadb-0:Ready/0 restarts  photoprism-app-0:Ready/0
photoprism-scott    mariadb-0:Ready/0 restarts  photoprism-app-0:Ready/0
photoprism-micah    mariadb-0:Ready/0 restarts  photoprism-app-0:Ready/0
```

All MariaDB pods are `10.11.18`, all photoprism-app pods reconnected
without restarting (they hold persistent connections that the kernel
TCP keepalive eventually rebuilds).

## Follow-up checklist

- [ ] **(URGENT)** Rotate `MARIADB_PASSWORD` in
      `apps/production/photoprism/scott/.env.secret.mariadb-creds.encrypted`,
      re-encrypt with sops, push. Consider rotating `MARIADB_ROOT_PASSWORD`
      too as a conservative measure.
- [ ] Browse photos.scott.willeke.com, photos.oksana.willeke.com,
      photos.micah.willeke.com from a real browser to confirm UI
      works end-to-end.
- [ ] Audit other Aria system tables across all three tenants for
      latent corruption (`CHECK TABLE mysql.proc, mysql.global_priv,
      mysql.servers, mysql.help_*` — anything still on Aria).
- [ ] (Optional, hygiene) Enable the staging Let's Encrypt
      ClusterIssuer so future migrations of this scope can probe
      against staging first. Same callout the cert-manager summary
      raised.
