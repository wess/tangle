const BASE = "/api"

export type AuthUser = { id: number; email: string; username: string; name: string; is_owner: boolean }

let token: string | null = localStorage.getItem("tangle_token")
let user: AuthUser | null = (() => {
  const raw = localStorage.getItem("tangle_user")
  return raw ? JSON.parse(raw) : null
})()

const headers = (extra: Record<string, string> = {}) => {
  const h: Record<string, string> = { ...extra }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

const jsonReq = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers({ "content-type": "application/json" }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  return res.json()
}

export const setToken = (t: string | null, u: AuthUser | null = null) => {
  token = t
  user = u
  if (t) localStorage.setItem("tangle_token", t)
  else localStorage.removeItem("tangle_token")
  if (u) localStorage.setItem("tangle_user", JSON.stringify(u))
  else localStorage.removeItem("tangle_user")
}

export const getToken = () => token
export const getUser = () => user

export const getSetupStatus = async () => {
  const res = await fetch(`${BASE}/setup`)
  return res.json() as Promise<{ needsSetup: boolean }>
}

export const signup = async (input: {
  name: string
  username: string
  email: string
  password: string
  inviteToken?: string
}) => {
  const data = await jsonReq("POST", "/signup", {
    name: input.name,
    username: input.username,
    email: input.email,
    password: input.password,
    invite_token: input.inviteToken,
  })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  return data
}

export const login = async (identity: string, password: string) => {
  const data = await jsonReq("POST", "/login", { identity, password })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  return data as {
    id?: number; email?: string; username?: string; name?: string; is_owner?: boolean
    token?: string
    mfa_required?: boolean; mfa_token?: string
    error?: string; retry_after?: number
  }
}

export const loginMfa = async (mfaToken: string, opts: { code?: string; backupCode?: string }) => {
  const data = await jsonReq("POST", "/login/mfa", {
    mfa_token: mfaToken,
    ...(opts.code ? { code: opts.code } : {}),
    ...(opts.backupCode ? { backup_code: opts.backupCode } : {}),
  })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  return data
}

export const logout = () => setToken(null, null)

export const getMe = () => jsonReq("GET", "/me")

export const updateMe = (patch: { name?: string; email?: string; username?: string; bio?: string; discoverable?: boolean }) =>
  jsonReq("PATCH", "/me", patch)

export const changePassword = (currentPassword: string, newPassword: string) =>
  jsonReq("POST", "/me/password", { current_password: currentPassword, new_password: newPassword })

export type Repo = {
  id: number
  owner_login: string
  name: string
  description: string | null
  is_private: boolean
  default_branch: string
  is_archived: boolean
  star_count: number
  size_bytes?: number
  pushed_at: string | null
  created_at: string
  viewer_role?: "owner" | "admin" | "writer" | "reader" | "none"
}

export const listMyRepos = () => jsonReq("GET", "/me/repos") as Promise<Repo[]>
export const listOwnerRepos = (owner: string) => jsonReq("GET", `/repos/${encodeURIComponent(owner)}`) as Promise<Repo[]>
export const getRepo = (owner: string, name: string) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`) as Promise<Repo>
export const createRepo = (input: {
  owner?: string; name: string; description?: string; isPrivate?: boolean; defaultBranch?: string
}) => jsonReq("POST", "/repos", input)
export const updateRepo = (owner: string, name: string, patch: Partial<Pick<Repo, "description" | "is_private" | "default_branch" | "is_archived">>) =>
  jsonReq("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, patch)
export const deleteRepo = (owner: string, name: string) =>
  jsonReq("DELETE", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)

export type Issue = {
  id: number
  number: number
  title: string
  body?: string | null
  state: "open" | "closed"
  user_id: number | null
  comment_count: number
  created_at: string
  updated_at: string
  closed_at?: string | null
}

export type Page<T> = { items: T[]; next_cursor: string | null }

export const listIssues = async (owner: string, name: string, state: "open" | "closed" | "all" = "open"): Promise<Issue[]> => {
  const res = await jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=${state}`) as Page<Issue>
  return res.items ?? []
}
export const getIssue = (owner: string, name: string, number: number) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`) as Promise<Issue>
export const createIssue = (owner: string, name: string, input: { title: string; body?: string }) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`, input)
export const updateIssue = (owner: string, name: string, number: number, patch: { title?: string; body?: string; state?: "open" | "closed" }) =>
  jsonReq("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`, patch)

export type Comment = {
  id: number
  user_id: number | null
  body: string
  edited_at: string | null
  created_at: string
}

export const listIssueComments = (owner: string, name: string, number: number) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`) as Promise<Comment[]>
export const postIssueComment = (owner: string, name: string, number: number, body: string) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`, { body })

export const starRepo = (owner: string, name: string) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/star`)
export const unstarRepo = (owner: string, name: string) =>
  jsonReq("DELETE", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/star`)

export type SshKey = {
  id: number
  title: string
  key_type: string
  fingerprint: string
  last_used_at: string | null
  created_at: string
}

export const listSshKeys = () => jsonReq("GET", "/me/ssh-keys") as Promise<SshKey[]>
export const addSshKey = (title: string, key: string) =>
  jsonReq("POST", "/me/ssh-keys", { title, key })
export const removeSshKey = (id: number) =>
  jsonReq("DELETE", `/me/ssh-keys/${id}`)

export type App = {
  id: number
  name: string
  description: string | null
  token_prefix: string
  scopes: string
  last_used_at: string | null
  created_at: string
  token?: string
}

