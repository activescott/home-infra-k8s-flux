#!/usr/bin/env -S node --experimental-strip-types
// Detects the "shadowed mount" bug class: a StatefulSet/Deployment mounts a
// PVC/hostPath-backed volume at a PARENT of a well-known database image's
// real data directory instead of at that exact path. When the image's own
// Dockerfile declares VOLUME at the exact (unmounted) subpath, the container
// runtime silently backfills it with a throwaway anonymous volume that
// shadows the real persistent volume underneath — every container restart
// then wipes the database. See docs/specs/arize-phoenix/plan.md for the
// arize-phoenix incident that this check exists to catch earlier next time.
//
// Usage:
//   kubectl kustomize apps/production --enable-helm \
//     | yq -o=json '[select(.kind == "StatefulSet" or .kind == "Deployment")]' - \
//     | ./check-persistent-mounts.mts

import { readFileSync } from "node:fs"

interface EnvVar {
  name: string
  value?: string
}

interface VolumeMount {
  name: string
  mountPath: string
}

interface Container {
  name: string
  image?: string
  env?: EnvVar[]
  args?: string[]
  volumeMounts?: VolumeMount[]
}

interface Volume {
  name: string
  persistentVolumeClaim?: unknown
  hostPath?: unknown
}

interface K8sResource {
  kind: string
  metadata?: { name?: string; namespace?: string }
  spec?: {
    template?: { spec?: { containers?: Container[]; volumes?: Volume[] } }
    volumeClaimTemplates?: { metadata?: { name?: string } }[]
  }
}

interface KnownImageEntry {
  defaultPath: string
  override?: { type: "env" | "arg"; name: string }
}

const KNOWN_TABLE: Record<string, KnownImageEntry> = {
  postgres: { defaultPath: "/var/lib/postgresql/data", override: { type: "env", name: "PGDATA" } },
  mysql: { defaultPath: "/var/lib/mysql" },
  mariadb: { defaultPath: "/var/lib/mysql" },
  mongo: { defaultPath: "/data/db" },
  redis: { defaultPath: "/data" },
  rabbitmq: { defaultPath: "/var/lib/rabbitmq" },
  kvrocks: { defaultPath: "/var/lib/kvrocks", override: { type: "arg", name: "--dir" } },
}

function shortImageName(image: string): string {
  const lastSegment = image.split("/").pop() ?? image
  return lastSegment.split(":")[0]
}

function resolveExpectedPath(container: Container, entry: KnownImageEntry): string {
  if (!entry.override) return entry.defaultPath
  if (entry.override.type === "env") {
    const matches = (container.env ?? []).filter((e) => e.name === entry.override!.name)
    return matches[matches.length - 1]?.value ?? entry.defaultPath
  }
  const args = container.args ?? []
  const idx = args.lastIndexOf(entry.override.name)
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : entry.defaultPath
}

type ViolationReason =
  // The effective data dir IS the image's own fixed VOLUME path, and nothing
  // mounts that exact path — this is the arize-phoenix shape: the image's
  // Dockerfile auto-fills exactly this path with a throwaway anonymous
  // volume unless it is itself an exact mount target. A mount at an
  // ancestor directory does NOT suppress this.
  | "image-volume-path-unmounted"
  // The effective data dir was redirected away from the image's default
  // VOLUME path (e.g. via PGDATA/--dir), but isn't covered by any
  // persistent mount at all (not exact, not nested under one) — likely
  // writing to genuinely ephemeral storage, a different bug class but
  // still worth flagging.
  | "data-path-not-persisted"

interface Violation {
  kind: string
  namespace: string
  name: string
  container: string
  image: string
  expectedDataPath: string
  mountedPersistentPaths: string[]
  reason: ViolationReason
}

function findViolations(resources: K8sResource[]): Violation[] {
  const violations: Violation[] = []
  for (const res of resources) {
    if (res.kind !== "StatefulSet" && res.kind !== "Deployment") continue

    const persistentVolumeNames = new Set<string>()
    for (const vct of res.spec?.volumeClaimTemplates ?? []) {
      if (vct.metadata?.name) persistentVolumeNames.add(vct.metadata.name)
    }
    for (const vol of res.spec?.template?.spec?.volumes ?? []) {
      if (vol.persistentVolumeClaim || vol.hostPath) persistentVolumeNames.add(vol.name)
    }

    for (const container of res.spec?.template?.spec?.containers ?? []) {
      const persistentMounts = (container.volumeMounts ?? []).filter((m) => persistentVolumeNames.has(m.name))
      if (persistentMounts.length === 0) continue

      const entry = KNOWN_TABLE[shortImageName(container.image ?? "")]
      if (!entry) continue // unknown image: never block on it

      const imageVolumePath = entry.defaultPath
      const effectiveDataPath = resolveExpectedPath(container, entry)
      const mountedPaths = persistentMounts.map((m) => m.mountPath)

      const usingImageDefaultPath = effectiveDataPath === imageVolumePath
      const isSafe = usingImageDefaultPath
        ? mountedPaths.includes(imageVolumePath) // must be an EXACT mount — an ancestor mount does not suppress the image's anonymous volume
        : mountedPaths.includes(effectiveDataPath) ||
          mountedPaths.some((m) => effectiveDataPath.startsWith(m + "/")) // redirected elsewhere: exact or nested-under-a-persistent-mount is fine

      if (isSafe) continue

      violations.push({
        kind: res.kind,
        namespace: res.metadata?.namespace ?? "default",
        name: res.metadata?.name ?? "(unnamed)",
        container: container.name,
        image: container.image ?? "(no image)",
        expectedDataPath: effectiveDataPath,
        mountedPersistentPaths: mountedPaths,
        reason: usingImageDefaultPath ? "image-volume-path-unmounted" : "data-path-not-persisted",
      })
    }
  }
  return violations
}

function main(): void {
  const raw = readFileSync(0, "utf-8")
  const resources: K8sResource[] = raw.trim() ? JSON.parse(raw) : []
  const violations = findViolations(resources)

  if (violations.length > 0) {
    console.error(`ERROR: ${violations.length} workload(s) mount a known DB image's data path incorrectly:`)
    for (const v of violations) {
      console.error(`  ✗ ${v.kind}/${v.namespace}/${v.name} container=${v.container} image=${v.image}`)
      console.error(`      data directory: ${v.expectedDataPath}`)
      console.error(`      mounted persistent paths: ${JSON.stringify(v.mountedPersistentPaths)}`)
      console.error(`      reason: ${v.reason}`)
    }
    process.exit(1)
  }
  console.log("✓ No known-image persistent-mount-path mismatches found")
}

main()
