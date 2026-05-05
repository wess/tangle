import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { cloneBareRepo, dropBareRepo, fetchMirror, initBareRepo } from "../git/repo.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const REPO_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/
const isValidRepoName = (s: string) => REPO_NAME_RE.test(s) && s !== "." && s !== ".."

type OwnerResolution =
  | { kind: "user"; id: number; login: string }
  | { kind: "org"; id: number; login: string }
  | { kind: "missing" }

const resolveOwner = async (db: Connection, login: string, userId: number): Promise<OwnerResolution> => {
  const lower = login.toLowerCase()
  // Self — the most common case for solo home labs.
  const self = await db.one(
    from("users").where(q => q("id").equals(userId)).select("id", "username"),
  ) as { id: number; username: string } | null
  if (self && self.username === lower) return { kind: "user", id: self.id, login: self.username }

  // Org the caller is a member of?
  const org = await db.one(
    from("orgs").where(q => q("login").equals(lower)).select("id", "login"),
  ) as { id: number; login: string } | null
  if (org) {
    const member = await db.one(
      from("org_members")
        .where(q => q("org_id").equals(org.id))
        .where(q => q("user_id").equals(userId))
        .select("role"),
    ) as { role: string } | null
    if (member) return { kind: "org", id: org.id, login: org.login }
  }
  return { kind: "missing" }
}