export const listApps = () => jsonReq("GET", "/me/apps") as Promise<App[]>
export const createApp = (input: { name: string; description?: string; scopes?: string }) =>
  jsonReq("POST", "/me/apps", input) as Promise<App>
export const revokeApp = (id: number) =>
  jsonReq("DELETE", `/me/apps/${id}`)

export type Org = {
  id: number
  login: string
  name: string
  description: string | null
  avatar_key: string | null
  created_at: string
  role?: "owner" | "member"
}

export const listMyOrgs = () => jsonReq("GET", "/orgs") as Promise<Org[]>
export const createOrg = (input: { login: string; name?: string; description?: string }) =>
  jsonReq("POST", "/orgs", input) as Promise<Org>

// ─── Browse (tree, blob, refs, commits, README) ────────────────────

export type TreeEntry = {
  path: string
  oid: string
  type: "blob" | "tree" | "commit"
  mode: string
}

export type TreeResponse = {
  empty?: boolean
  ref: string
  kind?: "branch" | "tag" | "commit"
  commit?: string
  path: string
  entries: TreeEntry[]
}

export type BlobResponse = {
  ref: string
  commit: string
  path: string
  oid: string
  size: number
  is_binary: boolean
  text: string | null
}

export type CommitEntry = {
  oid: string
  parents: string[]
  message: string
  author: { name: string; email: string; timestamp: number; timezoneOffset: number }
  committer: { name: string; email: string; timestamp: number; timezoneOffset: number }
}

export type RefList = {
  branches: Array<{ name: string; oid: string; isDefault: boolean }>
  tags: Array<{ name: string; oid: string }>
  default: string
}

export const listRefs = (owner: string, name: string) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/refs`) as Promise<RefList>

export const getTree = (owner: string, name: string, ref: string, path = "") => {
  const sub = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""
  return jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree/${encodeURIComponent(ref)}${sub}`) as Promise<TreeResponse>
}

export const getBlob = (owner: string, name: string, ref: string, path: string) => {
  const sub = `/${path.split("/").map(encodeURIComponent).join("/")}`
  return jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/blob/${encodeURIComponent(ref)}${sub}`) as Promise<BlobResponse>
}

export const listCommits = (owner: string, name: string, ref?: string, page = 1) => {
  const qs = `?page=${page}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`
  return jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits${qs}`) as Promise<{
    ref: string
    commit?: string
    page: number
    page_size: number
    commits: CommitEntry[]
  }>
}

export const getReadme = (owner: string, name: string, ref?: string) => {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : ""
  return jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme${qs}`) as Promise<{
    ref: string
    path: string | null
    text: string | null
    html: string | null
  }>
}

// ─── Pulls (diff + merge + create) ─────────────────────────────────

export type Pull = {
  id: number
  number: number
  title: string
  body: string | null
  body_html?: string
  state: "open" | "closed" | "merged"
  user_id: number | null
  head_branch: string
  base_branch: string
  merged_at: string | null
  merge_commit_sha: string | null
  closed_at: string | null
  comment_count: number
  created_at: string
  updated_at: string
}

export const listPulls = async (owner: string, name: string, state: "open" | "closed" | "merged" | "all" = "open"): Promise<Pull[]> => {
  const res = await jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=${state}`) as Page<Pull>
  return res.items ?? []
}

export const getPull = (owner: string, name: string, number: number) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`) as Promise<Pull>

export const createPull = (owner: string, name: string, input: { title: string; body?: string; head: string; base?: string }) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, input) as Promise<Pull>

export const updatePull = (owner: string, name: string, number: number, patch: { title?: string; body?: string; state?: "open" | "closed" }) =>
  jsonReq("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, patch) as Promise<Pull>

export const getPullDiff = (owner: string, name: string, number: number) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/diff`) as Promise<{
    cross_repo?: boolean
    base_branch?: string
    head_branch?: string
    baseSha?: string
    headSha?: string
    files?: number
    additions?: number
    deletions?: number
    patch?: string
    error?: string
  }>

export const mergePull = (owner: string, name: string, number: number) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {}) as Promise<{
    merged?: boolean
    mode?: string
    sha?: string
    error?: string
    code?: string
  }>

export const listPullComments = (owner: string, name: string, number: number) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/comments`) as Promise<Comment[]>

export const postPullComment = (owner: string, name: string, number: number, body: string) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/comments`, { body })

// ─── Fork + mirror ─────────────────────────────────────────────────

export const forkRepo = (owner: string, name: string, input: { owner?: string; name?: string } = {}) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/fork`, input)

export const setMirror = (owner: string, name: string, url: string | null) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mirror`, { url })

// ─── Labels ────────────────────────────────────────────────────────

export type Label = {
  id: number
  name: string
  color: string
  description: string | null
}

export const listLabels = (owner: string, name: string) =>
  jsonReq("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`) as Promise<Label[]>

export const createLabel = (owner: string, name: string, input: { name: string; color?: string; description?: string }) =>
  jsonReq("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`, input) as Promise<Label>

export const deleteLabel = (owner: string, name: string, id: number) =>
  jsonReq("DELETE", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels/${id}`)

// ─── Avatar upload ─────────────────────────────────────────────────

export const uploadAvatar = async (file: File): Promise<{ avatar_key?: string; error?: string }> => {
  const form = new FormData()
  form.append("file", file)
  const res = await fetch(`${BASE}/me/avatar`, {
    method: "POST",
    headers: headers(),
    body: form,
  })
  return res.json()
}

export const avatarUrl = (userId: number | null | undefined): string | null =>
  userId ? `${BASE}/avatars/${userId}` : null
