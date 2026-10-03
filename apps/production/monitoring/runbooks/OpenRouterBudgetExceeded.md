# OpenRouterBudgetExceeded

`OpenRouterBudgetExceeded` (rule group `openrouter`) fires on
`loki_process_custom_openrouter_budget_refused_total`, labelled by `namespace`, `pod` and
`app`. Two callers hold separate OpenRouter keys/workspaces and can each trip it
independently.

```logql
{namespace="<namespace>", app="<app>"} |~ "OpenRouter answered 403|provider=openrouter .* status=403"
```

with `<namespace>`/`<app>` from the firing alert's labels -- `job-accelerator-prod`/
`worker` or `olya`/`olya`.

Diagnosed case so far (activescott/home-infra-k8s-flux#220): this alert exists because
Olya's OpenClaw OpenRouter workspace hit its $50/month cap silently and calls just
started failing with "Workspace monthly budget of $X exceeded", with nothing surfacing it
until it was noticed by hand. Job Accelerator holds its own key at a $100/month cap in
`job-accelerator-prod`; either can exhaust independently of the other. There is no
in-cluster fix: raise the cap in the OpenRouter dashboard for the workspace/key named in
the alert, or wait for the monthly reset. Confirm with the query above before assuming
which app is affected -- the alert's own `namespace`/`app` labels say which, and the two
selectors match only the line each app's calling code writes on a 403 refusal, not a 403
from a different provider or a chat message quoting one.
