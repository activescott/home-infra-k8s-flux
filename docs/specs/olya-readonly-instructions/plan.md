# Make Olya's live instructions/config read-only; require a PR to change them

Tracking: [activescott/activeassistant#71](https://github.com/activescott/activeassistant/issues/71)

Spans two repos: `activescott/home-infra-k8s-flux` (public, the manifests and scripts)
and `activescott/activeassistant` (private, the instructions/config the assistant runs on).

## 0. Save this plan

Save this file to `docs/specs/olya-readonly-instructions/plan.md` before touching anything
else. Spec docs are committed in this repo, so it ships with the change.

## Problem

On 2026-09-15 the assistant edited the live `/state/openclaw/openclaw.json` directly with
her own tools — no git, no PR — and the gateway's file-watcher picked it up and crashed the
pod. Nothing on the pod prevented the write. The "instruction files change only by PR" rule
existed as prose in `AGENTS.md` §6 and as a boot-time `git checkout --force`, neither of
which stops a write from taking effect *between* boots.

## What investigation changed about the issue's proposal

### Open question #1 in the issue is already closed — no work needed

The issue states `activescott/activeassistant`'s `main` has "no branch protection at all",
citing `GET /branches/main/protection` → 404. That endpoint only reports *classic* branch
protection and returns 404 when protection is supplied by a ruleset. The repo has an active
ruleset:

```
$ gh api repos/activescott/activeassistant/rulesets/22885119
protect-default-branch / active / ~DEFAULT_BRANCH
  pull_request: required_approving_review_count=1, require_code_owner_review=true,
                allowed_merge_methods=[squash],
                require_extra_approval_for_unattributed_changes=true
  deletion, non_fast_forward
  required_status_checks: lint (strict)
bypass_actors: activescott (user 213716, always)
```

`.github/CODEOWNERS` is `* @activescott`. PR #69 was authored and merged by `olyapop` but
carries an `APPROVED` review from `activescott`, so it was reviewed — the merge button being
hers is not a gap while code-owner review is required and she is not a bypass actor.

### The issue's primary mechanism (ConfigMap) does not fit

Blockers, all from `openclaw.json` in `activeassistant`:

- `agents.defaults.workspace: "/state/workspace"`, and OpenClaw discovers bootstrap files
  (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`) and the skill root `<workspace>/skills`
  at the **workspace root**. Moving those files into a `config/` subdirectory stops them
  being found.
- Workspace root cannot be a ConfigMap mount, because memory files (`MEMORY.md`,
  `DREAMS.md`, `USER.md`, `IDENTITY.md`, `memory/`) live there and must stay writable.
- ConfigMap keys cannot contain `/`, so `subagents/claude/CLAUDE.md` would need a flattened
  key plus a hand-maintained `items[].path` list in the StatefulSet — reintroducing exactly
  the "path list to keep in sync" the issue set out to remove.
- It needs a second Flux `GitRepository` and a deploy key for a private repo pulled into
  this public repo's reconcile graph, for no added enforcement strength over the
  alternative below.

### Mechanism chosen: read-only mount of the same PVC, olya container only

`volumeMounts[].readOnly` is per container and per mount entry, so the same PVC can be
read-write in `seed-workspace` / `install-plugins` / `instruction-sync` and read-only in the
`olya` container. That is a Kubernetes primitive; it does not depend on OpenClaw behaving.

The trade the issue names is real and accepted: a future manifest edit could silently drop
`readOnly: true`. This repo's CODEOWNERS + default-branch ruleset is the control on that.

## Target pod layout

PVC `olya-state` subdirectories after this change:

| Path              | olya container | Written by                                  |
| ----------------- | -------------- | ------------------------------------------- |
| `/state/home`     | read-write     | her, dotfiles, harness credentials          |
| `/state/openclaw` | read-write     | OpenClaw state dir (SQLite, transcripts)    |
| `/state/config`   | **read-only**  | seed-workspace + instruction-sync only      |
| `/state/workspace`| **read-only**  | seed-workspace + instruction-sync only      |
| `/state/memory`   | read-write     | her (memory-core), read by the sync CronJob |
| `/state/repos`    | read-write     | her, on-demand work clones                  |
| `/state/archive`  | read-write     | nightly exports                             |

Two new mount entries on the `olya` container, both referencing the existing `state` volume:

```yaml
- name: state
  mountPath: /state/workspace
  subPath: workspace
  readOnly: true
- name: state
  mountPath: /state/config
  subPath: config
  readOnly: true
```

### Why the live config moves to `/state/config/openclaw.json`

It cannot stay at `/state/openclaw/openclaw.json`: that directory is OpenClaw's state dir
and has to stay writable for SQLite, so a read-only mount over it is not available. A
single-file `subPath` mount of just `openclaw.json` was rejected twice over — kubelet
creates a *directory* at a `subPath` that does not exist yet, which breaks cold start on a
fresh volume, and a single-file mount goes stale forever if a writer ever recreates the
inode instead of overwriting in place.

Pointing `OPENCLAW_CONFIG_PATH` straight at the workspace copy
(`/state/workspace/openclaw.json`) was also rejected: `instruction-sync` updates the
workspace with `git checkout --force`, which replaces the file's inode, so the gateway's
inotify watch would follow the old inode and silently stop noticing config changes.

A dedicated `/state/config` directory avoids all three. Both writers copy **in place**
(`cp`, `copyFileSync`), so the inode is stable and the watcher survives, and a
directory-level mount has neither problem.

### Why memory moves to `/state/memory` and is symlinked back

OpenClaw reads `IDENTITY.md` and `USER.md` from the workspace root, and memory-core writes
them there; a read-only workspace makes those writes fail. So the live copies move to
`/state/memory` (read-write) and the workspace root gets symlinks pointing at them.

This works because of how Linux resolves paths: `open("/state/workspace/USER.md")` follows
the symlink to the absolute path `/state/memory/USER.md`, which is reached through the
read-write `/state` mount, so the write succeeds. The symlink itself sits in the read-only
mount, so she cannot unlink or replace it.

Paths under `/state/memory` are **repo-relative**, which is why the repo's `memory/`
directory lands at `/state/memory/memory/`. Awkward to read, but it is what lets
`memory-sync.mts` keep its `MEMORY_PATHS` list unchanged and copy straight into the clone.

Note `memory-sync.mts`'s `copyable()` uses `lstat` and skips symlinks, so the CronJob must
read `/state/memory` directly — pointing it at the workspace root would silently copy
nothing.

## Tasks

### `home-infra-k8s-flux` (PR 1)

1. `apps/production/olya/olya-statefulset.yaml`
   - `olya` container: add the two read-only mount entries above.
   - `olya` container: `OPENCLAW_CONFIG_PATH` → `/state/config/openclaw.json`; add
     `OPENCLAW_CONFIG_READONLY: "1"` as the second layer (better error message than a bare
     `EACCES`; explicitly *not* the control).
   - `install-plugins` initContainer: same `OPENCLAW_CONFIG_PATH`. It keeps a read-write
     `/state`, so it can still write config and trust records.
   - Update the header comments that describe the mixed save/reset/restore policy, which
     this change replaces.
2. `apps/production/olya/scripts/volume-layout.mts` (new) — the PVC layout as constants plus
   the operations that maintain it: `MEMORY_PATHS`, `linkMemoryIntoWorkspace()`,
   `publishConfig()`, `installSubagentFiles()`. See "Why a shared module" below.
3. `apps/production/olya/scripts/seed-workspace.sh` → `seed-workspace.mts`
   - Translated to TypeScript so it can import the module above. `curl | jq` against
     `api.github.com` becomes `fetch`; everything else is a literal translation and every
     comment is carried over.
   - Create `/state/config` and `/state/memory`.
   - One-time migration: before the reset, copy any real (non-symlink) memory path out of
     `/state/workspace` into `/state/memory` if it is not already there. Idempotent — after
     migration those paths are symlinks and are skipped.
   - After `cloneOrReset`, call the three shared operations.
   - Point the Claude Code auto-memory symlink at `/state/memory/memory`.
   - Drop the `$saved` tmpdir dance: memory no longer lives inside the tree being reset.
4. `apps/production/olya/scripts/instruction-sync.mts`
   - Drop the `MEMORY_PATHS` save/restore (memory is outside the checkout now).
   - After the reset, call the same three shared operations, in the same order.
5. `apps/production/olya/olya-memory-sync-cronjob.yaml` + `scripts/memory-sync.mts`
   - `WORKSPACE_DIR` → `MEMORY_DIR`, value `/state/memory`; `MEMORY_PATHS` imported.
   - Replace the "is not a git checkout" liveness guard with "`/state/memory` does not
     exist" — same property (proves `seed-workspace` ran), correct for the new layout.
6. `apps/production/olya/README.md` — document the read-only boundary and the new paths.

### Why a shared module

`MEMORY_PATHS` existed in three copies (`seed-workspace.sh`, `instruction-sync.mts`,
`memory-sync.mts`) held in step by a "must match" comment, and this change was about to add
a fourth copy of the seed-and-relink sequence. The failure that invites is quiet: add a
memory file, miss one of the lists, and it is either discarded on the next boot or never
reaches git, with nothing to see either way.

All three scripts already mount the same `olya-scripts` ConfigMap at `/scripts`, so a
module is importable from each. Converting `seed-workspace.sh` to `.mts` is the price of
that — bash cannot import it.

Two things verified rather than assumed:

- **Imports resolve through the ConfigMap's symlink farm.** Kubernetes materialises a
  ConfigMap volume as `name -> ..data/name`, and Node resolves specifiers against the
  importing file's realpath. Reproduced that exact layout in a sandbox and imported across
  it successfully.
- **`linkMemoryIntoWorkspace()` behaves on cold start, steady state, and after a deletion.**
  A throwaway harness loaded the module with `STATE` rewritten to a temp directory. It found
  a real bug: `mkdirSync(MEMORY_LIVE/memory)` ran before the seeding loop, so the `memory`
  entry always looked present and was never seeded from the checkout. A cold start would
  have come up with an empty memory directory and no error. The `mkdir` now runs after the
  loop, with a comment saying why the order matters.

### `activeassistant` (PR 2)

7. `AGENTS.md` §6 — rewrite to describe the *mechanism*, not just the rule:
   - Everything at workspace root except the memory paths is mounted read-only. A write
     fails with a filesystem permission error; that is correct, not a bug.
   - Her writable clone is `/state/repos/activeassistant`, made by her, as with any work
     repo.
   - Recovery for a failed edit: clone → change → commit signed → push branch →
     `gh pr create`. Merged changes reach her within 15 minutes via `instruction-sync`, no
     restart.
   - Memory files: unchanged in behaviour — write freely, never commit.
   - Her cwd `/state/workspace` is no longer writable; scratch goes in `/tmp`,
     `/state/repos`, or `/state/memory`.

## Verification

Enforcement has to be proven by forcing the condition, never by observing silence:

```
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/workspace/AGENTS.md'   # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/config/openclaw.json'  # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'rm /state/workspace/USER.md'            # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/workspace/USER.md'     # expect SUCCESS (symlink -> /state/memory)
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'touch /state/repos/x && rm /state/repos/x'  # expect SUCCESS
```

Then confirm the memory loop still closes: check the `olya-memory-sync` CronJob's next run
logs in Loki (`{namespace="olya", app="olya-memory-sync"}`) for a `pushed N file(s)` or
`no memory changes` line rather than the refusal message.

## Risks

- **Memory migration is one-way and touches live data.** The migration copies rather than
  moves, so the pre-migration copies survive in the workspace until the reset discards
  them; the volume is in the B2 backup set and under ZFS snapshots either way.
- **A dangling symlink on a cold start.** Handled by seeding `/state/memory` from the
  checkout before symlinking, but worth checking on the first boot after this lands.
- **`git status` noise.** The workspace-root memory paths are tracked files replaced by
  symlinks, so `clone_or_reset` logs them as local modifications on every boot. Cosmetic.
- **The config-watcher crash from the original incident is out of scope** and unchanged by
  this work.
