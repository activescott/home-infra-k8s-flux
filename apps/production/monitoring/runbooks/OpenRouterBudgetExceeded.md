# OpenRouterBudgetExceeded

`OpenRouterBudgetExceeded` (rule group `openrouter`) fires on
`loki_process_custom_openrouter_budget_refused_total`, labelled by `namespace`, `pod` and
`app`.

```logql
{namespace="<namespace>", app="<app>"} |~ "OpenRouter answered 403|provider=openrouter .* status=403"
```

with `<namespace>`/`<app>` from the firing alert's labels -- `job-accelerator-prod`/
`worker`.

Diagnosed case so far (activescott/home-infra-k8s-flux#220): this alert exists because
Job Accelerator's OpenRouter key hit its $100/month cap silently and calls just started
failing with "Workspace monthly budget of $X exceeded", with nothing surfacing it until
it was noticed by hand. There is no in-cluster fix: raise the cap in the OpenRouter
dashboard for the workspace/key named in the alert, or wait for the monthly reset.
Confirm with the query above before assuming the cause -- the selector matches only the
line the calling code writes on a 403 refusal, not a 403 from a different provider or a
chat message quoting one.
