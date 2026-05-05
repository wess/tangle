import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop, makeKey, put } from "../storage/index.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const VALID_TAG_RE = /^[A-Za-z0-9._\/-]{1,80}$/

export const releaseRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/repos/:owner/:name/releases", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const rows = await db.all(
        from("releases")
          .where(q => q("repo_id").equals(repo.id))
          .select("id", "tag_name", "name", "body", "is_draft", "is_prerelease", "user_id", "published_at", "created_at")
          .orderBy("created_at", "DESC")
          .limit(100),
      )
      return json(c, 200, rows)
    })),

    post("/repos/:owner/:name/releases", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const body = c.body as {
        tag_name?: string; tagName?: string
        target_commitish?: string; targetCommitish?: string
        name?: string; body?: string
        is_draft?: boolean; isDraft?: boolean
        is_prerelease?: boolean; isPrerelease?: boolean
      }
      const tag = (body.tag_name ?? body.tagName)?.trim()
      const target = (body.target_commitish ?? body.targetCommitish)?.trim() || null
      const name = body.name?.trim() || null
      const isDraft = body.is_draft ?? body.isDraft ?? false
      const isPrerelease = body.is_prerelease ?? body.isPrerelease ?? false
      if (!tag) return apiError(c, "validation", "tag_name required")
      if (!VALID_TAG_RE.test(tag)) return apiError(c, "validation", "tag_name has invalid characters")

      const existing = await db.one(
        from("releases").where(q => q("repo_id").equals(repo.id)).where(q => q("tag_name").equals(tag)).select("id"),
      )
      if (existing) return apiError(c, "conflict", "A release with that tag already exists")

      const inserted = await db.execute(
        from("releases").insert({
          repo_id: repo.id,
          tag_name: tag,
          target_commitish: target,
          name,
          body: body.body?.trim() || null,
          is_draft: isDraft,
          is_prerelease: isPrerelease,
          user_id: userId,
          published_at: isDraft ? null : raw("NOW()"),
        }).returning("id", "tag_name", "name", "body", "is_draft", "is_prerelease", "user_id", "published_at", "created_at"),
      ) as Array<{ id: number; tag_name: string; name: string | null; is_draft: boolean }>
      const release = inserted[0]!
      // Drafts don't fire — that's the whole point of drafting. Only
      // published releases trigger webhooks.
      if (!release.is_draft) {
        dispatchWebhook(db, repo.id, "release", {
          event: "release",
          action: "published",
          repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
          release,
          sender: { id: userId },
        })
      }
      return json(c, 201, release)
    })),

    get("/repos/:owner/:name/releases/:id", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const id = Number(c.params.id)
      const release = await db.one(
        from("releases").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id))
          .select("id", "tag_name", "name", "body", "is_draft", "is_prerelease", "user_id", "published_at", "created_at"),
      )
      if (!release) return apiError(c, "not_found", "Release not found")
      const assets = await db.all(
        from("release_assets").where(q => q("release_id").equals(id))
          .select("id", "name", "mime", "size", "download_count", "created_at"),
      )
      return json(c, 200, { ...release, assets })
    })),

    patch("/repos/:owner/:name/releases/:id", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const id = Number(c.params.id)
      const release = await db.one(
        from("releases").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id", "is_draft", "published_at"),
      ) as { id: number; is_draft: boolean; published_at: string | null } | null
      if (!release) return apiError(c, "not_found", "Release not found")

      const body = c.body as { name?: string; body?: string; is_draft?: boolean; isDraft?: boolean; is_prerelease?: boolean; isPrerelease?: boolean }
      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name.trim() || null
      if (body.body !== undefined) updates.body = body.body.trim() || null
      const isDraft = body.is_draft ?? body.isDraft
      if (typeof isDraft === "boolean") {
        updates.is_draft = isDraft
        // Publishing a draft stamps published_at; unpublishing doesn't
        // erase it (draft+published_at is fine — it just means it was
        // published once).
        if (!isDraft && release.is_draft && !release.published_at) updates.published_at = raw("NOW()")
      }
      const isPrerelease = body.is_prerelease ?? body.isPrerelease
      if (typeof isPrerelease === "boolean") updates.is_prerelease = isPrerelease
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")

      await db.execute(from("releases").where(q => q("id").equals(release.id)).update(updates))
      const fresh = await db.one(
        from("releases").where(q => q("id").equals(release.id))
          .select("id", "tag_name", "name", "body", "is_draft", "is_prerelease", "user_id", "published_at", "created_at"),
      )
      return json(c, 200, fresh)
    })),

    del("/repos/:owner/:name/releases/:id", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")
      const id = Number(c.params.id)
      const release = await db.one(
        from("releases").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id"),
      ) as { id: number } | null
      if (!release) return apiError(c, "not_found", "Release not found")

      // Delete asset rows + storage objects in cascade order: rows first
      // so any in-flight downloads see "not found", then drop blobs.
      const assets = await db.all(
        from("release_assets").where(q => q("release_id").equals(id)).select("id", "storage_key"),
      ) as Array<{ id: number; storage_key: string }>
      await db.execute(from("release_assets").where(q => q("release_id").equals(id)).del())
      await db.execute(from("releases").where(q => q("id").equals(id)).del())
      await Promise.allSettled(assets.map(a => drop(store, a.storage_key)))
      return json(c, 200, { deleted: id })
    })),

    // Asset upload — multipart/form-data with a single `file` field.
    // We don't use parseMultipart middleware so we can stream straight
    // into storage rather than buffering the whole file twice.
    post("/repos/:owner/:name/releases/:id/assets", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const id = Number(c.params.id)
      const release = await db.one(
        from("releases").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id"),
      ) as { id: number } | null
      if (!release) return apiError(c, "not_found", "Release not found")

      const form = await c.request.formData().catch(() => null)
      if (!form) return apiError(c, "validation", "Expected multipart/form-data")
      const file = form.get("file")
      if (!(file instanceof Blob)) return apiError(c, "validation", "file field required")
      const filename = (file as File).name?.trim() || "asset"

      const key = makeKey(userId, filename)
      await put(store, key, file, file.type || "application/octet-stream")
      const inserted = await db.execute(
        from("release_assets").insert({
          release_id: id,
          name: filename,
          mime: file.type || "application/octet-stream",
          size: file.size,
          storage_key: key,
          uploaded_by: userId,
        }).returning("id", "name", "mime", "size", "download_count", "created_at"),
      ) as Array<unknown>
      return json(c, 201, inserted[0])
    })),
  ]
}
