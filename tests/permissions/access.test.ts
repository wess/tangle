import { describe, expect, test } from "bun:test"
import type { Connection } from "@atlas/db"
import { resolveRepoAccess, type RepoRow } from "../../src/permissions/index.ts"

// Minimal Connection stub. resolveRepoAccess only ever calls db.one with a
// chainable query; we route the canned response by inspecting the compiled
// SQL (FROM org_members vs FROM repo_collaborators).
const stubDb = (rows: {
  orgMember?: { role: string } | null
  collaborator?: { role: string } | null
}): Connection => ({
  one: async (query: { toSql: () => { text: string } }) => {
    const sql = query.toSql().text
    if (sql.includes("FROM org_members")) return rows.orgMember ?? null
    if (sql.includes("FROM repo_collaborators")) return rows.collaborator ?? null
    return null
  },
}) as unknown as Connection

const userRepo = (over: Partial<RepoRow> = {}): RepoRow => ({
  id: 1,
  owner_kind: "user",
  owner_id: 10,
  owner_login: "alice",
  name: "thing",
  description: null,
  is_private: true,
  default_branch: "main",
  is_archived: false,
  deleted_at: null,
  ...over,
})

describe("resolveRepoAccess", () => {
  test("private repo grants nothing to anonymous users", async () => {
    const access = await resolveRepoAccess(stubDb({}), userRepo(), null)
    expect(access).toEqual({ read: false, write: false, admin: false, role: "none" })
  })

  test("public repo grants read to anonymous users", async () => {
    const access = await resolveRepoAccess(stubDb({}), userRepo({ is_private: false }), null)
    expect(access.read).toBe(true)
    expect(access.write).toBe(false)
    expect(access.role).toBe("reader")
  })

  test("user repo owner gets full admin", async () => {
    const access = await resolveRepoAccess(stubDb({}), userRepo(), 10)
    expect(access).toEqual({ read: true, write: true, admin: true, role: "owner" })
  })

  test("non-owner with no collaborator row on private repo gets nothing", async () => {
    const access = await resolveRepoAccess(stubDb({}), userRepo(), 99)
    expect(access.read).toBe(false)
    expect(access.role).toBe("none")
  })

  test("collaborator writer role grants write but not admin", async () => {
    const db = stubDb({ collaborator: { role: "writer" } })
    const access = await resolveRepoAccess(db, userRepo(), 99)
    expect(access).toEqual({ read: true, write: true, admin: false, role: "writer" })
  })

  test("collaborator admin role grants admin", async () => {
    const db = stubDb({ collaborator: { role: "admin" } })
    const access = await resolveRepoAccess(db, userRepo(), 99)
    expect(access.admin).toBe(true)
    expect(access.role).toBe("admin")
  })

  test("org owner gets admin", async () => {
    const repo = userRepo({ owner_kind: "org", owner_id: 5 })
    const db = stubDb({ orgMember: { role: "owner" } })
    const access = await resolveRepoAccess(db, repo, 99)
    expect(access.admin).toBe(true)
    expect(access.role).toBe("admin")
  })

  test("plain org member falls through to reader", async () => {
    const repo = userRepo({ owner_kind: "org", owner_id: 5 })
    const db = stubDb({ orgMember: { role: "member" } })
    const access = await resolveRepoAccess(db, repo, 99)
    expect(access.role).toBe("reader")
    expect(access.read).toBe(true)
    expect(access.write).toBe(false)
  })

  test("org member promoted to writer via collaborator row", async () => {
    const repo = userRepo({ owner_kind: "org", owner_id: 5 })
    const db = stubDb({ orgMember: { role: "member" }, collaborator: { role: "writer" } })
    const access = await resolveRepoAccess(db, repo, 99)
    expect(access.write).toBe(true)
    expect(access.role).toBe("writer")
  })

  test("archived repo drops write even for the owner", async () => {
    const access = await resolveRepoAccess(stubDb({}), userRepo({ is_archived: true }), 10)
    expect(access.write).toBe(false)
    expect(access.read).toBe(true)
    expect(access.admin).toBe(true)
    expect(access.role).toBe("owner")
  })

  test("archived public repo stays readable for anonymous users", async () => {
    const repo = userRepo({ is_private: false, is_archived: true })
    const access = await resolveRepoAccess(stubDb({}), repo, null)
    expect(access.read).toBe(true)
    expect(access.write).toBe(false)
  })
})
