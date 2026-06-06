import { column, defineSchema } from "@atlas/db"

export const users = defineSchema("users", {
  id: column.serial().primaryKey(),
  email: column.text().unique(),
  username: column.text().unique(),
  name: column.text(),
  password: column.text(),
  bio: column.text().nullable(),
  avatar_key: column.text().nullable(),
  is_owner: column.boolean().default(false),
  discoverable: column.boolean().default(true),
  totp_secret: column.text().nullable(),
  totp_enabled: column.boolean().default(false),
  totp_backup_codes: column.text().nullable(),
  totp_enabled_at: column.timestamp().nullable(),
  deleted_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
})

export const sessions = defineSchema("sessions", {
  id: column.text().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  expires_at: column.timestamp(),
  revoked_at: column.timestamp().nullable(),
  last_used_at: column.timestamp(),
  created_at: column.timestamp(),
})

export const rateLimits = defineSchema("rate_limits", {
  bucket: column.text().primaryKey(),
  count: column.integer().default(0),
  window_started_at: column.timestamp(),
})

export const auditEvents = defineSchema("audit_events", {
  id: column.serial().primaryKey(),
  user_id: column.integer().nullable().ref("users", "id"),
  event: column.text(),
  metadata: column.text().nullable(),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: column.timestamp(),
})

export const invites = defineSchema("invites", {
  id: column.serial().primaryKey(),
  token_hash: column.text().unique(),
  email: column.text().nullable(),
  invited_by: column.integer().nullable().ref("users", "id"),
  used_at: column.timestamp().nullable(),
  used_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp(),
})

export const apps = defineSchema("apps", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  name: column.text(),
  description: column.text().nullable(),
  token_hash: column.text().unique(),
  token_prefix: column.text(),
  scopes: column.text().default("repo"),
  last_used_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
})

export const passwordResets = defineSchema("password_resets", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  token_hash: column.text().unique(),
  expires_at: column.timestamp(),
  used_at: column.timestamp().nullable(),
  ip: column.text().nullable(),
  created_at: column.timestamp(),
})

export const orgs = defineSchema("orgs", {
  id: column.serial().primaryKey(),
  login: column.text().unique(),
  name: column.text(),
  description: column.text().nullable(),
  avatar_key: column.text().nullable(),
  created_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp(),
})

export const orgMembers = defineSchema("org_members", {
  id: column.serial().primaryKey(),
  org_id: column.integer().ref("orgs", "id"),
  user_id: column.integer().ref("users", "id"),
  role: column.text().default("member"),
  created_at: column.timestamp(),
})

export const sshKeys = defineSchema("ssh_keys", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  title: column.text(),
  key_type: column.text(),
  public_key: column.text(),
  fingerprint: column.text().unique(),
  last_used_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
})

export const repos = defineSchema("repos", {
  id: column.serial().primaryKey(),
  owner_kind: column.text(),
  owner_id: column.integer(),
  owner_login: column.text(),
  name: column.text(),
  description: column.text().nullable(),
  is_private: column.boolean().default(true),
  default_branch: column.text().default("main"),
  is_archived: column.boolean().default(false),
  is_template: column.boolean().default(false),
  fork_of: column.integer().nullable().ref("repos", "id"),
  size_bytes: column.bigint().default(0n),
  star_count: column.integer().default(0),
  pushed_at: column.timestamp().nullable(),
  deleted_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
  mirror_url: column.text().nullable(),
  mirror_last_synced_at: column.timestamp().nullable(),
  mirror_last_error: column.text().nullable(),
})

export const repoCollaborators = defineSchema("repo_collaborators", {
  id: column.serial().primaryKey(),
  repo_id: column.integer().ref("repos", "id"),
  user_id: column.integer().nullable().ref("users", "id"),
  email: column.text().nullable(),
  role: column.text().default("reader"),
  invited_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp(),
  accepted_at: column.timestamp().nullable(),
})

export const issues = defineSchema("issues", {
  id: column.serial().primaryKey(),
  repo_id: column.integer().ref("repos", "id"),
  number: column.integer(),
  user_id: column.integer().nullable().ref("users", "id"),
  title: column.text(),
  body: column.text().nullable(),
  state: column.text().default("open"),
  closed_at: column.timestamp().nullable(),
  closed_by: column.integer().nullable().ref("users", "id"),
  comment_count: column.integer().default(0),
  created_at: column.timestamp(),
  updated_at: column.timestamp(),
})

