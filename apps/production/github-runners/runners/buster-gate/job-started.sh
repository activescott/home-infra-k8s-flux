# Runs before every job on the buster-gate runner (ACTIONS_RUNNER_HOOK_JOB_STARTED). Buster's
# key is on this runner, so only a push of a `v*` tag in ping-poet/dreamwright may use it,
# never a PR or a manual dispatch.
#
# Exiting non-zero is not enough: actions/runner marks the job failed and then still runs every
# step whose `if:` is `always()` or `failure()`, key and all. So a refused job kills its
# Runner.Worker (this script's parent) with SIGKILL. The listener then reports the job failed
# and no step runs. SIGTERM, or killing the listener instead, cancels the job, and a cancelled
# job still runs `always()` steps.
set -u

if [ "${GITHUB_REPOSITORY:-}" = "ping-poet/dreamwright" ] &&
  [ "${GITHUB_EVENT_NAME:-}" = "push" ] &&
  [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  exit 0
fi

echo "::error::buster-gate runs only on a push of a v* tag in ping-poet/dreamwright; got event '${GITHUB_EVENT_NAME:-}' on '${GITHUB_REF:-}' in '${GITHUB_REPOSITORY:-}'. The job was stopped before any step ran. Start the gate by pushing the release tag, or change the job's runs-on."

pid=$$
while [ "$pid" -gt 1 ]; do
  ppid=1
  while read -r key value; do
    if [ "$key" = "PPid:" ]; then ppid=$value; fi
  done <"/proc/$pid/status" || true
  pid=$ppid
  comm=
  read -r comm <"/proc/$pid/comm" || true
  if [ "$comm" = "Runner.Worker" ]; then
    kill -KILL "$pid" || break
    exit 1
  fi
done

# No Runner.Worker above this script: kill every process in the container this user can
# signal (all but PID 1 and this script), so no step can run.
kill -KILL -1
exit 1
