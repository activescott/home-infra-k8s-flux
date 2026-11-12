# Runs before every job on the buster-gate runner (ACTIONS_RUNNER_HOOK_JOB_STARTED); a
# non-zero exit fails the job before any of its steps run. Buster's key is on this runner,
# so only a push of a `v*` tag in ping-poet/dreamwright may use it, never a PR or a manual
# dispatch.
set -u

if [ "${GITHUB_REPOSITORY:-}" != "ping-poet/dreamwright" ] ||
  [ "${GITHUB_EVENT_NAME:-}" != "push" ] ||
  [[ "${GITHUB_REF:-}" != refs/tags/v* ]]; then
  echo "::error::buster-gate runs only on a push of a v* tag in ping-poet/dreamwright; got event '${GITHUB_EVENT_NAME:-}' on '${GITHUB_REF:-}' in '${GITHUB_REPOSITORY:-}'. Nothing ran. Start the gate by pushing the release tag, or change the job's runs-on."
  exit 1
fi
