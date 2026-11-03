# Nas

One file for the `nas` alert group (activescott/home-infra-private#36). These alerts watch
data protection on the nas host itself: the B2 offsite sync, replication from `thedatapool`
to `backupspool`, sanoid snapshots, and the textfiles that carry those signals.

The host's systemd timers write node-exporter textfiles to
`/var/lib/prometheus/node-exporter`. The cluster's node-exporter DaemonSet serves that
directory (`--collector.textfile.directory` in `prometheus/helmrelease.yaml`). The host code
that writes them, including the `nas1-run-job` wrapper, is `provision-debian.sh` in
home-infra-private.

None of these alerts had fired when this was written. Replace a section with what actually
happened the first time one does.

## Triage on the nas

Read the job's output in Loki first, once the journal is shipped there. Until then, on the
host:

```sh
systemctl list-timers 'nas1-*' sanoid.timer        # when each job last ran and runs next
systemctl status nas1-replicate.service            # or nas1-backup-b2.service
journalctl -u nas1-replicate.service -n 200        # job output, each line prefixed [replicate]
cat /var/lib/prometheus/node-exporter/job_replicate.prom
```

Triage reports what it found and stops. Re-running a backup or replication, destroying a
snapshot, or editing a dataset are host changes that go through the provisioner or Scott, not
through a triage turn.

Do not write the B2 bucket name, disk serials or WWNs in an issue, a commit, or this repo. The
repo is public.

The Grafana dashboard **nas** (uid `nas-overview`) shows every series these alerts use.

## NasJobFailed

A job run through `nas1-run-job` exited non-zero; `$value` is the exit code. The job's own
output is in the journal of its unit, each line prefixed `[<job>]`.

The alert stays firing until the job's next run succeeds, because the textfile keeps the last
exit code. For a weekly job that is up to a week, so resolve the cause and decide with Scott
whether to run the job early rather than waiting.

A forced test failure (for example `nas1-run-job backup-b2-test false`) leaves a
`job_backup-b2-test.prom` file behind that keeps this firing. Delete that file after the test.

## NasBackupB2Stale

The weekly rclone sync to Backblaze B2 (Monday 00:00 PT) has not succeeded in over 8 days, so
the offsite copy is at least one run behind. Check whether the timer ran at all
(`systemctl list-timers nas1-backup-b2.timer`) or ran and failed. A failure also fires
NasJobFailed. A timer that never ran, for example because the host was down at that moment
and `Persistent=true` has not caught up yet, fires only this one.

## NasReplicationStale

The daily syncoid replication (03:30 PT) to `backupspool/replication/*` has not succeeded in
over 26 hours. Look for syncoid errors in the unit's journal. The common causes are a full
`backupspool` (it was at 79 % on 2026-11-03) or a snapshot on the target that the source no
longer has, which breaks the incremental send.

## NasJobMetricsAbsent

Prometheus has no `nas1_job_last_run_timestamp_seconds{job="replicate"}` series, so the two
job alerts above are blind. Either the file `job_replicate.prom` is gone from the textfile
directory, or node-exporter is not serving the directory. Check
`node_textfile_mtime_seconds{node="nas"}` in Prometheus: if no files show up at all, the
node-exporter DaemonSet lost its `--collector.textfile.directory` argument or the pod is not
running. If other files show up, the job file is missing on the host.

Only `replicate` is covered for now. `backup-b2` is added once its first run on 2026-11-09 has
written `job_backup-b2.prom`.

## NasSnapshotStale

The newest snapshot of one of the seven protected `thedatapool` datasets is over 26 hours old.
sanoid runs from Debian's own `sanoid.timer` every 15 minutes and takes the daily snapshot.
Check `journalctl -u sanoid.service` and `zfs list -t snapshot -o name,creation -s creation
thedatapool/<dataset> | tail`.

The metric comes from Debian's `zfs-snapshots` collector. If that collector stops, the series
freezes and NasTextfileStale fires too; fix that one first.

## NasReplicaSnapshotStale

The newest snapshot of a replica under `backupspool/replication/` is over 36 hours old. A
healthy replica is normally 11.5 to 35.5 hours old, because the 03:30 PT replication copies the
snapshot sanoid took at 16:00 PT the day before. This usually comes with NasReplicationStale;
if it fires alone, replication is succeeding but not sending that dataset, so check syncoid's
output for it.

## NasTextfileStale

A textfile has stopped being rewritten: over 5 minutes for `zpool.prom` (rewritten every
minute), over 3 hours for the others. The `job_*.prom` files are excluded, since they change
only when their job runs. Find the timer that writes the named file and check its last run and
status. With no `file` label, node-exporter reports a read error on the directory, usually a
malformed `.prom` file or one with the wrong permissions.

A file left behind by a collector that is no longer enabled also fires this. Remove that file
through the provisioner, not by hand.
