import { stat } from "node:fs/promises"
import { spawn } from "node:child_process"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { fetchMirror, resolveRepoPath } from "../git/repo.ts"

// Pull every mirror once per call. Each sync runs serially so we don't
// overwhelm a slow upstream or the local disk; consider a worker pool
// if home-lab installs ever start tracking dozens of mirrors.
export const sweepMirrors = async (db: Connection, repoDir: string): Promise<void> => {
  const rows = await db.all(
    from("repos")
      .where(q => q("mirror_url").isNotNull())
      .where(q => q("deleted_at").isNull())
      .select("id", "owner_login", "name", "mirror_url"),
  ) as Array<{ id: number; owner_login: string; name: string; mirror_url: string }>

  for (const r of rows) {
    try {
      await fetchMirror(repoDir, r.owner_login, r.name, r.mirror_url)
      await db.execute(
        from("repos").where(q => q("id").equals(r.id)).update({
          mirror_last_synced_at: raw("NOW()"),
          mirror_last_error: null,
          pushed_at: raw("NOW()"),
        }),
      )
    } catch (err) {
      await db.execute(
        from("repos").where(q => q("id").equals(r.id)).update({
          mirror_last_error: String(err).slice(0, 1000),
        }),
      ).catch(() => {})
    }
  }
}

const duDirSize = (path: string): Promise<number> =>
  new Promise((resolveP) => {
    const proc = spawn("du", ["-sk", path], { stdio: ["ignore", "pipe", "ignore"] })
    let stdout = ""
    proc.stdout.on("data", b => { stdout += b.toString() })
    proc.on("close", () => {
      const kb = Number(stdout.split(/\s+/)[0] ?? "0")
      resolveP(Number.isFinite(kb) ? kb * 1024 : 0)
    })
    proc.on("error", () => resolveP(0))
  })

// Update size_bytes on every non-deleted repo by `du -sk` on its bare
// repo directory. Cheap on every-hour cadence; the per-repo dirs are
// usually small so the IO overhead is fine even on a NAS spinner.
export const sweepRepoSizes = async (db: Connection, repoDir: string): Promise<void> => {
  const rows = await db.all(
    from("repos")
      .where(q => q("deleted_at").isNull())
      .select("id", "owner_login", "name"),
  ) as Array<{ id: number; owner_login: string; name: string }>

  for (const r of rows) {
    try {
      const path = resolveRepoPath(repoDir, r.owner_login, r.name)
      const exists = await stat(path).then(() => true).catch(() => false)
      if (!exists) continue
      const size = await duDirSize(path)
      await db.execute(
        from("repos").where(q => q("id").equals(r.id)).update({ size_bytes: size }),
      )
    } catch (err) {
      // Per-repo failures are silent — a single bad path shouldn't
      // halt the whole sweep.
      console.error(`[repos] size sweep failed for ${r.owner_login}/${r.name}:`, err)
    }
  }
}