export const pulls = defineSchema("pulls", {
  id: column.serial().primaryKey(),
  repo_id: column.integer().ref("repos", "id"),
  number: column.integer(),
  user_id: column.integer().nullable().ref("users", "id"),
  title: column.text(),
  body: column.text().nullable(),
  state: column.text().default("open"),
  head_repo_id: column.integer().nullable().ref("repos", "id"),
  head_branch: column.text(),
  base_branch: column.text(),
  merge_commit_sha: column.text().nullable(),
  merged_at: column.timestamp().nullable(),
  merged_by: column.integer().nullable().ref("users", "id"),
  closed_at: column.timestamp().nullable(),
  closed_by: column.integer().nullable().ref("users", "id"),
  comment_count: column.integer().default(0),
  created_at: column.timestamp(),
  updated_at: column.timestamp(),
})

export const comments = defineSchema("comments", {
  id: column.serial().primaryKey(),
  subject_kind: column.text(),
  subject_id: column.integer(),
  user_id: column.integer().nullable().ref("users", "id"),
  body: column.text(),
  edited_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
})

export const labels = defineSchema("labels", {
  id: column.serial().primaryKey(),
  repo_id: column.integer().ref("repos", "id"),
  name: column.text(),
  color: column.text().default("5E81AC"),
  description: column.text().nullable(),
  created_at: column.timestamp(),
})

export const labelAssignments = defineSchema("label_assignments", {
  id: column.serial().primaryKey(),
  label_id: column.integer().ref("labels", "id"),
  subject_kind: column.text(),
  subject_id: column.integer(),
  created_at: column.timestamp(),
})

export const stars = defineSchema("stars", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  repo_id: column.integer().ref("repos", "id"),
  created_at: column.timestamp(),
})

export const releases = defineSchema("releases", {
  id: column.serial().primaryKey(),
  repo_id: column.integer().ref("repos", "id"),
  tag_name: column.text(),
  target_commitish: column.text().nullable(),
  name: column.text().nullable(),
  body: column.text().nullable(),
  is_draft: column.boolean().default(false),
  is_prerelease: column.boolean().default(false),
  user_id: column.integer().nullable().ref("users", "id"),
  published_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
})

export const releaseAssets = defineSchema("release_assets", {
  id: column.serial().primaryKey(),
  release_id: column.integer().ref("releases", "id"),
  name: column.text(),
  mime: column.text(),
  size: column.bigint(),
  storage_key: column.text(),
  download_count: column.integer().default(0),
  uploaded_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp(),
})

export const webhooks = defineSchema("webhooks", {
  id: column.serial().primaryKey(),
  repo_id: column.integer().ref("repos", "id"),
  url: column.text(),
  secret: column.text().nullable(),
  content_type: column.text().default("application/json"),
  events: column.text().default('["push"]'),
  active: column.boolean().default(true),
  created_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp(),
})

export const webhookDeliveries = defineSchema("webhook_deliveries", {
  id: column.serial().primaryKey(),
  webhook_id: column.integer().ref("webhooks", "id"),
  event: column.text(),
  payload: column.text(),
  status_code: column.integer().nullable(),
  response_body: column.text().nullable(),
  duration_ms: column.integer().nullable(),
  delivered_at: column.timestamp(),
})

export const webauthnCredentials = defineSchema("webauthn_credentials", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  credential_id: column.text().unique(),
  public_key: column.text(),
  counter: column.bigint().default(0n),
  transports: column.text().default("[]"),
  name: column.text().nullable(),
  last_used_at: column.timestamp().nullable(),
  created_at: column.timestamp(),
})

export const webauthnChallenges = defineSchema("webauthn_challenges", {
  challenge: column.text().primaryKey(),
  user_id: column.integer().nullable().ref("users", "id"),
  kind: column.text(),
  expires_at: column.timestamp(),
  created_at: column.timestamp(),
})

export const instanceSettings = defineSchema("instance_settings", {
  key: column.text().primaryKey(),
  value: column.text(),
  updated_by: column.integer().nullable().ref("users", "id"),
  updated_at: column.timestamp(),
  created_at: column.timestamp(),
})
