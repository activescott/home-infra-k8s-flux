# Plan: replace the memory symlinks with bind mounts

Follow-up to [plan.md](plan.md) / [summary.md](summary.md). Fixes a regression that
`activescott/home-infra-k8s-flux#125` introduced and that its verification missed.

Reviewed adversarially before implementation; see [Review response](#review-response) for what
changed as a result. One blocking defect was found in the first draft.

## The bug

OpenClaw's workspace loader resolves bootstrap files with `rejectSymlinks: true`:

```js
if (params.rejectSymlinks === true && params.isLast) throw new FsSafeError("symlink", "symlink path component not allowed");
```

#125 relocated the memory files to `/state/memory` and left symlinks at workspace root, so
since it deployed at ~05:50 on 2026-09-16 the gateway has logged, on every boot:

```
{"fileName":"IDENTITY.md","filePath":"/state/workspace/IDENTITY.md",
 "reason":"symlink path component not allowed",
 "message":"Workspace bootstrap file is unreadable."}
{"fileName":"USER.md",   ... same}
{"fileName":"MEMORY.md", ... same}
```

She boots without her identity, without who Scott is, and without her memory index.
`SOUL.md` and `AGENTS.md` are unaffected: they are regular files from the checkout.

The blast radius is wider than those three reads. memory-core guards its DREAMS.md writes the
same way:

```js
if (!stat.isFile()) throw new Error("Refusing to write non-file DREAMS.md");
if (stat.isSymbolicLink()) throw new Error("Refusing to write symlinked DREAMS.md");
```

So the nightly dreaming sweep has been failing too. Symlinks were the wrong primitive on both
the read and the write side.

The files are intact on disk. `cat /state/workspace/IDENTITY.md` returns all 1026 bytes.
This is OpenClaw's own containment policy, not a filesystem problem, and there is no config
override: `rejectSymlinks` is an internal parameter and does not appear anywhere in
`openclaw config schema`.

**Why #125's verification missed it.** Every check proved a *write* property: writes land in
`/state/memory`, the symlink cannot be unlinked, `memory-sync` still commits. Nothing checked
that the gateway could *read* the files back. `seed-workspace.sh` even carried a comment saying
"Copies, not symlinks: OpenClaw's skill loader enforces symlink containment" — the same policy,
written down, and used symlinks anyway.

## The fix

Replace the symlinks with `subPath` bind mounts of the same PVC. A bind mount presents a real
file to everything in the container, so `rejectSymlinks` and `isFile()` both pass, while writes
still land on the volume at `/state/memory`.

On the `olya` container only, nested inside the read-only `/state/workspace` mount, all writable:

| mountPath                               | subPath               | mountpoint provided by |
| --------------------------------------- | --------------------- | ---------------------- |
| `/state/workspace/MEMORY.md`            | `memory/MEMORY.md`    | tracked in repo        |
| `/state/workspace/DREAMS.md`            | `memory/DREAMS.md`    | **new** empty tracked file |
| `/state/workspace/USER.md`              | `memory/USER.md`      | tracked in repo        |
| `/state/workspace/IDENTITY.md`          | `memory/IDENTITY.md`  | tracked in repo        |
| `/state/workspace/memory`               | `memory/memory`       | tracked in repo        |
| `/state/workspace/.openclaw-cli-images` | `openclaw/cli-images` | **new** tracked `.gitkeep` |

The last row replaces the symlink from #130, so no symlink remains anywhere in the workspace.

**The "mountpoint provided by" column is load-bearing, not documentation.** A bind mount needs
its destination to already exist, and the destination is inside a read-only parent, so the
runtime cannot create it. Every mountpoint therefore has to be a path the checkout materialises.
That is why `DREAMS.md` and `.openclaw-cli-images/.gitkeep` must be committed to
`activeassistant`, and why the memory paths must stay tracked there.

### What this improves beyond fixing the bug

- **The `git status` churn disappears** rather than being summarised. The underlying checkout
  files stay ordinary regular files; the mounts exist only in the `olya` container's mount
  namespace, so `seed-workspace` and `instruction-sync` see a clean tree.
- **No relink step after every reset.** `git clean -ffdx` cannot disturb a mount that does not
  exist in the container running git.
- **No EBUSY risk from `git clean`.** The containers running git do not have these mounts.

### Why not the inverse design

Making the workspace writable and read-only-mounting each *instruction* file was considered
(and is the shape Scott originally suggested). Bind-mounting a file makes it un-deletable even
in a writable directory, so it would work mechanically, and it would dissolve findings 1-3
entirely.

Rejected because the two designs fail in opposite directions. Read-only-by-default fails safe:
forget a memory mount and memory writes break loudly. Read-only-by-enumeration fails open:
forget an instruction mount and that instruction file is silently writable again, which is the
original vulnerability returning with no symptom. Instruction files also change far more often
than memory paths, so the enumeration would be touched more and get stale faster.

## Hazards

1. **A missing mountpoint fails container creation.** Mounts are applied shallowest-first, so
   `/state/workspace` is mounted and remounted read-only before the deeper mounts are processed;
   creating a missing destination underneath it then returns EROFS and the container never
   starts. Handled by making every mountpoint a tracked path (table above).

2. **A `subPath` source that does not exist makes kubelet create a directory there**, root-owned,
   which `fsGroup` does not correct on a hostPath PV. For `DREAMS.md` that surfaces as
   OpenClaw's "Refusing to write non-file DREAMS.md". Handled by `seed-workspace` creating every
   `MEMORY_PATHS` entry and `/state/openclaw/cli-images` before the `olya` container starts.
   kubelet resolves a container's subPaths at that container's creation, i.e. after
   initContainers finish, so one boot is sufficient.

3. **Atomic rename onto a mountpoint would fail EBUSY.** memory-core writes with plain
   `writeFile`; there is no `rename` in that path. Also confirmed empirically during #125's
   verification, where a write through the `USER.md` symlink left the symlink intact.

4. **Source-side inode replacement silently decouples the four file mounts.** A bind mount pins
   the inode resolved at container start. `/state/memory/USER.md` is writable by the agent, so
   `sed -i`, `mv`, `rm`, most editors, `rsync` without `--inplace`, or a snapshot rollback
   replace the inode and split the two views: the gateway keeps reading and writing the orphaned
   inode while memory-sync commits the new file. No error anywhere.

   Not fully preventable — the files must be writable and must be at workspace root. Mitigated
   by documenting the in-place-only rule in `AGENTS.md` §6 and in the StatefulSet, by the
   startup check below (which re-establishes a correct view every boot and fails loudly if the
   mount is absent), and by exercising the scenario during verification so the symptom is
   recognised. The `memory/` directory mount is immune; renames inside a bind-mounted directory
   are visible.

5. **The mount list and `MEMORY_PATHS` must agree**, across two files and two repos. kubelet
   cannot read a TypeScript constant, so the coupling cannot be collapsed. Guarded by the
   startup check below.

## The startup check

`seed-workspace` cannot verify the mounts: it runs in a different container, in a different
mount namespace, and it *creates* the very files it would be asserting on, so the assertion
would always pass. The only place "this path is mounted" is a checkable fact is inside the
`olya` container.

A `postStart` lifecycle hook on the `olya` container runs `scripts/check-memory-mounts.mts`,
which for each `MEMORY_PATHS` entry confirms the workspace path and the `/state/memory` path are
the same inode, and that the workspace path is writable. A mismatch means the mount is missing
or has been decoupled, and the hook exits non-zero, which kills the container.

Failing this hard is deliberate and matches how the rest of this deployment behaves: OpenClaw
refuses to start on an invalid config, `memory-sync` refuses to run against a missing directory,
`seed-workspace` exits on a missing ssh key. A memory path that is silently not writable loses
her memory with no symptom, which is the failure mode this whole spec series exists to remove.

## Rollout

Single change, but the merge order matters because the mountpoints come from the checkout and
`seed-workspace` clones `origin/main` at boot:

1. **`activeassistant` first** — empty `DREAMS.md`, `.openclaw-cli-images/.gitkeep`, and the
   `AGENTS.md` §6 note about editing memory in place.
2. **`home-infra-k8s-flux` second** — the mounts, the startup check, and the removal of the
   symlink machinery. This one restarts the pod, by which time `origin/main` already carries the
   mountpoints.

Code removed in step 2: `linkMemoryIntoWorkspace`'s symlink half, `linkWritableEscapeHatches`,
`WORKSPACE_ESCAPE_HATCHES`, `splitDirty`, `isExpectedMemoryDirt`, and the relink call in
`instruction-sync`. What remains in `volume-layout.mts` is seeding plus the path list.

**Expect one noisy boot.** The transition boot runs `git status` against a tree that still has
the previous boot's symlinks, and the classifier that used to summarise them is gone, so
`seed-workspace` will log the full ~28-line typechange-and-deletion listing once. It looks like
the 2026-09-12 incident and is not. Every boot after it is clean.

## Verification

#125 was verified thoroughly on the write path and still shipped a read-path bug, so the checks
below are chosen to force conditions rather than observe silence.

**Positive control, already in hand.** Today's pre-fix logs contain the exact warning string on
this exact image, which is what makes its later absence meaningful:

```
kubectl --context nas logs -n olya olya-0 -c olya | grep -c "bootstrap file is unreadable"   # pre-fix: 3
```

After the change:

```
# 1. The bug itself. Positive control above makes 0 meaningful.
kubectl --context nas logs -n olya olya-0 -c olya | grep -c "bootstrap file is unreadable"   # expect 0
kubectl --context nas logs -n olya olya-0 -c olya | grep -ci "DREAMS"                        # expect no refusal

# 2. Real files, not symlinks, and the same inode as the source.
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c \
  'for f in MEMORY.md DREAMS.md USER.md IDENTITY.md; do
     test -L /state/workspace/$f && echo "SYMLINK: $f";
     [ "$(stat -c %i /state/workspace/$f)" = "$(stat -c %i /state/memory/$f)" ] || echo "NOT MOUNTED: $f";
   done; echo checked'

# 3. Round-trip through the gateway: write a sentinel, restart, confirm it is read back.
#    Proves the read path positively rather than by absence of a warning.

# 4. Enforcement from #125 still holds.
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/workspace/AGENTS.md'   # expect EROFS
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'echo x >> /state/config/openclaw.json'  # expect EROFS

# 5. Container restart WITHOUT pod recreation: initContainers do not rerun and mounts
#    re-resolve. This path has never been exercised in this spec series.
kubectl --context nas exec -n olya olya-0 -c olya -- sh -c 'kill 1'
#    then re-run checks 1 and 2.

# 6. The startup check actually fires. Force it: decouple one mount from inside the container
#    (rename the source), restart the container, confirm the hook fails loudly. Then restore.

# 7. Cold volume: extend the existing harness to cover seed-then-mount on an empty PVC. The last
#    cold-start bug was only found this way.

# 8. Boot is clean after the transition boot.
kubectl --context nas logs -n olya olya-0 -c seed-workspace | grep -E 'discarding|ignoring' || echo "clean"

# 9. Memory still reaches git.
kubectl --context nas -n olya create job --from=cronjob/olya-memory-sync olya-memory-sync-test
kubectl --context nas -n olya logs job/olya-memory-sync-test    # want "pushed N file(s)" or "no memory changes"
kubectl --context nas -n olya delete job olya-memory-sync-test
```

## Review response

An adversarial review of the first draft returned SOUND WITH CHANGES with one blocking defect.
What it found and what changed:

1. **BLOCKING — `.openclaw-cli-images` had no mountpoint.** The other five mounts land on tracked
   files; that one was untracked, deleted by `git clean -ffdx` every boot, and the draft deleted
   the only code that recreated it. Mounting onto a non-existent path under an already-read-only
   parent returns EROFS and the container never starts. It also identified a nastier delayed
   variant: `instruction-sync` re-runs `git clean` every 15 minutes, so a later container restart
   without pod recreation would hit the same error long after deploy.
   *Changed:* `.openclaw-cli-images/.gitkeep` is committed to the repo, and the "mountpoint
   provided by" column now makes the requirement explicit for every row.

2. **The boot-time assertion was vacuous.** The same function that asserted the paths exist also
   created them, and it runs in a container that cannot see the mounts at all. It proved nothing
   about the StatefulSet.
   *Changed:* replaced with a `postStart` check inside the `olya` container comparing inodes, and
   the claim that it closes the coupling is no longer made for the seed-side code.

3. **Source-side inode replacement was unanalysed.** The draft only considered renames onto the
   mountpoint, not replacement of the mount source, which the agent herself can do with ordinary
   tools and which splits the two views silently.
   *Changed:* new hazard 4, documentation duty in `AGENTS.md` §6, and verification step 6.

4. **Deleting the classifier was only justified under one resolution of an open question the
   draft had left open**, and the transition boot would be noisy.
   *Changed:* the `.gitkeep` decision makes the classifier genuinely inert, so the deletion is
   now sound; the noisy transition boot is predicted above and verification no longer expects
   silence on that boot.

5. **Verification still observed silence.** Grepping for zero occurrences of a warning passes
   equally when the warning's wording changes.
   *Changed:* added the positive control, the sentinel round-trip, the restart-without-pod-
   recreation case, forcing the startup check to fire, and the cold-volume harness.

6. **The empty `DREAMS.md` reverses a decision recorded in summary.md.** True, and now stated
   outright. The reviewer asked whether OpenClaw treats empty and absent alike; checking the code
   answered better than expected, since memory-core requires `stat.isFile()` and rejects
   symlinks, so an empty regular file is exactly the right state and the old dangling symlink was
   breaking the dreaming sweep as well.

7. **Mechanism questions confirmed:** a writable `subPath` nested under a read-only mount of the
   same volume works, ordering comes from containerd's depth sort rather than YAML order, the
   hostPath backing is irrelevant, and a missing subPath source yields a root-owned directory
   that `fsGroup` will not fix. Also confirmed that phasing was unnecessary for the source-side
   hazard, which is why this ships as one change with an ordered merge.

## Implementation review response

The implementation was reviewed against this plan before the PR was opened. Verdict was SHIP
WITH CHANGES; five findings, all fixed:

1. **The startup check implemented only half of what this plan committed to.** It compared inodes
   but skipped the writability check, and inode equality alone certifies two silent failures as
   healthy: a stray `readOnly: true` on one of the six mounts (an easy copy-paste from the two
   read-only mounts they sit between) matches inodes and fails every write; and if the source is
   deleted while the pod runs, a later container restart *without pod recreation* has kubelet
   create a root-owned directory at the subPath source, so both paths become that same directory
   — inodes equal, type wrong, unwritable — and `seedMemoryFromCheckout`'s type assertion cannot
   catch it because initContainers do not rerun.
   *Fixed:* the hook now asserts the type as well, and calls `accessSync(W_OK)`, which reports
   EROFS on a read-only mount even when the permission bits allow writing.

2. **The in-place-only rule was documented in `AGENTS.md` but not in the StatefulSet**, which this
   plan had committed to. *Fixed:* added to the mount comment block.

3. **Two comments in the StatefulSet still described the symlink design being deleted**, including
   one claiming `instruction-sync` rebuilds symlinks it no longer touches.

4. **Four more files still asserted the dead design:** `memory-sync.mts`, `README.md`,
   `olya-pv.yaml`, `olya-memory-sync-cronjob.yaml`. The reviewer noted this is the same failure
   this plan diagnoses in #125 — a comment stating a policy the code contradicts — and that
   leaving five contradictory descriptions invites the next one. *Fixed:* all rewritten.
   `memory-sync.mts`'s stated reason for reading `/state/memory` was not merely stale but wrong:
   the real reason is that its pod has no bind mounts, so the workspace paths there are the stale
   checkout copies, and pointing it at them would commit the repo's contents over her live memory.

5. **The hook died with an unhandled ENOENT stack trace** instead of its curated message when a
   workspace path was absent entirely. *Fixed:* per-path try/catch mapping ENOENT, EROFS and
   EACCES to actionable messages.

The review separately confirmed, by tracing: no crashloop or data-loss path on normal, cold or
transition boots; the legacy-migration block is a correct no-op on the transition boot; no
dangling references to the removed exports; no false-failure scenario for the hook; and the
merge order is sufficient, with the sharpening that a violation is a bounded self-healing outage
(the container fails creation until `instruction-sync`'s next cycle materialises the mountpoints)
rather than a wedge.

Mechanism questions confirmed in the first review: a writable `subPath` nested under a read-only
mount of the
   same volume works, ordering comes from containerd's depth sort rather than YAML order, the
   hostPath backing is irrelevant, and a missing subPath source yields a root-owned directory
   that `fsGroup` will not fix. Also confirmed that phasing was unnecessary for the source-side
   hazard, which is why this ships as one change with an ordered merge.