export const repoRoutes = (db: Connection, secret: string, repoDir: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    // List repos for the calling user — owned + org-accessible.
    get("/me/repos", guard(async (c) => {
      const userId = authId(c)
      const text = `
        SELECT r.id, r.owner_login, r.name, r.description, r.is_private,
               r.default_branch, r.is_archived, r.star_count, r.size_bytes,
               r.pushed_at, r.created_at
        FROM repos r
        WHERE r.deleted_at IS NULL AND (
          (r.owner_kind = 'user' AND r.owner_id = $1)
          OR (r.owner_kind = 'org' AND r.owner_id IN (
            SELECT org_id FROM org_members WHERE user_id = $1
          ))
          OR EXISTS (
            SELECT 1 FROM repo_collaborators c
            WHERE c.repo_id = r.id AND c.user_id = $1
          )
        )
        ORDER BY COALESCE(r.pushed_at, r.created_at) DESC
        LIMIT 200
      `
      const rows = await db.execute({ text, values: [userId] })
      return json(c, 200, rows)
    })),

    // Public listing for an owner — any user, any org. Private repos
    // hidden unless the caller has access.
    get("/repos/:owner", guard(async (c) => {
      const userId = authId(c)
      const owner = c.params.owner.toLowerCase()
      const text = `
        SELECT r.id, r.owner_login, r.name, r.description, r.is_private,
               r.default_branch, r.is_archived, r.star_count, r.pushed_at, r.created_at
        FROM repos r
        WHERE r.deleted_at IS NULL AND r.owner_login = $1
          AND (
            r.is_private = false
            OR (r.owner_kind = 'user' AND r.owner_id = $2)
            OR (r.owner_kind = 'org' AND r.owner_id IN (
              SELECT org_id FROM org_members WHERE user_id = $2
            ))
            OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = $2)
          )
        ORDER BY r.name ASC
      `
      const rows = await db.execute({ text, values: [owner, userId] })
      return json(c, 200, rows)
    })),

    post("/repos", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as {
        owner?: string
        name?: string
        description?: string
        is_private?: boolean
        isPrivate?: boolean
        default_branch?: string
        defaultBranch?: string
      }
      const ownerInput = body.owner?.trim()
      const name = body.name?.trim()
      const desc = body.description?.trim() || null
      const isPrivate = body.is_private ?? body.isPrivate ?? true
      const defaultBranch = (body.default_branch ?? body.defaultBranch ?? "main").trim() || "main"

      if (!name || !isValidRepoName(name)) {
        return apiError(c, "validation", "name must be 1-100 chars: letters, digits, dot, dash, underscore (no leading dots)")
      }

      // If `owner` is omitted, default to the caller's own namespace.
      let owner: OwnerResolution
      if (!ownerInput) {
        const self = await db.one(
          from("users").where(q => q("id").equals(userId)).select("id", "username"),
        ) as { id: number; username: string } | null
        if (!self) return apiError(c, "not_found", "User not found")
        owner = { kind: "user", id: self.id, login: self.username }
      } else {
        owner = await resolveOwner(db, ownerInput, userId)
        if (owner.kind === "missing") return apiError(c, "forbidden", "Cannot create repos under that owner")
      }

      const existing = await db.one(
        from("repos")
          .where(q => q("owner_login").equals(owner.login))
          .where(q => q("name").equals(name))
          .select("id", "deleted_at"),
      ) as { id: number; deleted_at: string | null } | null
      if (existing && !existing.deleted_at) {
        return apiError(c, "conflict", "A repo with that name already exists")
      }

      const inserted = await db.execute(
        from("repos").insert({
          owner_kind: owner.kind,
          owner_id: owner.id,
          owner_login: owner.login,
          name,
          description: desc,
          is_private: isPrivate,
          default_branch: defaultBranch,
        }).returning("id", "owner_login", "name", "description", "is_private", "default_branch", "created_at"),
      ) as Array<{ id: number; owner_login: string; name: string; description: string | null; is_private: boolean; default_branch: string; created_at: string }>
      const repo = inserted[0]!

      try {
        await initBareRepo(repoDir, owner.login, name, defaultBranch)
      } catch (err) {
        // Initialising the bare repo failed — roll back the DB row so
        // the user isn't stuck with a row that has no on-disk repo.
        await db.execute(from("repos").where(q => q("id").equals(repo.id)).del())
        return json(c, 500, { error: "Failed to initialize git repository", detail: String(err) })
      }

      logEvent(db, {
        userId,
        event: "repo.created",
        metadata: { repo_id: repo.id, owner: owner.login, name },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 201, repo)
    })),

    get("/repos/:owner/:name", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const meta = await db.one(
        from("repos")
          .where(q => q("id").equals(repo.id))
          .select(
            "id", "owner_login", "name", "description", "is_private",
            "default_branch", "is_archived", "star_count", "size_bytes",
            "pushed_at", "created_at",
          ),
      )
      return json(c, 200, { ...meta, viewer_role: access.role })
    })),

    patch("/repos/:owner/:name", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Admin access required")

      const body = c.body as {
        description?: string
        is_private?: boolean
        isPrivate?: boolean
        default_branch?: string
        defaultBranch?: string
        is_archived?: boolean
        isArchived?: boolean
      }
      const updates: Record<string, unknown> = {}
      if (body.description !== undefined) updates.description = body.description.trim() || null
      const isPrivate = body.is_private ?? body.isPrivate
      if (typeof isPrivate === "boolean") updates.is_private = isPrivate
      const defaultBranch = body.default_branch ?? body.defaultBranch
      if (typeof defaultBranch === "string" && defaultBranch.trim()) updates.default_branch = defaultBranch.trim()
      const isArchived = body.is_archived ?? body.isArchived
      if (typeof isArchived === "boolean") updates.is_archived = isArchived
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")

      await db.execute(from("repos").where(q => q("id").equals(repo.id)).update(updates))
      const fresh = await db.one(
        from("repos").where(q => q("id").equals(repo.id))
          .select("id", "owner_login", "name", "description", "is_private", "default_branch", "is_archived", "star_count", "size_bytes", "pushed_at", "created_at"),
      )
      return json(c, 200, fresh)
    })),

    del("/repos/:owner/:name", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Admin access required")

      // Soft-delete the row first so any inflight clones see "not found"
      // immediately, then drop the bare repo from disk. We accept that a
      // crash between these two steps leaves an orphan directory; a
      // periodic cleanup sweep can reconcile.
      await db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ deleted_at: raw("NOW()") }),
      )
      await dropBareRepo(repoDir, repo.owner_login, repo.name).catch((err) => {
        console.error(`[repos] failed to drop ${repo.owner_login}/${repo.name}.git:`, err)
      })

      logEvent(db, {
        userId,
        event: "repo.deleted",
        metadata: { repo_id: repo.id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { deleted: repo.id })
    })),

    // Fork — clones the source bare repo to a new owner's namespace
    // (default: the caller's own user) and inserts a row with
    // `fork_of` pointing back. Caller needs read access on the source.
    post("/repos/:owner/:name/fork", authed(async (c) => {
      const userId = authId(c)
      const source = await findRepo(db, c.params.owner, c.params.name)
      if (!source) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, source, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const body = c.body as { owner?: string; name?: string }
      const targetName = (body.name?.trim() || source.name)
      if (!isValidRepoName(targetName)) {
        return apiError(c, "validation", "name must be 1-100 chars: letters, digits, dot, dash, underscore (no leading dots)")
      }

      let target: OwnerResolution
      if (!body.owner) {
        const self = await db.one(
          from("users").where(q => q("id").equals(userId)).select("id", "username"),
        ) as { id: number; username: string } | null
        if (!self) return apiError(c, "not_found", "User not found")
        target = { kind: "user", id: self.id, login: self.username }
      } else {
        target = await resolveOwner(db, body.owner, userId)
        if (target.kind === "missing") return apiError(c, "forbidden", "Cannot fork into that owner's namespace")
      }

      // Forking into the same namespace as the source would shadow
      // the original. Refuse — GitHub does the same.
      if (target.kind === source.owner_kind && target.id === source.owner_id && targetName === source.name) {
        return apiError(c, "conflict", "Cannot fork a repo into its own owner")
      }

      const conflict = await db.one(
        from("repos")
          .where(q => q("owner_login").equals(target.login))
          .where(q => q("name").equals(targetName))
          .where(q => q("deleted_at").isNull())
          .select("id"),
      )
      if (conflict) return apiError(c, "conflict", "A repo with that name already exists in the target owner")

      const inserted = await db.execute(
        from("repos").insert({
          owner_kind: target.kind,
          owner_id: target.id,
          owner_login: target.login,
          name: targetName,
          description: source.description,
          is_private: source.is_private,
          default_branch: source.default_branch,
          fork_of: source.id,
        }).returning("id", "owner_login", "name", "description", "is_private", "default_branch", "created_at"),
      ) as Array<{ id: number; owner_login: string; name: string; description: string | null; is_private: boolean; default_branch: string; created_at: string }>
      const fork = inserted[0]!

      try {
        await cloneBareRepo(repoDir, source.owner_login, source.name, target.login, targetName)
      } catch (err) {
        // On-disk clone failed — undo the row so the user isn't left
        // with a phantom repo that has no objects to clone.
        await db.execute(from("repos").where(q => q("id").equals(fork.id)).del())
        return json(c, 500, { error: "Failed to clone source repository", detail: String(err) })
      }

      logEvent(db, {
        userId,
        event: "repo.forked",
        metadata: { source_repo_id: source.id, fork_repo_id: fork.id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 201, { ...fork, fork_of: source.id })
    })),

    // Mirror config — set or change the upstream URL the periodic sweep
    // pulls from. Sync is on a schedule (set up in server.ts); this
    // endpoint just records the URL and triggers an immediate sync.
    post("/repos/:owner/:name/mirror", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const body = c.body as { url?: string | null }
      const urlInput = body.url
      // Pass `url: null` (or empty string) to disable mirroring.
      if (urlInput === null || urlInput === undefined || urlInput === "") {
        await db.execute(
          from("repos").where(q => q("id").equals(repo.id)).update({
            mirror_url: null,
            mirror_last_synced_at: null,
            mirror_last_error: null,
          }),
        )
        return json(c, 200, { mirror_url: null })
      }
      const url = urlInput.trim()
      if (!/^https?:\/\//i.test(url) && !/^git@/.test(url)) {
        return apiError(c, "validation", "Mirror URL must be http(s) or git@ form")
      }
      await db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ mirror_url: url, mirror_last_error: null }),
      )

      // Kick off an immediate fetch in the background. Errors are
      // recorded on the row so the SPA can show a "last sync failed"
      // status without polling the deliveries table.
      void (async () => {
        try {
          await fetchMirror(repoDir, repo.owner_login, repo.name, url)
          await db.execute(
            from("repos").where(q => q("id").equals(repo.id)).update({
              mirror_last_synced_at: raw("NOW()"),
              mirror_last_error: null,
              pushed_at: raw("NOW()"),
            }),
          )
        } catch (err) {
          await db.execute(
            from("repos").where(q => q("id").equals(repo.id)).update({
              mirror_last_error: String(err).slice(0, 1000),
            }),
          ).catch(() => {})
        }
      })()

      return json(c, 200, { mirror_url: url, syncing: true })
    })),
  ]
}
