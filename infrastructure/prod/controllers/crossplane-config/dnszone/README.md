# The `DNSZone` API

Defines a custom Kubernetes resource, `DNSZone`, so a Cloudflare zone is described
by one file listing its records, instead of a separate ~25-line file per record.
Zones here run to dozens of records; writing each one out individually does not
scale and buries the actual DNS in boilerplate.

Records are consumed from `infrastructure/prod/dns/zones/`.

## The two files

| File | Purpose |
|---|---|
| `xrd.yaml` | The **schema**. A `CompositeResourceDefinition` — Crossplane turns it into the `dnszones.dns.activescott.com` CRD, which is what validates a zone file and makes `kubectl get dnszone` work. |
| `composition.yaml` | The **implementation**. Fans each entry in `spec.records` out into one `DNSRecord` managed resource, which the Cloudflare provider reconciles against the real API. |

## Why a composition function

A classic Composition has a static resource list and cannot iterate, so it would
need one entry per record — no better than writing the files by hand. Fan-out
requires `mode: Pipeline` with `function-go-templating`, whose Go `range` emits one
document per record.

Two functions are installed (see `../../crossplane-providers/functions.yaml`), both
upstream crossplane-contrib packages. Nothing here is code we author: the only
thing we write is the template, which is data inside `composition.yaml`.

`function-auto-ready` is not optional. It flips the `DNSZone`'s `Ready` condition
once the composed records are ready. Without it that condition never becomes true
and the `crossplane-dns` Kustomization's `wait: true` times out on every apply,
even when every record is fine.

## `key` is load-bearing — changing one recreates the record

Each record needs a stable, zone-unique `key`. It becomes the composed resource's
identity, so **editing a `key` deletes the old record and creates a new one**.
Change `content` to update a record in place; leave `key` alone.

It exists because every implicit alternative is unsafe:

- **List index** — inserting a record shifts every index below it, which Crossplane
  reads as those resources having been replaced, and acts on by deleting and
  recreating the real records.
- **`name` + `type`** — not unique. An apex commonly holds several TXT records
  (verification, SPF, DKIM), and a zone several MX records.
- **Hash of the content** — unique and stable, but then editing an SPF value
  changes the hash, turning a routine update into a delete-and-recreate. On mail
  records that is a live outage.

## Adopting records that already exist

Set `adopt:` on a record to its current Cloudflare record ID. It becomes
`crossplane.io/external-name`, so Crossplane takes over the existing record rather
than creating a duplicate alongside it. Drop the field once adopted — Crossplane
tracks the ID itself from then on.

## Changing the template

`kubectl kustomize` validates only that the YAML parses; it does not render the
template. To check what a zone actually produces before committing, use
`crossplane render` (requires the `crossplane` CLI and Docker, since it runs the
function containers locally):

```console
crossplane render \
  ../../../dns/zones/productpoet.com.yaml \
  composition.yaml \
  ../../crossplane-providers/functions.yaml
```

Worth doing for any template change that will reach a zone something depends on.
