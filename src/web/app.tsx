import { StrictMode, useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  BookOpen,
  ChevronRight,
  Compass,
  ExternalLink,
  File as FileIcon,
  Folder,
  GitBranch,
  GitFork,
  Github,
  HelpCircle,
  KeyRound,
  Menu,
  Moon,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Sun,
  Users,
} from "lucide-react"
import * as api from "./api.ts"

// Single-file SPA. Routing is hash-free, history-API based; we reflect
// app state into the URL with pushState and react to popstate. Stohr
// uses the same shape — keep this in one file by design.

type Path =
  | { kind: "auth"; mode: "login" | "signup" }
  | { kind: "dashboard" }
  | { kind: "explore" }
  | { kind: "newRepo" }
  | { kind: "settings"; section: "profile" | "ssh" | "tokens" }
  | { kind: "user"; login: string }
  | { kind: "repo"; owner: string; name: string; tab: "code" | "issues" | "pulls" | "settings"; sub?: string }

const parsePath = (): Path => {
  const path = window.location.pathname
  if (path === "/login") return { kind: "auth", mode: "login" }
  if (path === "/signup") return { kind: "auth", mode: "signup" }
  if (path === "/" || path === "/explore" || path === "/app") return { kind: "dashboard" }
  if (path === "/new") return { kind: "newRepo" }
  if (path === "/settings") return { kind: "settings", section: "profile" }
  const settingsMatch = path.match(/^\/settings\/(profile|ssh|tokens)$/)
  if (settingsMatch) return { kind: "settings", section: settingsMatch[1] as "profile" | "ssh" | "tokens" }
  const userMatch = path.match(/^\/u\/([^/]+)$/)
  if (userMatch) return { kind: "user", login: userMatch[1]! }
  const repoMatch = path.match(/^\/([^/]+)\/([^/]+)(?:\/(issues|pulls|settings|commits))?(?:\/(.+))?$/)
  if (repoMatch) {
    const raw = repoMatch[3]
    // `commits` is a Code-tab sub-view, not a top-level tab. Funnel it
    // through `tab=code` so the existing tab highlight stays right.
    const tab: "code" | "issues" | "pulls" | "settings" =
      raw === "commits" ? "code"
      : raw === "issues" || raw === "pulls" || raw === "settings" ? raw
      : "code"
    const sub = raw === "commits" ? "commits" : repoMatch[4]
    return { kind: "repo", owner: repoMatch[1]!, name: repoMatch[2]!, tab, sub }
  }
  return { kind: "dashboard" }
}

