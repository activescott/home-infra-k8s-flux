# Summary: Olya's live instructions/config made read-only

Done and verified in the cluster on 2026-09-16. See [plan.md](plan.md) for why the mechanism
is a read-only mount rather than the ConfigMap the issue proposed.

- `activescott/home-infra-k8s-flux#125` — merged as `f3ebeb3`
- `activescott/activeassistant#74` — merged (`AGENTS.md` §6)
- Closes `activescott/activeassistant#71`

## What shipped

`/state/workspace` and `/state/config` are mounted `readOnly: true` in the `olya` container
only. `seed-workspace`, `install-plugins` and `instruction-sync` keep their read-write `/state`
mount, so they still write those paths. The live config moved out of `$OPENCLAW_STATE_DIR` into
`/state/config`, and the memory files moved to `/state/memory` with symlinks at workspace root.

A second commit replaced the "must match" comments with a real shared module: `MEMORY_PATHS` had
three copies and the change was about to add a fourth copy of the seed-and-relink sequence.
`scripts/volume-layout.mts` now holds the layout and the three operations, and
`seed-workspace.sh` became `seed-workspace.mts` so it can import it.

## Verified in the cluster

Every check below was run against the live pod. Two boots were exercised: the migration boot and
a plain `rollout restart` on an already-migrated volume.

| Check | Result |
| --- | --- |
| `echo x >> /state/workspace/AGENTS.md` | `Read-only file system`, exit 2 |
| `echo x >> /state/config/openclaw.json` | `Read-only file system`, exit 2 |
| `rm /state/workspace/USER.md` | `Read-only file system`, exit 1 |
| `echo x >> /state/workspace/USER.md` | succeeds, lands in `/state/memory/USER.md` |
| `echo x >> /state/workspace/DREAMS.md` (dangling link) | creates `/state/memory/DREAMS.md` |
| `touch /state/repos/x` | succeeds |
| memory after migration | 22/22 files, `MEMORY.md` 2254B, `USER.md` 3000B, unchanged |
| `olya-memory-sync` manual run | `no memory changes (4 path(s) checked)`, exit 0 |
| second boot | no `migrating`/`seeding` lines, relink only; all initContainers exit 0 |
| gateway startup | `auto-enabled plugins for this runtime without writing config` |

That last line is `OPENCLAW_CONFIG_READONLY=1` behaving as the second layer: it adapts instead of
trying to write, so the read-only mount is never even reached. The mount is still the control.

## Things worth knowing next time

- **`DREAMS.md` has never existed in the repo**, so its workspace-root symlink is deliberately
  dangling. Writing through it creates the target; reading it before any write fails with ENOENT,
  exactly as it did before this change. Not a bug, and not worth "fixing" by committing an empty
  file.
- **`seed-workspace` logs `discarding local modifications` on every boot from now on.** The five
  memory paths are tracked in git as regular files and are replaced by symlinks, so `git status`
  reports a typechange. Cosmetic. Do not try to silence it by untracking them: the checkout copies
  are what seed a cold start.
- **`/state/memory` paths are repo-relative**, so the repo's `memory/` directory is at
  `/state/memory/memory`. That is what lets `memory-sync.mts` copy them straight into a fresh
  clone with no rewriting.
- **`memory-sync.mts` skips symlinks** (`copyable()` uses `lstat`). Pointing it at the workspace
  instead of `/state/memory` would copy nothing and report success. The `MEMORY_DIR` env var on
  the CronJob is what keeps it honest.
- **Both config writers must overwrite in place.** `cp` and `copyFileSync` keep the inode, which
  the gateway's inotify watch depends on. Unlink-and-recreate, or pointing the gateway at the
  workspace copy that `git checkout --force` replaces, would silently stop config reloads.

## Bug the test harness caught

`mkdirSync(MEMORY_LIVE/memory)` ran before the seeding loop, so the `memory` entry always looked
present and was never seeded from the checkout. A cold start would have come up with an empty
memory directory and no error anywhere. Found by a throwaway harness that loads
`volume-layout.mts` with `STATE` rewritten to a temp directory and exercises cold start, steady
state, write-through-symlink, and a deleted memory file. Worth rebuilding if that file changes
again; it is about 60 lines and needs no fixtures.

## Commands to re-verify

```bash
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/workspace/AGENTS.md'   # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/config/openclaw.json'  # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'rm /state/workspace/USER.md'            # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/workspace/USER.md'     # expect success
kubectl --context nas -n olya logs olya-0 -c seed-workspace | grep -E 'migrat|seeding|linked|published'
kubectl --context nas -n olya create job --from=cronjob/olya-memory-sync olya-memory-sync-test
kubectl --context nas -n olya logs job/olya-memory-sync-test    # want "pushed N file(s)" or "no memory changes"
kubectl --context nas -n olya delete job olya-memory-sync-test
```

## Not done

- The gateway's config file-watcher crashing the pod on an edit (the original 2026-09-15 symptom)
  was out of scope and is unchanged. It is now much harder to trigger, since the file cannot be
  edited from inside the container, but the watcher itself was not touched.
- Branch protection on `activescott/activeassistant` needed nothing: the `protect-default-branch`
  ruleset already requires PR + code-owner review, with `activescott` the only bypass actor. The
  issue's `GET /branches/main/protection` → 404 was a false negative from an endpoint that does
  not report rulesets.
