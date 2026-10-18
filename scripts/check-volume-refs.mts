#!/usr/bin/env -S node --experimental-strip-types
// Fails when a volume's configMap.name or secret.secretName (including projected
// sources) resolves to no ConfigMap/Secret that the kustomize build actually emits.
// `kustomize build` emits such a volume without complaint, so a volume mounted on
// a ConfigMap/Secret the build never defines would otherwise pass silently.
//
// Usage:
//   kustomize build apps/production --enable-helm \
//     | yq -o=json ea '[.]' - \
//     | ./scripts/check-volume-refs.mts

import { readFileSync } from "node:fs"

interface ProjectedSource {
  secret?: { name?: string }
  configMap?: { name?: string }
}

interface Volume {
  name: string
  configMap?: { name?: string }
  secret?: { secretName?: string }
  projected?: { sources?: ProjectedSource[] }
}

interface PodSpec {
  volumes?: Volume[]
}

interface K8sResource {
  kind: string
  metadata?: { name?: string; namespace?: string }
  spec?: {
    template?: { spec?: PodSpec }
    jobTemplate?: { spec?: { template?: { spec?: PodSpec } } }
    volumes?: Volume[]
  }
}

// Secrets this repo creates outside kustomize/Flux, so `kustomize build` can never
// emit them. Each entry needs a comment naming the real owner, mirroring the DNSZone
// "Observe" pattern in AGENTS.md's "Declare what git does not own".
const OUT_OF_BAND_SECRETS = new Set<string>([
  // Issued by cert-manager's Certificate in apps/production/email-stalwart/stalwart-certificate.yaml.
  "stalwart-tls",
])

interface VolumeRef {
  type: "configMap" | "secret"
  name: string
  kind: string
  namespace: string
  resourceName: string
  volumeName: string
  projected: boolean
}

function podSpecOf(res: K8sResource): PodSpec | undefined {
  switch (res.kind) {
    case "Pod":
      return res.spec as PodSpec | undefined
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "Job":
      return res.spec?.template?.spec
    case "CronJob":
      return res.spec?.jobTemplate?.spec?.template?.spec
    default:
      return undefined
  }
}

function volumeRefsOf(res: K8sResource): VolumeRef[] {
  const refs: VolumeRef[] = []
  const namespace = res.metadata?.namespace ?? "default"
  const resourceName = res.metadata?.name ?? "(unnamed)"
  for (const vol of podSpecOf(res)?.volumes ?? []) {
    if (vol.configMap?.name) {
      refs.push({ type: "configMap", name: vol.configMap.name, kind: res.kind, namespace, resourceName, volumeName: vol.name, projected: false })
    }
    if (vol.secret?.secretName) {
      refs.push({ type: "secret", name: vol.secret.secretName, kind: res.kind, namespace, resourceName, volumeName: vol.name, projected: false })
    }
    for (const source of vol.projected?.sources ?? []) {
      if (source.configMap?.name) {
        refs.push({ type: "configMap", name: source.configMap.name, kind: res.kind, namespace, resourceName, volumeName: vol.name, projected: true })
      }
      if (source.secret?.name) {
        refs.push({ type: "secret", name: source.secret.name, kind: res.kind, namespace, resourceName, volumeName: vol.name, projected: true })
      }
    }
  }
  return refs
}

function findViolations(resources: K8sResource[]): VolumeRef[] {
  const configMapKeys = new Set<string>()
  const secretKeys = new Set<string>()
  for (const res of resources) {
    const namespace = res.metadata?.namespace ?? "default"
    if (res.kind === "ConfigMap" && res.metadata?.name) configMapKeys.add(`${namespace}/${res.metadata.name}`)
    if (res.kind === "Secret" && res.metadata?.name) secretKeys.add(`${namespace}/${res.metadata.name}`)
  }

  const violations: VolumeRef[] = []
  for (const res of resources) {
    for (const ref of volumeRefsOf(res)) {
      const key = `${ref.namespace}/${ref.name}`
      if (ref.type === "configMap" && configMapKeys.has(key)) continue
      if (ref.type === "secret" && (secretKeys.has(key) || OUT_OF_BAND_SECRETS.has(ref.name))) continue
      violations.push(ref)
    }
  }
  return violations
}

function main(): void {
  const raw = readFileSync(0, "utf-8")
  const resources: K8sResource[] = raw.trim() ? JSON.parse(raw) : []
  const violations = findViolations(resources)

  if (violations.length > 0) {
    console.error(`ERROR: ${violations.length} volume reference(s) resolve to no ConfigMap/Secret the build emits:`)
    for (const v of violations) {
      console.error(
        `  ✗ ${v.kind}/${v.namespace}/${v.resourceName} volume=${v.volumeName}${v.projected ? " (projected)" : ""} ${v.type}=${v.name}`,
      )
    }
    console.error(
      "If this name is created out-of-band (not by kustomize), add it to OUT_OF_BAND_SECRETS in this script with a comment naming the real owner.",
    )
    process.exit(1)
  }
  console.log("✓ Every volume configMap/secret reference (including projected sources) resolves to an object the build emits")
}

main()