const navigate = (to: string) => {
  if (window.location.pathname + window.location.search === to) return
  window.history.pushState({}, "", to)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

const useRoute = (): Path => {
  const [path, setPath] = useState<Path>(parsePath())
  useEffect(() => {
    const onPop = () => setPath(parsePath())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  return path
}

const Link = ({ to, className, children, onClick }: { to: string; className?: string; children: React.ReactNode; onClick?: () => void }) => (
  <a
    href={to}
    className={className}
    onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      onClick?.()
      navigate(to)
    }}
  >
    {children}
  </a>
)

// Render server-sanitized HTML. The API returns body_html alongside
// body for issues, comments, PR descriptions, and READMEs — see
// src/markdown/index.ts. The HTML has already been allowlist-sanitized
// server-side, so dangerouslySetInnerHTML is safe here.
const Markdown = ({ html }: { html: string | null | undefined }) =>
  html
    ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    : <p className="muted">No description.</p>

const useTheme = (): [string, (next: string) => void] => {
  const [theme, setThemeState] = useState<string>(() => document.documentElement.getAttribute("data-theme") ?? "light")
  const setTheme = (next: string) => {
    document.documentElement.setAttribute("data-theme", next)
    try { localStorage.setItem("tangle_theme", next) } catch {}
    setThemeState(next)
  }
  return [theme, setTheme]
}

// Colour-distance utility for label badges — pick black or white text
// based on the perceived brightness of the (possibly user-supplied)
// hex colour. Mirrors GitHub's label colouring.
const labelTextColor = (hex: string): string => {
  const h = hex.length === 3 ? hex.split("").map(c => c + c).join("") : hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 140 ? "#1e1e1e" : "#ffffff"
}

// ─── Auth ──────────────────────────────────────────────────────────────

const AuthPage = ({ mode, onAuthed }: { mode: "login" | "signup"; onAuthed: (user: api.AuthUser) => void }) => {
  const [name, setName] = useState("")
  const [identity, setIdentity] = useState("")
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteToken, setInviteToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [ssoAvailable, setSsoAvailable] = useState(false)

  // Leave `needsSetup` as null on error so the form doesn't lie about
  // whether an invite is required when we genuinely couldn't reach the
  // API. The signup endpoint will reject if creds need an invite, and
  // the user can retry once the API is back up.
  useEffect(() => {
    api.getSetupStatus().then(s => setNeedsSetup(s.needsSetup)).catch(() => setNeedsSetup(null))
  }, [])

  // Probe the SSO status endpoint so we only show the Castle button when
  // the instance actually has OIDC wired up. Off by default on any error.
  useEffect(() => {
    api.ssoStatus().then(s => setSsoAvailable(s.available)).catch(() => setSsoAvailable(false))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mfaToken) {
        const res = await api.loginMfa(mfaToken, { code: mfaCode })
        if (res.error) { setError(res.error); return }
        onAuthed({ id: res.id, email: res.email, username: res.username, name: res.name, is_owner: !!res.is_owner })
        return
      }
      if (mode === "signup") {
        const res = await api.signup({ name, username, email, password, inviteToken: inviteToken || undefined })
        if (res.error) { setError(res.error); return }
        onAuthed({ id: res.id, email: res.email, username: res.username, name: res.name, is_owner: !!res.is_owner })
      } else {
        const res = await api.login(identity, password)
        if (res.error) { setError(res.error); return }
        if (res.mfa_required && res.mfa_token) { setMfaToken(res.mfa_token); return }
        onAuthed({ id: res.id!, email: res.email!, username: res.username!, name: res.name!, is_owner: !!res.is_owner })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <span className="wordmark">Tangle</span>
      <h2>{mfaToken ? "Two-factor code" : mode === "signup" ? "Create your account" : "Sign in"}</h2>
      {error && <div className="error">{error}</div>}
      {mode === "signup" && needsSetup === false && (
        <div className="ok">An invite token is required for new accounts.</div>
      )}
      {mode === "signup" && needsSetup === true && (
        <div className="ok">First signup creates the instance owner — no invite needed.</div>
      )}
      {!mfaToken && mode === "login" && ssoAvailable && (
        <>
          <button
            type="button"
            className="primary"
            onClick={() => { window.location.href = "/auth/sso/login" }}
          >
            🏰 Sign in with Castle
          </button>
          <div className="or-divider"><span>or</span></div>
        </>
      )}
      <form onSubmit={submit}>
        {mfaToken ? (
          <input value={mfaCode} onChange={e => setMfaCode(e.target.value)} placeholder="6-digit code" autoFocus inputMode="numeric" />
        ) : mode === "signup" ? (
          <>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Display name" autoFocus />
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username (lowercase, hyphens ok)" />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" type="email" />
            <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 8 chars)" type="password" />
            {needsSetup === false && (
              <input value={inviteToken} onChange={e => setInviteToken(e.target.value)} placeholder="Invite token" />
            )}
          </>
        ) : (
          <>
            <input value={identity} onChange={e => setIdentity(e.target.value)} placeholder="Username or email" autoFocus />
            <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" type="password" />
          </>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "..." : mfaToken ? "Verify" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>
      {!mfaToken && (
        <div className="toggle">
          <Link to={mode === "signup" ? "/login" : "/signup"}>
            {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </Link>
        </div>
      )}
    </div>
  )
}

// ─── Shell + nav ───────────────────────────────────────────────────────

const SIDEBAR_COLLAPSED_KEY = "tangle_sidebar_collapsed"

const initials = (name: string, username: string): string => {
  const first = name?.[0] ?? username?.[0] ?? "?"
  return first.toUpperCase()
}

const ThemeToggle = () => {
  const [theme, setTheme] = useTheme()
  const isDark = theme === "dark"
  return (
    <button
      className="theme-toggle"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
    </button>
  )
}

// Avatar showing the user's uploaded image when present, falling back
// to the initials gradient. The image URL is gated by an existence
// check via onError so a missing avatar quietly falls through.
const UserAvatar = ({ user, size }: { user: api.AuthUser; size?: "sm" }) => {
  const [failed, setFailed] = useState(false)
  const url = api.avatarUrl(user.id)
  const cls = size === "sm" ? "avatar-img sm" : "avatar-img"
  if (url && !failed) {
    return <img src={url} alt="" className={cls} onError={() => setFailed(true)} />
  }
  return <div className={size === "sm" ? "user-avatar" : "user-avatar"} style={size === "sm" ? { width: 22, height: 22, fontSize: 11 } : undefined}>{initials(user.name, user.username)}</div>
}

type ActiveTab = "repos" | "explore" | "new" | "stars" | "settings" | null

const activeTabFor = (route: Path): ActiveTab => {
  if (route.kind === "dashboard") return "repos"
  if (route.kind === "explore") return "explore"
  if (route.kind === "newRepo") return "new"
  if (route.kind === "settings") return "settings"
  return null
}

const Shell = ({ user, route, onLogout, children }: { user: api.AuthUser; route: Path; onLogout: () => void; children: React.ReactNode }) => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1" } catch { return false }
  })
  const [helpOpen, setHelpOpen] = useState(false)
  // Off-canvas sidebar drawer on phones. Shown via the hamburger in the
  // mobile top bar; the .open modifier and .scrim only matter inside the
  // max-width:640px media query — desktop ignores both.
  const [menuOpen, setMenuOpen] = useState(false)
  const helpRef = useRef<HTMLDivElement>(null)

  // Close the drawer whenever the route changes so tapping a nav item
  // doesn't leave it hanging open over the freshly-navigated page.
  useEffect(() => { setMenuOpen(false) }, [route])

  // Click-outside / Escape closes the help dropdown — same affordance
  // stohr uses, so the gesture transfers between apps in the suite.
  useEffect(() => {
    if (!helpOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!helpRef.current) return
      if (!helpRef.current.contains(e.target as Node)) setHelpOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setHelpOpen(false) }
    document.addEventListener("mousedown", onDocClick)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", onDocClick)
      document.removeEventListener("keydown", onEsc)
    }
  }, [helpOpen])

  const toggleCollapsed = () => {
    setCollapsed(v => {
      const next = !v
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0") } catch {}
      return next
    })
  }

  const tab = activeTabFor(route)
  const navItem = (key: ActiveTab, to: string, Icon: typeof GitBranch, label: string) => (
    <div
      className={`nav${tab === key ? " active" : ""}`}
      onClick={() => navigate(to)}
      title={label}
    >
      <Icon size={18} strokeWidth={1.75} /> <span className="nav-label">{label}</span>
    </div>
  )

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      <div className="mobile-topbar">
        <button
          type="button"
          className="hamburger"
          onClick={() => setMenuOpen(true)}
          title="Open menu"
          aria-label="Open menu"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>
        <span className="wordmark">Tangle</span>
      </div>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="sidebar-head">
          <div className="brand"><span className="wordmark">Tangle</span></div>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        </div>

        {navItem("repos", "/", GitBranch, "Repositories")}
        {navItem("explore", "/explore", Compass, "Explore")}
        {navItem("new", "/new", Plus, "New repository")}
        {navItem(null, "/u/" + user.username, Users, "Profile")}

        <div className="sidebar-section">Account</div>
        {navItem("settings", "/settings", SettingsIcon, "Settings")}

        <div className="help-wrap" ref={helpRef}>
          <div
            className={`nav${helpOpen ? " active" : ""}`}
            onClick={() => setHelpOpen(v => !v)}
            title="Help & resources"
            aria-haspopup="menu"
            aria-expanded={helpOpen}
          >
            <HelpCircle size={18} strokeWidth={1.75} /> <span className="nav-label">Help</span>
          </div>
          {helpOpen && (
            <div className="help-menu" role="menu">
              <a href="https://github.com/wess/tangle/tree/main/docs" target="_blank" rel="noreferrer" role="menuitem">
                <BookOpen size={14} strokeWidth={1.75} />
                <div className="help-menu-text">
                  <div className="help-menu-title">Documentation</div>
                  <div className="help-menu-sub">Architecture, API, deploy</div>
                </div>
                <ExternalLink size={12} strokeWidth={1.75} className="help-menu-ext" />
              </a>
              <a href="/settings/tokens" role="menuitem" onClick={(e) => { e.preventDefault(); setHelpOpen(false); navigate("/settings/tokens") }}>
                <KeyRound size={14} strokeWidth={1.75} />
                <div className="help-menu-text">
                  <div className="help-menu-title">Personal access tokens</div>
                  <div className="help-menu-sub">Authenticate <code>git</code> over HTTPS</div>
                </div>
              </a>
              <a href="https://github.com/wess/tangle" target="_blank" rel="noreferrer" role="menuitem">
                <Github size={14} strokeWidth={1.75} />
                <div className="help-menu-text">
                  <div className="help-menu-title">GitHub</div>
                  <div className="help-menu-sub">Source, issues, releases</div>
                </div>
                <ExternalLink size={12} strokeWidth={1.75} className="help-menu-ext" />
              </a>
            </div>
          )}
        </div>

        <div className="user-footer">
          <UserAvatar user={user} />
          <div className="user-meta">
            <div className="who">{user.name}</div>
            <div className="who muted">@{user.username}</div>
            <div className="logout" onClick={onLogout}>Sign out</div>
          </div>
          <ThemeToggle />
        </div>
      </aside>
      <main className="main">
        <div className="content">{children}</div>
      </main>
    </div>
  )
}

