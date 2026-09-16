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
`/state/config`, and the memory files moved to `/state/memory`.

They first came back to workspace root as symlinks, which was wrong and is described in
[plan-memory-bind-mounts.md](plan-memory-bind-mounts.md); they are bind mounts now. Anything
below that still says "symlink" is describing the superseded design.

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
| **re-verified 2026-09-16 after the bind-mount change** | `bootstrap file is unreadable`: 3 → 0; all 5 paths real files with inodes matching `/state/memory`; EROFS still on `AGENTS.md`, `openclaw.json`, `skills/`; `no memory changes (5 path(s) checked)`; 0 restarts |
| `touch /state/repos/x` | succeeds |
| memory after migration | 22/22 files, `MEMORY.md` 2254B, `USER.md` 3000B, unchanged |
| `olya-memory-sync` manual run | `no memory changes (4 path(s) checked)`, exit 0 |
| second boot | no `migrating`/`seeding` lines, relink only; all initContainers exit 0 |
| gateway startup | `auto-enabled plugins for this runtime without writing config` |

That last line is `OPENCLAW_CONFIG_READONLY=1` behaving as the second layer: it adapts instead of
trying to write, so the read-only mount is never even reached. The mount is still the control.

## Things worth knowing next time

- **Every memory path must be tracked in `activeassistant`, including an empty `DREAMS.md`.** The
  checkout is what provides the bind mountpoints, and a bind mount cannot create its destination
  under a read-only parent. This reverses an earlier note here that said a missing `DREAMS.md`
  was fine and "not worth fixing by committing an empty file" — that was true of the symlink
  design and is false now. memory-core also requires `stat.isFile()` before writing it.
- **The boot reset leaves the workspace clean**, because the mounts exist only in the `olya`
  container and the containers running git see ordinary tracked files. Any dirt `seed-workspace`
  reports is now worth reading. The one exception was the 2026-09-16 transition boot, which ran
  against a tree still holding the previous design's symlinks and logged ~28 lines once.
- **`/state/memory` paths are repo-relative**, so the repo's `memory/` directory is at
  `/state/memory/memory`. That is what lets `memory-sync.mts` copy them straight into a fresh
  clone with no rewriting.
- **`memory-sync.mts` must keep reading `/state/memory`, not the workspace.** Its pod does not
  carry the bind mounts, so the workspace paths there are the stale tracked copies from the
  checkout; pointing it at them would commit the repo's contents back over her live memory. The
  `MEMORY_DIR` env var on the CronJob is what keeps it honest.
- **Memory files must be edited in place.** A bind mount is tied to the inode that existed at
  container start, so anything that replaces a file under `/state/memory` (`mv`, `rm`, `sed -i`,
  temp-file-and-rename editors, rsync without `--inplace`, a snapshot rollback of a running pod)
  silently splits the gateway's view from what the sync commits. Restarting the pod repairs it.
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

The bind-mount change rebuilt it for `seedMemoryFromCheckout` (cold volume, steady state,
`DREAMS.md` absent everywhere, and a kubelet-created directory where a file belongs). Same
pattern, same reason: these are the paths where a bug is silent.

## Final state, 2026-09-16

- `/state/workspace` and `/state/config` read-only in the `olya` container; enforcement
  re-verified after every change since.
- Memory writable via bind mounts from `/state/memory`; no symlinks anywhere in the workspace.
- acpx session state at `/state/openclaw/acpx-state`, image staging at
  `/state/openclaw/cli-images`, both out of the read-only tree.
- A `postStart` hook fails the container rather than letting a missing or read-only mount eat her
  memory silently.

**Still open:** `activescott/activeassistant#42`. The acpx `stateDir` fix is deployed but
unexercised — `/state/openclaw/acpx-state` is created lazily on the first ACP spawn, so the issue
should not close until a real opencode session runs.

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

## Regressions found afterwards

Making the workspace read-only broke two things that had been quietly writing into it. Both were
invisible before because `git clean -ffdx` deleted them on every boot.

The way to find them was `seed-workspace`'s own pre-reset `git status`, which had been logging
every untracked path for weeks:

```
kubectl --context nas -n olya logs olya-0 -c seed-workspace | grep '^??'
# or across all boots, in Loki:
{namespace="olya", container="seed-workspace"} |~ "^\\?\\? "
```

Over 14 days that showed three non-memory writers: `state/` (acpx, every boot),
`.openclaw-cli-images/`, and `opencode/` (once, unexplained, not reproduced since).

- **`state/` — acpx session store.** `activescott/activeassistant#42`. acpx resolves
  `config.stateDir?.trim() || path.join(workspaceDir, "state")` and mkdirs it, so every ACP spawn
  failed and opencode sessions returned no output. Fixed by setting
  `plugins.entries.acpx.config.stateDir` to `/state/openclaw/acpx-state` in `openclaw.json`
  (`activescott/activeassistant#80`). Side effect: ACP session state is now durable, where
  `git clean` used to wipe it every boot. Nothing prunes it.
- **`.openclaw-cli-images/` — image staging.** Not configurable: openclaw's claude-cli backend
  hardcodes `imagePathScope: "workspace"` and `openclaw config schema` has no key for it.
  claude-cli is the default runtime for `anthropic/*`, so every image sent to her would fail to
  stage. Fixed with a symlink to `/state/openclaw/cli-images` via `WORKSPACE_ESCAPE_HATCHES`.

**If something else breaks this way, do not mount an emptyDir over the path.** A mount point
inside the checkout cannot be removed by `git clean -ffdx`, so the reset fails with EBUSY and
crashloops `seed-workspace` on every boot. Configure the tool if it has a knob; add a
`WORKSPACE_ESCAPE_HATCHES` entry if it does not.

## Not done

- The gateway's config file-watcher crashing the pod on an edit (the original 2026-09-15 symptom)
  was out of scope and is unchanged. It is now much harder to trigger, since the file cannot be
  edited from inside the container, but the watcher itself was not touched.
- Branch protection on `activescott/activeassistant` needed nothing: the `protect-default-branch`
  ruleset already requires PR + code-owner review, with `activescott` the only bypass actor. The
  issue's `GET /branches/main/protection` → 404 was a false negative from an endpoint that does
  not report rulesets.
