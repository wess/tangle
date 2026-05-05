import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

export type RepoRow = {
  id: number
  owner_kind: string
  owner_id: number
  owner_login: string
  name: string
  description: string | null
  is_private: boolean
  default_branch: string
  is_archived: boolean
  deleted_at: string | null
}

export type RepoAccess = {
  /** read = the user can clone, browse files, read issues */
  read: boolean
  /** write = the user can push, open PRs against branches, edit issues */
  write: boolean
  /** admin = the user can change repo settings, delete the repo, add collaborators */
  admin: boolean
  /** Resolved role string for surfacing in the UI ("owner", "admin", "writer", "reader", "none"). */
  role: "owner" | "admin" | "writer" | "reader" | "none"
}

const NONE: RepoAccess = { read: false, write: false, admin: false, role: "none" }

const fromRole = (role: "owner" | "admin" | "writer" | "reader"): RepoAccess => {
  if (role === "owner") return { read: true, write: true, admin: true, role: "owner" }
  if (role === "admin") return { read: true, write: true, admin: true, role: "admin" }
  if (role === "writer") return { read: true, write: true, admin: false, role: "writer" }
  return { read: true, write: false, admin: false, role: "reader" }
}

// Resolve effective access for `userId` against `repo`. The rules:
//  - User-owned repo: the owner has full admin; everyone else falls
//    through to the collaborator table.
//  - Org-owned repo: org owners get admin; org members fall through to
//    the collaborator table; non-members fall through to public/private.
//  - Public repos grant `read` to everyone (including unauthenticated).
//  - Archived repos drop write/admin to read-only — pushes and edits
//    are refused even for the owner. Restoring requires un-archiving.
export const resolveRepoAccess = async (
  db: Connection,
  repo: RepoRow,
  userId: number | null,
): Promise<RepoAccess> => {
  const baseRead = !repo.is_private
  let access: RepoAccess = baseRead ? { ...NONE, read: true, role: "reader" } : NONE

  if (userId !== null) {
    if (repo.owner_kind === "user" && repo.owner_id === userId) {
      access = fromRole("owner")
    } else if (repo.owner_kind === "org") {
      const member = await db.one(
        from("org_members")
          .where(q => q("org_id").equals(repo.owner_id))
          .where(q => q("user_id").equals(userId))
          .select("role"),
      ) as { role: string } | null
      if (member?.role === "owner") {
        access = fromRole("admin")
      } else if (member) {
        // Plain org members get reader by default; explicit
        // collaborator rows can promote them below.
        access = fromRole("reader")
      }
    }

    // Explicit collaborator row only ever raises access — never lowers
    // it. So if the user is already an admin/owner, skip the lookup.
    if (!access.admin) {
      const collab = await db.one(
        from("repo_collaborators")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("user_id").equals(userId))
          .select("role"),
      ) as { role: string } | null
      if (collab) {
        const promoted = collab.role === "admin" ? fromRole("admin")
          : collab.role === "writer" ? fromRole("writer")
          : fromRole("reader")
        if (promoted.admin || (promoted.write && !access.write) || (promoted.read && !access.read)) {
          access = promoted
        }
      }
    }
  }

  if (repo.is_archived) {
    // Archived repos are read-only — explicit unarchive gates writes.
    return { read: access.read, write: false, admin: access.admin, role: access.role }
  }
  return access
}

export const findRepo = async (db: Connection, ownerLogin: string, name: string): Promise<RepoRow | null> =>
  await db.one(
    from("repos")
      .where(q => q("owner_login").equals(ownerLogin.toLowerCase()))
      .where(q => q("name").equals(name))
      .where(q => q("deleted_at").isNull())
      .select(
        "id", "owner_kind", "owner_id", "owner_login", "name", "description",
        "is_private", "default_branch", "is_archived", "deleted_at",
      ),
  ) as RepoRow | null