// ─── Dashboard ─────────────────────────────────────────────────────────

const Dashboard = () => {
  const [repos, setRepos] = useState<api.Repo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.listMyRepos().then(setRepos).catch(e => setError(String(e)))
  }, [])
  if (error) return <div className="error-banner">{error}</div>
  if (!repos) return <div className="empty">Loading…</div>
  return (
    <>
      <div className="row split">
        <div>
          <h1>Your repositories</h1>
          <p className="lead">Repos you own, collaborate on, or have access to via an org.</p>
        </div>
        <Link to="/new"><button className="primary">New repo</button></Link>
      </div>
      {repos.length === 0
        ? <div className="empty">
            <h3>No repos yet</h3>
            <p>Spin up your first one — solo or under an org.</p>
            <Link to="/new"><button className="primary">Create a repo</button></Link>
          </div>
        : <div className="repo-list">
            {repos.map(r => <RepoCard key={r.id} repo={r} />)}
          </div>}
    </>
  )
}

const RepoCard = ({ repo }: { repo: api.Repo }) => (
  <div className="repo-card">
    <div className="title">
      <Link to={`/${repo.owner_login}/${repo.name}`}>{repo.owner_login}/{repo.name}</Link>
      {repo.is_private && <span className="badge private">Private</span>}
      {repo.is_archived && <span className="badge archived">Archived</span>}
    </div>
    {repo.description && <p className="desc">{repo.description}</p>}
    <div className="meta">
      <span className="pill">{repo.default_branch}</span>
      <span className="pill">★ {repo.star_count}</span>
      {repo.pushed_at && <span className="pill">pushed {new Date(repo.pushed_at).toLocaleDateString()}</span>}
    </div>
  </div>
)

// ─── New repo ──────────────────────────────────────────────────────────

const NewRepo = ({ user }: { user: api.AuthUser }) => {
  const [orgs, setOrgs] = useState<api.Org[]>([])
  const [owner, setOwner] = useState(user.username)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [isPrivate, setIsPrivate] = useState(true)
  const [defaultBranch, setDefaultBranch] = useState("main")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.listMyOrgs().then(setOrgs).catch(() => setOrgs([]))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      const res = await api.createRepo({ owner, name, description: description || undefined, isPrivate, defaultBranch })
      if (res.error) { setError(res.error); return }
      navigate(`/${owner}/${name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return (
    <>
      <h1>New repository</h1>
      <p className="lead">A repo is a bare git repository plus issues, pulls, and releases.</p>
      <div className="card">
        {error && <div className="error-banner">{error}</div>}
        <form className="form" onSubmit={submit}>
          <label>
            Owner
            <select value={owner} onChange={e => setOwner(e.target.value)}>
              <option value={user.username}>{user.username} (you)</option>
              {orgs.map(o => <option key={o.id} value={o.login}>{o.login}</option>)}
            </select>
          </label>
          <label>
            Name
            <input value={name} onChange={e => setName(e.target.value)} placeholder="my-awesome-thing" />
            <span className="hint">Letters, digits, dot, dash, underscore. No leading dots.</span>
          </label>
          <label>
            Description <span className="hint">(optional)</span>
            <input value={description} onChange={e => setDescription(e.target.value)} />
          </label>
          <label>
            Default branch
            <input value={defaultBranch} onChange={e => setDefaultBranch(e.target.value)} />
          </label>
          <label className="row">
            <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} style={{ width: "auto" }} />
            Private — only collaborators can read or write
          </label>
          <div className="actions">
            <button className="primary" disabled={busy} type="submit">{busy ? "Creating…" : "Create repo"}</button>
            <Link to="/"><button type="button">Cancel</button></Link>
          </div>
        </form>
      </div>
    </>
  )
}

// ─── Repo view ─────────────────────────────────────────────────────────

const RepoView = ({ owner, name, tab, sub, user }: { owner: string; name: string; tab: "code" | "issues" | "pulls" | "settings"; sub?: string; user: api.AuthUser }) => {
  const [repo, setRepo] = useState<api.Repo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api.getRepo(owner, name).then(r => {
      if ((r as any).error) { setError((r as any).error); setRepo(null); return }
      setRepo(r); setError(null)
    }).catch(e => setError(String(e)))
  }, [owner, name])
  useEffect(reload, [reload])

  if (error) return <div className="error-banner">{error}</div>
  if (!repo) return <div className="empty">Loading…</div>
  return (
    <>
      <RepoHeader repo={repo} onChange={reload} />
      <div className="tabs">
        <Link to={`/${owner}/${name}`} className={tab === "code" ? "active" : ""}>Code</Link>
        <Link to={`/${owner}/${name}/issues`} className={tab === "issues" ? "active" : ""}>Issues</Link>
        <Link to={`/${owner}/${name}/pulls`} className={tab === "pulls" ? "active" : ""}>Pulls</Link>
        {repo.viewer_role === "owner" || repo.viewer_role === "admin"
          ? <Link to={`/${owner}/${name}/settings`} className={tab === "settings" ? "active" : ""}>Settings</Link>
          : null}
      </div>
      {tab === "code" && <RepoCode repo={repo} sub={sub} />}
      {tab === "issues" && <RepoIssues repo={repo} sub={sub} user={user} />}
      {tab === "pulls" && <RepoPulls repo={repo} sub={sub} user={user} />}
      {tab === "settings" && <RepoSettings repo={repo} onChange={reload} />}
    </>
  )
}

const RepoHeader = ({ repo, onChange }: { repo: api.Repo; onChange: () => void }) => {
  const [busy, setBusy] = useState(false)
  const star = async () => {
    setBusy(true)
    await api.starRepo(repo.owner_login, repo.name).catch(() => {})
    setBusy(false)
    onChange()
  }
  return (
    <div className="row split" style={{ gap: 16 }}>
      <div>
        <h1>
          <Link to={`/u/${repo.owner_login}`}>{repo.owner_login}</Link>
          <span style={{ color: "var(--muted)" }}> / </span>
          {repo.name}
          {repo.is_private && <span className="badge private" style={{ marginLeft: 12 }}>Private</span>}
          {repo.is_archived && <span className="badge archived" style={{ marginLeft: 8 }}>Archived</span>}
        </h1>
        {repo.description && <p className="lead">{repo.description}</p>}
      </div>
      <div className="row">
        <button onClick={star} disabled={busy}>★ {repo.star_count}</button>
        <button onClick={async () => {
          const r = await api.forkRepo(repo.owner_login, repo.name).catch((e) => ({ error: String(e) }))
          if ((r as any).error) { window.alert((r as any).error); return }
          navigate(`/${(r as any).owner_login}/${(r as any).name}`)
        }}><GitFork size={14} strokeWidth={1.75} /> Fork</button>
      </div>
    </div>
  )
}

const RepoCode = ({ repo, sub }: { repo: api.Repo; sub?: string }) => {
  // The URL shape `?path=` keeps us inside a single Code page rather
  // than minting a brand new route per directory. The SPA reads
  // window.location.search directly so back/forward Just Works.
  const url = `${window.location.origin}/${repo.owner_login}/${repo.name}.git`
  const params = new URLSearchParams(window.location.search)
  const path = params.get("path") ?? ""
  const ref = params.get("ref") ?? repo.default_branch
  const view = params.get("view") ?? "tree"

  const q = params.get("q") ?? ""

  if (view === "search" && q) return <RepoSearch repo={repo} ref_={ref} query={q} />
  if (view === "blob" && path) return <RepoBlob repo={repo} ref_={ref} path={path} />
  if (sub === "commits") return <RepoCommits repo={repo} ref_={ref} />
  return <RepoTree repo={repo} ref_={ref} path={path} cloneUrl={url} />
}

const navigateRepoSearch = (repo: api.Repo, ref: string, query: string) => {
  const qs = new URLSearchParams()
  if (ref !== repo.default_branch) qs.set("ref", ref)
  qs.set("view", "search")
  qs.set("q", query)
  navigate(`/${repo.owner_login}/${repo.name}?${qs.toString()}`)
}

// A compact search box matching the file-tree header styling. Submitting
// navigates to `?view=search&q=…` so the result page is bookmarkable and
// back/forward works, exactly like the tree/blob views.
const RepoSearchBox = ({ repo, ref_, initial }: { repo: api.Repo; ref_: string; initial: string }) => {
  const [q, setQ] = useState(initial)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = q.trim()
    if (trimmed) navigateRepoSearch(repo, ref_, trimmed)
  }
  return (
    <form className="repo-search" onSubmit={submit} style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={`Search code in ${repo.name}…`}
        aria-label="Search code"
        style={{ flex: 1 }}
      />
      <button className="primary" type="submit">Search</button>
    </form>
  )
}

const RepoSearch = ({ repo, ref_, query }: { repo: api.Repo; ref_: string; query: string }) => {
  const [result, setResult] = useState<api.SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setResult(null); setError(null)
    const controller = new AbortController()
    api.searchCode(repo.owner_login, repo.name, query, ref_, controller.signal)
      .then(r => {
        if ((r as any).error) { setError((r as any).error); return }
        setResult(r)
      })
      .catch(e => { if (!controller.signal.aborted) setError(String(e)) })
    return () => controller.abort()
  }, [repo.owner_login, repo.name, ref_, query])

  return (
    <>
      <RepoSearchBox repo={repo} ref_={ref_} initial={query} />
      {error && <div className="error-banner">{error}</div>}
      {!result && !error && <div className="empty">Searching…</div>}
      {result && result.files.length === 0 && (
        <div className="empty"><p>No matches for “{query}”.</p></div>
      )}
      {result && result.files.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 14 }}>
            {result.total_lines} match{result.total_lines === 1 ? "" : "es"} in {result.total_files} file{result.total_files === 1 ? "" : "s"}
            {result.truncated ? " (results truncated)" : ""}
          </p>
          {result.files.map(f => (
            <div className="file-tree" key={f.file} style={{ marginTop: 10 }}>
              <div className="file-tree-head">
                <FileIcon size={14} strokeWidth={1.75} />
                <span
                  style={{ cursor: "pointer" }}
                  onClick={() => navigateRepoPath(repo, ref_, f.file, "blob")}
                >
                  {f.file}
                </span>
              </div>
              <pre className="code" style={{ margin: 0, borderRadius: 0 }}>
                {f.hits.map(h => `${h.line}: ${h.text}`).join("\n")}
              </pre>
            </div>
          ))}
        </>
      )}
    </>
  )
}

const navigateRepoPath = (repo: api.Repo, ref: string, path: string, view: "tree" | "blob") => {
  const qs = new URLSearchParams()
  if (ref !== repo.default_branch) qs.set("ref", ref)
  if (path) qs.set("path", path)
  if (view !== "tree") qs.set("view", view)
  const tail = qs.toString()
  navigate(`/${repo.owner_login}/${repo.name}${tail ? `?${tail}` : ""}`)
}

const RepoTree = ({ repo, ref_, path, cloneUrl }: { repo: api.Repo; ref_: string; path: string; cloneUrl: string }) => {
  const [tree, setTree] = useState<api.TreeResponse | null>(null)
  const [readme, setReadme] = useState<{ html: string | null; path: string | null; text: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setTree(null); setError(null)
    api.getTree(repo.owner_login, repo.name, ref_, path)
      .then(t => setTree(t))
      .catch(e => setError(String(e)))
    if (!path) {
      api.getReadme(repo.owner_login, repo.name, ref_).then(r => setReadme({ html: r.html, path: r.path, text: r.text })).catch(() => {})
    } else {
      setReadme(null)
    }
  }, [repo.owner_login, repo.name, ref_, path])

  const segments = path ? path.split("/").filter(Boolean) : []
  const goTo = (sub: string) => navigateRepoPath(repo, ref_, sub, "tree")

  return (
    <>
      <div className="card">
        <h3>Clone</h3>
        <p className="muted">Use a personal access token as the password for HTTP. Generate one in <Link to="/settings/tokens">Settings → Tokens</Link>.</p>
        <pre className="code">{`git clone ${cloneUrl}`}</pre>
      </div>

      <RepoSearchBox repo={repo} ref_={ref_} initial="" />

      {error && <div className="error-banner">{error}</div>}
      {tree?.empty
        ? <div className="card">
            <h3>This repo has no commits yet</h3>
            <p className="muted">Push your first commit:</p>
            <pre className="code">{[
              `git clone ${cloneUrl}`,
              `cd ${repo.name}`,
              `echo "# ${repo.name}" > README.md`,
              `git add README.md`,
              `git commit -m "first commit"`,
              `git push -u origin ${repo.default_branch}`,
            ].join("\n")}</pre>
          </div>
        : tree && (
          <div className="file-tree" style={{ marginTop: 14 }}>
            <div className="file-tree-head">
              <GitBranch size={14} strokeWidth={1.75} />
              <span>{tree.ref}</span>
              <span style={{ color: "var(--border-strong)" }}>·</span>
              <span style={{ cursor: "pointer" }} onClick={() => goTo("")}>{repo.name}</span>
              {segments.map((seg, i) => (
                <span key={i}>
                  <ChevronRight size={12} strokeWidth={1.75} style={{ verticalAlign: "middle", margin: "0 4px" }} />
                  <span style={{ cursor: "pointer" }} onClick={() => goTo(segments.slice(0, i + 1).join("/"))}>{seg}</span>
                </span>
              ))}
              <span className="spacer" />
              <Link to={`/${repo.owner_login}/${repo.name}/commits${ref_ === repo.default_branch ? "" : `?ref=${encodeURIComponent(ref_)}`}`}>
                Commits
              </Link>
            </div>
            {path && (
              <div className="file-tree-row folder" onClick={() => goTo(segments.slice(0, -1).join("/"))}>
                <Folder size={16} strokeWidth={1.75} />
                <span>..</span>
              </div>
            )}
            {tree.entries.map(e => (
              <div
                key={e.oid + e.path}
                className={`file-tree-row ${e.type === "tree" ? "folder" : ""}`}
                onClick={() => navigateRepoPath(repo, ref_, [...segments, e.path].join("/"), e.type === "tree" ? "tree" : "blob")}
              >
                {e.type === "tree" ? <Folder size={16} strokeWidth={1.75} /> : <FileIcon size={16} strokeWidth={1.75} />}
                <span>{e.path}</span>
              </div>
            ))}
            {tree.entries.length === 0 && <div className="empty"><p>Empty directory.</p></div>}
          </div>
        )}

      {readme && readme.html && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>{readme.path}</h3>
          <Markdown html={readme.html} />
        </div>
      )}
      {readme && !readme.html && readme.text && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>{readme.path}</h3>
          <pre className="code">{readme.text}</pre>
        </div>
      )}
    </>
  )
}

const RepoBlob = ({ repo, ref_, path }: { repo: api.Repo; ref_: string; path: string }) => {
  const [blob, setBlob] = useState<api.BlobResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBlob(null); setError(null)
    api.getBlob(repo.owner_login, repo.name, ref_, path).then(setBlob).catch(e => setError(String(e)))
  }, [repo.owner_login, repo.name, ref_, path])

  const goUp = () => {
    const parent = path.split("/").slice(0, -1).join("/")
    navigateRepoPath(repo, ref_, parent, "tree")
  }

  if (error) return <div className="error-banner">{error}</div>
  if (!blob) return <div className="empty">Loading…</div>
  return (
    <div className="blob-view">
      <div className="blob-head">
        <span style={{ cursor: "pointer", color: "var(--brand)" }} onClick={goUp}>← back</span>
        <span style={{ color: "var(--border-strong)" }}>·</span>
        <span>{path}</span>
        <span className="size">{blob.size.toLocaleString()} bytes{blob.is_binary ? " · binary" : ""}</span>
      </div>
      {blob.is_binary
        ? <div className="empty"><p>Binary file — open via clone to inspect.</p></div>
        : <pre className="blob-body">{blob.text ?? ""}</pre>}
    </div>
  )
}

const RepoCommits = ({ repo, ref_ }: { repo: api.Repo; ref_: string }) => {
  const [commits, setCommits] = useState<api.CommitEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.listCommits(repo.owner_login, repo.name, ref_).then(r => setCommits(r.commits)).catch(e => setError(String(e)))
  }, [repo.owner_login, repo.name, ref_])
  if (error) return <div className="error-banner">{error}</div>
  if (!commits) return <div className="empty">Loading…</div>
  if (commits.length === 0) return <div className="empty"><h3>No commits yet</h3></div>
  return (
    <div className="card" style={{ padding: 0 }}>
      {commits.map(c => (
        <div key={c.oid} className="issue-row">
          <span className="num mono">{c.oid.slice(0, 7)}</span>
          <div>
            <div className="title">{c.message.split("\n")[0]}</div>
            <div className="meta">
              {c.author.name} · {new Date(c.author.timestamp * 1000).toLocaleString()}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

const RepoIssues = ({ repo, sub, user }: { repo: api.Repo; sub?: string; user: api.AuthUser }) => {
  if (sub === "new") return <NewIssue repo={repo} />
  const issueNum = sub ? Number(sub) : null
  if (issueNum && Number.isFinite(issueNum)) return <IssueView repo={repo} number={issueNum} user={user} />

  const [state, setState] = useState<"open" | "closed">("open")
  const [issues, setIssues] = useState<api.Issue[] | null>(null)
  useEffect(() => {
    api.listIssues(repo.owner_login, repo.name, state).then(setIssues).catch(() => setIssues([]))
  }, [repo.owner_login, repo.name, state])
  return (
    <>
      <div className="row split">
        <div className="row">
          <button className={state === "open" ? "primary" : "ghost"} onClick={() => setState("open")}>Open</button>
          <button className={state === "closed" ? "primary" : "ghost"} onClick={() => setState("closed")}>Closed</button>
        </div>
        <Link to={`/${repo.owner_login}/${repo.name}/issues/new`}><button className="primary">New issue</button></Link>
      </div>
      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        {!issues
          ? <div className="empty">Loading…</div>
          : issues.length === 0
            ? <div className="empty"><h3>No {state} issues</h3></div>
            : issues.map(i => (
              <Link key={i.id} to={`/${repo.owner_login}/${repo.name}/issues/${i.number}`}>
                <div className="issue-row">
                  <span className="num">#{i.number}</span>
                  <div>
                    <div className="title">{i.title}</div>
                    <div className="meta">
                      <span className={`badge ${i.state === "open" ? "open" : "closed"}`}>{i.state}</span>
                      {" "}opened {new Date(i.created_at).toLocaleDateString()} · {i.comment_count} comments
                    </div>
                  </div>
                </div>
              </Link>
            ))}
      </div>
    </>
  )
}

const NewIssue = ({ repo }: { repo: api.Repo }) => {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    const res = await api.createIssue(repo.owner_login, repo.name, { title, body })
    setBusy(false)
    if (res.error) setError(res.error)
    else navigate(`/${repo.owner_login}/${repo.name}/issues/${res.number}`)
  }
  return (
    <div className="card">
      {error && <div className="error-banner">{error}</div>}
      <form className="form" onSubmit={submit}>
        <label>Title<input value={title} onChange={e => setTitle(e.target.value)} autoFocus /></label>
        <label>Description (optional)<textarea value={body} onChange={e => setBody(e.target.value)} /></label>
        <div className="actions">
          <button className="primary" disabled={busy} type="submit">{busy ? "..." : "Open issue"}</button>
          <Link to={`/${repo.owner_login}/${repo.name}/issues`}><button type="button">Cancel</button></Link>
        </div>
      </form>
    </div>
  )
}

const IssueView = ({ repo, number, user }: { repo: api.Repo; number: number; user: api.AuthUser }) => {
  const [issue, setIssue] = useState<api.Issue | null>(null)
  const [comments, setComments] = useState<api.Comment[]>([])
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api.getIssue(repo.owner_login, repo.name, number).then(setIssue).catch(e => setError(String(e)))
    api.listIssueComments(repo.owner_login, repo.name, number).then(setComments).catch(() => setComments([]))
  }, [repo.owner_login, repo.name, number])
  useEffect(reload, [reload])

  if (!issue) return <div className="empty">Loading…</div>
  const post = async () => {
    if (!draft.trim()) return
    await api.postIssueComment(repo.owner_login, repo.name, number, draft)
    setDraft("")
    reload()
  }
  const toggle = async () => {
    await api.updateIssue(repo.owner_login, repo.name, number, {
      state: issue.state === "open" ? "closed" : "open",
    })
    reload()
  }

  return (
    <>
      <h1>{issue.title} <span style={{ color: "var(--muted)", fontWeight: 400 }}>#{issue.number}</span></h1>
      <div className="row">
        <span className={`badge ${issue.state === "open" ? "open" : "closed"}`}>{issue.state}</span>
        <span className="muted">opened {new Date(issue.created_at).toLocaleString()}</span>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="comment">
          <div className="head">Issue body</div>
          <Markdown html={(issue as any).body_html} />
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <h2>Comments ({comments.length})</h2>
      {comments.map(c => (
        <div key={c.id} className="comment">
          <div className="head">user #{c.user_id ?? "—"} · {new Date(c.created_at).toLocaleString()}</div>
          <Markdown html={(c as any).body_html} />
        </div>
      ))}
      <h2>Reply</h2>
      <div className="card">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Write a comment…" />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={post} disabled={!draft.trim()}>Comment</button>
          <button onClick={toggle}>{issue.state === "open" ? "Close issue" : "Reopen issue"}</button>
          <span className="spacer" />
          <span className="muted">signed in as {user.username}</span>
        </div>
      </div>
    </>
  )
}

const RepoPulls = ({ repo, sub, user }: { repo: api.Repo; sub?: string; user: api.AuthUser }) => {
  if (sub === "new") return <NewPull repo={repo} />
  const num = sub ? Number(sub) : null
  if (num && Number.isFinite(num)) return <PullView repo={repo} number={num} user={user} />

  const [state, setState] = useState<"open" | "closed" | "merged">("open")
  const [pulls, setPulls] = useState<api.Pull[] | null>(null)
  useEffect(() => {
    api.listPulls(repo.owner_login, repo.name, state).then(setPulls).catch(() => setPulls([]))
  }, [repo.owner_login, repo.name, state])

  return (
    <>
      <div className="row split">
        <div className="row">
          <button className={state === "open" ? "primary" : "ghost"} onClick={() => setState("open")}>Open</button>
          <button className={state === "merged" ? "primary" : "ghost"} onClick={() => setState("merged")}>Merged</button>
          <button className={state === "closed" ? "primary" : "ghost"} onClick={() => setState("closed")}>Closed</button>
        </div>
        <Link to={`/${repo.owner_login}/${repo.name}/pulls/new`}><button className="primary">New pull request</button></Link>
      </div>
      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        {!pulls
          ? <div className="empty">Loading…</div>
          : pulls.length === 0
            ? <div className="empty"><h3>No {state} pull requests</h3></div>
            : pulls.map(p => (
              <Link key={p.id} to={`/${repo.owner_login}/${repo.name}/pulls/${p.number}`}>
                <div className="issue-row">
                  <span className="num">#{p.number}</span>
                  <div>
                    <div className="title">{p.title}</div>
                    <div className="meta">
                      <span className={`badge ${p.merged_at ? "" : p.state === "open" ? "open" : "closed"}`}>
                        {p.merged_at ? "merged" : p.state}
                      </span>
                      {" "}{p.head_branch} → {p.base_branch} · {new Date(p.created_at).toLocaleDateString()} · {p.comment_count} comments
                    </div>
                  </div>
                </div>
              </Link>
            ))}
      </div>
    </>
  )
}

const NewPull = ({ repo }: { repo: api.Repo }) => {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [head, setHead] = useState("")
  const [base, setBase] = useState(repo.default_branch)
  const [refs, setRefs] = useState<api.RefList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.listRefs(repo.owner_login, repo.name).then(r => {
      setRefs(r)
      // Pre-select a head branch that is NOT the default — saves the
      // user one click when the obvious case (a feature branch) is the
      // only non-default ref.
      const candidate = r.branches.find(b => b.name !== r.default)
      if (candidate) setHead(candidate.name)
    }).catch(() => {})
  }, [repo.owner_login, repo.name])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    const res = await api.createPull(repo.owner_login, repo.name, { title, body: body || undefined, head, base })
    setBusy(false)
    if ((res as any).error) setError((res as any).error)
    else navigate(`/${repo.owner_login}/${repo.name}/pulls/${(res as any).number}`)
  }
  return (
    <div className="card">
      {error && <div className="error-banner">{error}</div>}
      {!refs ? <div className="empty">Loading branches…</div> : (
        <form className="form" onSubmit={submit}>
          <label>Compare<div className="row compare-row">
            <select value={head} onChange={e => setHead(e.target.value)} style={{ flex: 1 }}>
              {refs.branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
            <span className="muted" style={{ padding: "0 8px" }}>→</span>
            <select value={base} onChange={e => setBase(e.target.value)} style={{ flex: 1 }}>
              {refs.branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div></label>
          <label>Title<input value={title} onChange={e => setTitle(e.target.value)} autoFocus /></label>
          <label>Description (markdown supported)<textarea value={body} onChange={e => setBody(e.target.value)} /></label>
          <div className="actions">
            <button className="primary" disabled={busy} type="submit">{busy ? "..." : "Open pull request"}</button>
            <Link to={`/${repo.owner_login}/${repo.name}/pulls`}><button type="button">Cancel</button></Link>
          </div>
        </form>
      )}
    </div>
  )
}

const PullView = ({ repo, number, user }: { repo: api.Repo; number: number; user: api.AuthUser }) => {
  const [pull, setPull] = useState<api.Pull | null>(null)
  const [comments, setComments] = useState<api.Comment[]>([])
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.getPullDiff>> | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const reload = useCallback(() => {
    api.getPull(repo.owner_login, repo.name, number).then(setPull).catch(e => setError(String(e)))
    api.listPullComments(repo.owner_login, repo.name, number).then(setComments).catch(() => setComments([]))
    api.getPullDiff(repo.owner_login, repo.name, number).then(setDiff).catch(() => {})
  }, [repo.owner_login, repo.name, number])
  useEffect(() => { reload() }, [reload])

  if (!pull) return <div className="empty">Loading…</div>
  const post = async () => {
    if (!draft.trim()) return
    await api.postPullComment(repo.owner_login, repo.name, number, draft)
    setDraft("")
    reload()
  }
  const merge = async () => {
    if (!window.confirm("Fast-forward merge this pull request?")) return
    setMerging(true)
    const res = await api.mergePull(repo.owner_login, repo.name, number)
    setMerging(false)
    if (res.error) {
      window.alert(res.error)
      return
    }
    reload()
  }
  const toggle = async () => {
    await api.updatePull(repo.owner_login, repo.name, number, {
      state: pull.state === "open" ? "closed" : "open",
    })
    reload()
  }
  const stateLabel = pull.merged_at ? "merged" : pull.state
  return (
    <>
      <h1>{pull.title} <span style={{ color: "var(--muted)", fontWeight: 400 }}>#{pull.number}</span></h1>
      <div className="row">
        <span className={`badge ${pull.merged_at ? "" : pull.state === "open" ? "open" : "closed"}`}>{stateLabel}</span>
        <span className="muted">{pull.head_branch} → {pull.base_branch} · opened {new Date(pull.created_at).toLocaleString()}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginTop: 16 }}>
        <Markdown html={pull.body_html} />
      </div>

      {diff && diff.cross_repo && (
        <div className="card" style={{ marginTop: 14 }}>
          <p className="muted">Cross-repo diff isn't supported yet — clone both repos to inspect locally.</p>
        </div>
      )}
      {diff && !diff.cross_repo && diff.patch !== undefined && (
        <>
          <h2>Diff</h2>
          <div className="diff-stat">
            <span>{diff.files} file{diff.files === 1 ? "" : "s"}</span>
            <span className="add">+{diff.additions}</span>
            <span className="del">-{diff.deletions}</span>
          </div>
          <pre className="diff-body">{diff.patch.split("\n").map((line, i) => {
            const cls = line.startsWith("+++") || line.startsWith("---") ? "file"
              : line.startsWith("@@") ? "hunk"
              : line.startsWith("+") ? "add-line"
              : line.startsWith("-") ? "del-line"
              : ""
            return <span key={i} className={cls}>{line}{"\n"}</span>
          })}</pre>
        </>
      )}

      <h2>Comments ({comments.length})</h2>
      {comments.map(c => (
        <div key={c.id} className="comment">
          <div className="head">user #{c.user_id ?? "—"} · {new Date(c.created_at).toLocaleString()}</div>
          <Markdown html={(c as any).body_html} />
        </div>
      ))}
      <h2>Reply</h2>
      <div className="card">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Write a comment…" />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={post} disabled={!draft.trim()}>Comment</button>
          {pull.state === "open" && !pull.merged_at && (
            <button className="primary" onClick={merge} disabled={merging}>{merging ? "Merging…" : "Merge (fast-forward)"}</button>
          )}
          <button onClick={toggle}>{pull.state === "open" ? "Close" : "Reopen"}</button>
          <span className="spacer" />
          <span className="muted">signed in as {user.username}</span>
        </div>
      </div>
    </>
  )
}

const RepoSettings = ({ repo, onChange }: { repo: api.Repo; onChange: () => void }) => {
  const [description, setDescription] = useState(repo.description ?? "")
  const [isPrivate, setIsPrivate] = useState(repo.is_private)
  const [defaultBranch, setDefaultBranch] = useState(repo.default_branch)
  const [isArchived, setIsArchived] = useState(repo.is_archived)
  const [error, setError] = useState<string | null>(null)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const res = await api.updateRepo(repo.owner_login, repo.name, {
      description: description || undefined,
      is_private: isPrivate,
      default_branch: defaultBranch,
      is_archived: isArchived,
    })
    if (res.error) setError(res.error)
    else onChange()
  }
  const remove = async () => {
    if (!window.confirm(`Permanently delete ${repo.owner_login}/${repo.name}? This cannot be undone.`)) return
    await api.deleteRepo(repo.owner_login, repo.name)
    navigate("/")
  }
  return (
    <>
      <div className="card">
        <h3>General</h3>
        {error && <div className="error-banner">{error}</div>}
        <form className="form" onSubmit={save}>
          <label>Description<input value={description} onChange={e => setDescription(e.target.value)} /></label>
          <label>Default branch<input value={defaultBranch} onChange={e => setDefaultBranch(e.target.value)} /></label>
          <label className="row"><input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} style={{ width: "auto" }} /> Private</label>
          <label className="row"><input type="checkbox" checked={isArchived} onChange={e => setIsArchived(e.target.checked)} style={{ width: "auto" }} /> Archive (read-only)</label>
          <div className="actions"><button className="primary" type="submit">Save</button></div>
        </form>
      </div>
      <div className="card">
        <h3 style={{ color: "var(--danger)" }}>Danger zone</h3>
        <p className="muted">Deleting a repo removes the database row and the bare repo on disk. It cannot be undone.</p>
        <button className="danger" onClick={remove}>Delete this repository</button>
      </div>
    </>
  )
}

// ─── Settings ──────────────────────────────────────────────────────────

const Settings = ({ section, user, onUserChange }: { section: "profile" | "ssh" | "tokens"; user: api.AuthUser; onUserChange: (u: api.AuthUser) => void }) => (
  <>
    <h1>Settings</h1>
    <div className="settings">
      <nav>
        <Link to="/settings/profile" className={section === "profile" ? "active" : ""}>Profile</Link>
        <Link to="/settings/ssh" className={section === "ssh" ? "active" : ""}>SSH keys</Link>
        <Link to="/settings/tokens" className={section === "tokens" ? "active" : ""}>Personal access tokens</Link>
      </nav>
      <div>
        {section === "profile" && <ProfileSettings user={user} onUserChange={onUserChange} />}
        {section === "ssh" && <SshKeySettings />}
        {section === "tokens" && <TokenSettings />}
      </div>
    </div>
  </>
)

const ProfileSettings = ({ user, onUserChange }: { user: api.AuthUser; onUserChange: (u: api.AuthUser) => void }) => {
  const [name, setName] = useState(user.name)
  const [bio, setBio] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  useEffect(() => { api.getMe().then(m => { setBio(m.bio ?? "") }).catch(() => {}) }, [])
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setOk(false); setError(null)
    const res = await api.updateMe({ name, bio })
    if (res.error) setError(res.error)
    else { onUserChange({ ...user, name }); setOk(true) }
  }
  const onAvatarPick = async (file: File) => {
    setOk(false); setError(null)
    const res = await api.uploadAvatar(file)
    if (res.error) setError(res.error)
    else setOk(true)
  }
  return (
    <>
      <div className="card">
        <h3>Avatar</h3>
        <div className="row">
          <UserAvatar user={user} />
          <input
            type="file"
            accept="image/*"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) void onAvatarPick(f)
            }}
            style={{ width: "auto" }}
          />
        </div>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>Max 4 MB. PNG / JPEG / WebP.</p>
      </div>
      <div className="card">
        <h3>Profile</h3>
        {ok && <div className="ok-banner">Saved.</div>}
        {error && <div className="error-banner">{error}</div>}
        <form className="form" onSubmit={save}>
          <label>Display name<input value={name} onChange={e => setName(e.target.value)} /></label>
          <label>Bio<textarea value={bio} onChange={e => setBio(e.target.value)} /></label>
          <div className="actions"><button className="primary" type="submit">Save</button></div>
        </form>
      </div>
    </>
  )
}

const SshKeySettings = () => {
  const [keys, setKeys] = useState<api.SshKey[]>([])
  const [title, setTitle] = useState("")
  const [keyText, setKeyText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => { void api.listSshKeys().then(setKeys).catch(() => setKeys([])) }, [])
  useEffect(reload, [reload])
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null)
    const res = await api.addSshKey(title, keyText)
    if ((res as any).error) setError((res as any).error)
    else { setTitle(""); setKeyText(""); reload() }
  }
  return (
    <>
      <div className="card">
        <h3>Add a key</h3>
        {error && <div className="error-banner">{error}</div>}
        <form className="form" onSubmit={add}>
          <label>Title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="laptop" /></label>
          <label>Public key<textarea value={keyText} onChange={e => setKeyText(e.target.value)} placeholder="ssh-ed25519 AAAA…" /></label>
          <div className="actions"><button className="primary" type="submit">Add</button></div>
        </form>
      </div>
      <div className="card">
        <h3>Your keys</h3>
        {keys.length === 0
          ? <p className="muted">No keys yet.</p>
          : <div className="table-scroll"><table className="list">
            <thead><tr><th>Title</th><th>Type</th><th>Fingerprint</th><th></th></tr></thead>
            <tbody>{keys.map(k => (
              <tr key={k.id}>
                <td>{k.title}</td>
                <td>{k.key_type}</td>
                <td className="mono" style={{ fontSize: 12 }}>{k.fingerprint}</td>
                <td><button className="danger" onClick={async () => { await api.removeSshKey(k.id); reload() }}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table></div>}
      </div>
    </>
  )
}

const TokenSettings = () => {
  const [apps, setApps] = useState<api.App[]>([])
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState("repo")
  const [issued, setIssued] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => { void api.listApps().then(setApps).catch(() => setApps([])) }, [])
  useEffect(reload, [reload])
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setIssued(null)
    const res = await api.createApp({ name, scopes })
    if ((res as any).error) setError((res as any).error)
    else { setIssued(res.token ?? null); setName(""); reload() }
  }
  return (
    <>
      <div className="card">
        <h3>Create a token</h3>
        <p className="muted">Personal access tokens authenticate <code>git</code> over HTTPS — use the token as the password.</p>
        {error && <div className="error-banner">{error}</div>}
        {issued && (
          <div className="ok-banner">
            <strong>Save this token now — it won't be shown again.</strong>
            <pre className="code" style={{ marginTop: 8 }}>{issued}</pre>
          </div>
        )}
        <form className="form" onSubmit={create}>
          <label>Name<input value={name} onChange={e => setName(e.target.value)} placeholder="ci push" /></label>
          <label>Scopes<select value={scopes} onChange={e => setScopes(e.target.value)}>
            <option value="repo">repo (read + write)</option>
            <option value="repo:read">repo:read</option>
            <option value="repo:write">repo:write</option>
            <option value="admin">admin</option>
          </select></label>
          <div className="actions"><button className="primary" type="submit">Generate</button></div>
        </form>
      </div>
      <div className="card">
        <h3>Active tokens</h3>
        {apps.length === 0
          ? <p className="muted">No tokens.</p>
          : <div className="table-scroll"><table className="list">
            <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
            <tbody>{apps.map(a => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{a.token_prefix}…</td>
                <td>{a.scopes}</td>
                <td>{a.last_used_at ? new Date(a.last_used_at).toLocaleDateString() : "—"}</td>
                <td><button className="danger" onClick={async () => { await api.revokeApp(a.id); reload() }}>Revoke</button></td>
              </tr>
            ))}</tbody>
          </table></div>}
      </div>
    </>
  )
}

// ─── User profile ──────────────────────────────────────────────────────

const UserPage = ({ login }: { login: string }) => {
  const [profile, setProfile] = useState<{ id: number; username: string; name: string; bio: string | null } | null>(null)
  const [repos, setRepos] = useState<api.Repo[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetch(`/api/u/${encodeURIComponent(login)}`, { headers: { authorization: `Bearer ${api.getToken() ?? ""}` } })
      .then(r => r.json()).then(p => p.error ? setError(p.error) : setProfile(p))
    api.listOwnerRepos(login).then(setRepos).catch(() => setRepos([]))
  }, [login])
  if (error) return <div className="error-banner">{error}</div>
  if (!profile) return <div className="empty">Loading…</div>
  return (
    <>
      <h1>{profile.name}</h1>
      <p className="lead">@{profile.username}{profile.bio ? ` · ${profile.bio}` : ""}</p>
      <h2>Repositories</h2>
      {repos.length === 0
        ? <div className="empty"><p>No public repos.</p></div>
        : <div className="repo-list">{repos.map(r => <RepoCard key={r.id} repo={r} />)}</div>}
    </>
  )
}

// ─── Explore ───────────────────────────────────────────────────────────

const Explore = () => (
  <>
    <h1>Explore</h1>
    <p className="lead">Public repos visible to you across the instance.</p>
    <div className="empty"><p className="muted">Coming soon — visit a user via <code>/u/&lt;username&gt;</code>.</p></div>
  </>
)

// ─── Root ──────────────────────────────────────────────────────────────

const App = () => {
  const route = useRoute()
  const [user, setUser] = useState<api.AuthUser | null>(api.getUser())
  // SSO callback redirects to /#token=<jwt>. Until we either adopt the
  // token or know the URL doesn't carry one, suppress the unauthenticated
  // → /login bounce below — otherwise we'd race the network call and
  // briefly show the login screen.
  const [adopting, setAdopting] = useState(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#token="),
  )

  const onAuthed = useCallback((u: api.AuthUser) => {
    setUser(u)
    navigate("/")
  }, [])
  const onLogout = useCallback(() => {
    api.logout()
    setUser(null)
    navigate("/login")
  }, [])

  // Adopt an SSO token off the URL fragment exactly once on mount. The
  // token isn't in the path/search so it never hits the server logs or
  // referer header — same convention stohr uses.
  useEffect(() => {
    if (!adopting) return
    const hash = window.location.hash
    if (!hash.startsWith("#token=")) { setAdopting(false); return }
    const t = decodeURIComponent(hash.slice("#token=".length))
    if (!t) { setAdopting(false); return }
    history.replaceState(null, "", window.location.pathname + window.location.search)
    api.adoptToken(t)
      .then(u => { if (u) setUser(u) })
      .finally(() => setAdopting(false))
  }, [adopting])

  // Redirect rules: unauthenticated → /login (except /login, /signup);
  // authenticated → / (when on /login or /signup). Wait until any SSO
  // token adoption has finished so we don't flash the login screen mid-
  // handoff.
  useEffect(() => {
    if (adopting) return
    if (!user && route.kind !== "auth") navigate("/login")
    if (user && route.kind === "auth") navigate("/")
  }, [user, route, adopting])

  // While we're adopting an SSO token off the URL hash, render nothing
  // (a blank page is less jarring than a half-second flash of the login
  // form before the API call resolves and we flip into the dashboard).
  if (adopting) return null

  if (!user) {
    if (route.kind === "auth") return <AuthPage mode={route.mode} onAuthed={onAuthed} />
    return <AuthPage mode="login" onAuthed={onAuthed} />
  }

  return (
    <Shell user={user} route={route} onLogout={onLogout}>
      {route.kind === "dashboard" && <Dashboard />}
      {route.kind === "explore" && <Explore />}
      {route.kind === "newRepo" && <NewRepo user={user} />}
      {route.kind === "settings" && <Settings section={route.section} user={user} onUserChange={u => { api.setToken(api.getToken(), u); setUser(u) }} />}
      {route.kind === "user" && <UserPage login={route.login} />}
      {route.kind === "repo" && <RepoView owner={route.owner} name={route.name} tab={route.tab} sub={route.sub} user={user} />}
    </Shell>
  )
}

const root = createRoot(document.getElementById("app")!)
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
