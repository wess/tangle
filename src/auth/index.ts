import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { hash, token, verify } from "@atlas/auth"
import { sha256Hex } from "../util/token.ts"
import { isEmail, isReservedLogin, isValidLogin, normalizeLogin } from "../util/username.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { logEvent } from "../security/audit.ts"
import { verifyTotp } from "../security/totp.ts"
import { issueSession } from "../security/sessions.ts"
import { apiError } from "../util/errors.ts"

type UserRow = {
  id: number
  email: string
  username: string
  name: string
  password: string
  is_owner: boolean
  totp_enabled: boolean
  totp_secret: string | null
  totp_backup_codes: string | null
}

type AuthUser = { id: number; email: string; username: string; name: string; is_owner: boolean }

// Pre-computed argon2id hash of a random throwaway string. Used to make
// the "user not found" path spend the same wall-clock time as the "bad
// password" path so an attacker can't enumerate accounts by timing.
const DECOY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$RetE64xcIWBR/OUrFhs4qiRpTMgEo2w3Z6lis33NPx8$fVAJ65lFBof5QYfFvuLLza/XeSZd8jCGzSd4fzu32nI"

const issueMfaChallenge = (secret: string, userId: number) =>
  token.sign({ kind: "mfa", uid: userId }, secret, { expiresIn: 300 })

const userCount = async (db: Connection) => {
  const any = await db.one(from("users").select("id").limit(1))
  return any ? 1 : 0
}

const consumeBackupCode = async (
  db: Connection,
  userId: number,
  storedCodes: string[],
  candidate: string,
): Promise<boolean> => {
  for (let i = 0; i < storedCodes.length; i++) {
    const ok = await verify(candidate, storedCodes[i]!).catch(() => false)
    if (ok) {
      const remaining = [...storedCodes.slice(0, i), ...storedCodes.slice(i + 1)]
      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({
          totp_backup_codes: JSON.stringify(remaining),
        }),
      )
      return true
    }
  }
  return false
}

export const authRoutes = (db: Connection, secret: string) => {
  const api = pipeline(parseJson)

  return [
    get("/setup", async (c) => {
      const count = await userCount(db)
      return json(c, 200, { needsSetup: count === 0 })
    }),

    post("/signup", api(async (c) => {
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)

      const ipRate = await checkRate(db, `signup:ip:${ip}`, 10, 3600)
      if (!ipRate.ok) {
        logEvent(db, { event: "signup.rate_limited", ip, userAgent: ua })
        return apiError(c, "rate_limited", "Too many signup attempts. Try again later.", { retry_after: ipRate.retryAfterSeconds })
      }

      const body = c.body as {
        name?: string
        email?: string
        username?: string
        password?: string
        invite_token?: string
        inviteToken?: string
      }

      const name = body.name?.trim()
      const emailInput = body.email?.trim().toLowerCase()
      const usernameInput = body.username?.trim()
      const username = usernameInput ? normalizeLogin(usernameInput) : ""
      const password = body.password
      const inviteToken = body.invite_token ?? body.inviteToken

      if (!username || !password) {
        return apiError(c, "validation", "username and password are required")
      }
      if (emailInput && !isEmail(emailInput)) return apiError(c, "validation", "Invalid email format")
      if (!isValidLogin(username)) {
        return apiError(c, "validation", "Username must be 1-32 chars, lowercase letters, digits, and hyphens")
      }
      if (isReservedLogin(username)) return apiError(c, "validation", "Username is reserved")
      if (password.length < 8) return apiError(c, "validation", "Password must be at least 8 characters")

      // Email is optional on a private network. Synthesize a unique placeholder
      // so the NOT NULL/UNIQUE column and email-keyed lookups keep working.
      const email = emailInput || `${username}@tangle.local`
      const displayName = name || username

      const isFirstUser = (await userCount(db)) === 0

      let invite: { id: number; email: string | null; used_at: string | null } | null = null
      if (!isFirstUser) {
        if (!inviteToken) return apiError(c, "forbidden", "Invite token required")
        invite = await db.one(
          from("invites")
            .where(q => q("token_hash").equals(sha256Hex(inviteToken)))
            .select("id", "email", "used_at"),
        ) as { id: number; email: string | null; used_at: string | null } | null
        if (!invite) return apiError(c, "forbidden", "Invalid invite token")
        if (invite.used_at) return apiError(c, "forbidden", "Invite already used")
        if (invite.email && invite.email.toLowerCase() !== email) {
          return apiError(c, "forbidden", "Invite is bound to a different email")
        }
      }

      const emailTaken = await db.one(
        from("users").where(q => q("email").equals(email)).select("id"),
      )
      if (emailTaken) return apiError(c, "conflict", "Email already in use")
      const loginTaken = await db.one(
        from("users").where(q => q("username").equals(username)).select("id"),
      )
      if (loginTaken) return apiError(c, "conflict", "Username already in use")
      // Org logins live in the same namespace as user logins so a clone
      // URL `tangle.io/<login>/<repo>` is unambiguous.
      const orgTaken = await db.one(
        from("orgs").where(q => q("login").equals(username)).select("id"),
      )
      if (orgTaken) return apiError(c, "conflict", "Username already in use")

      const hashed = await hash(password)
      const inserted = await db.execute(
        from("users")
          .insert({
            name: displayName,
            email,
            username,
            password: hashed,
            is_owner: isFirstUser,
          })
          .returning("id", "email", "username", "name", "is_owner"),
      ) as Array<AuthUser>
      const user = inserted[0]!

      if (invite) {
        await db.execute(
          from("invites").where(q => q("id").equals(invite!.id)).update({
            used_at: raw("NOW()"),
            used_by: user.id,
          }),
        )
      }

      logEvent(db, {
        userId: user.id,
        event: "signup.ok",
        metadata: { is_first_user: isFirstUser, invite_id: invite?.id ?? null },
        ip,
        userAgent: ua,
      })

      const sess = await issueSession(db, user, secret, { ip, userAgent: ua })
      return json(c, 201, {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        is_owner: user.is_owner,
        token: sess.token,
      })
    })),

    post("/login", api(async (c) => {
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)

      const body = c.body as {
        identity?: string
        email?: string
        username?: string
        password?: string
      }
      const identity = (body.identity ?? body.email ?? body.username ?? "").trim()
      const password = body.password ?? ""
      if (!identity || !password) return apiError(c, "validation", "identity and password are required")

      const ipRate = await checkRate(db, `login:ip:${ip}`, 30, 900)
      if (!ipRate.ok) {
        logEvent(db, { event: "login.rate_limited", metadata: { scope: "ip", identity }, ip, userAgent: ua })
        return apiError(c, "rate_limited", "Too many attempts. Try again later.", { retry_after: ipRate.retryAfterSeconds })
      }
      const idRate = await checkRate(db, `login:id:${identity.toLowerCase()}`, 5, 900)
      if (!idRate.ok) {
        logEvent(db, { event: "login.rate_limited", metadata: { scope: "identity", identity }, ip, userAgent: ua })
        return apiError(c, "rate_limited", "Too many attempts for this account. Try again later.", { retry_after: idRate.retryAfterSeconds })
      }

      const lookup = identity.includes("@") ? identity.toLowerCase() : normalizeLogin(identity)
      const user = await db.one(
        from("users")
          .where(q => identity.includes("@") ? q("email").equals(lookup) : q("username").equals(lookup))
          .select("id", "email", "username", "name", "password", "is_owner", "totp_enabled", "totp_secret", "totp_backup_codes", "deleted_at"),
      ) as (UserRow & { deleted_at: string | null }) | null

      // Always run a verify, even when the user doesn't exist, so the
      // response timing doesn't leak account existence.
      const verifyTarget = user?.password ?? DECOY_PASSWORD_HASH
      const verifyOk = await verify(password, verifyTarget).catch(() => false)

      if (!user) {
        logEvent(db, { event: "login.fail", metadata: { reason: "no_user", identity }, ip, userAgent: ua })
        return apiError(c, "unauthorized", "Invalid credentials")
      }
      if (!verifyOk) {
        logEvent(db, { userId: user.id, event: "login.fail", metadata: { reason: "bad_password" }, ip, userAgent: ua })
        return apiError(c, "unauthorized", "Invalid credentials")
      }
      if (user.deleted_at) {
        logEvent(db, { userId: user.id, event: "login.fail", metadata: { reason: "account_deleted" }, ip, userAgent: ua })
        return apiError(c, "forbidden", "Account is scheduled for deletion. Click the cancel link in your email to restore it.", { account_deleted: true })
      }

      if (user.totp_enabled) {
        logEvent(db, { userId: user.id, event: "login.mfa_required", ip, userAgent: ua })
        return json(c, 200, {
          mfa_required: true,
          mfa_token: await issueMfaChallenge(secret, user.id),
        })
      }

      logEvent(db, { userId: user.id, event: "login.ok", ip, userAgent: ua })
      const sess = await issueSession(db, {
        id: user.id, email: user.email, username: user.username, name: user.name, is_owner: user.is_owner,
      }, secret, { ip, userAgent: ua })
      return json(c, 200, {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        is_owner: user.is_owner,
        token: sess.token,
      })
    })),

    post("/login/mfa", api(async (c) => {
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as { mfa_token?: string; mfaToken?: string; code?: string; backup_code?: string; backupCode?: string }
      const mfaToken = body.mfa_token ?? body.mfaToken
      const code = body.code?.trim()
      const backupCode = (body.backup_code ?? body.backupCode)?.trim()
      if (!mfaToken) return apiError(c, "validation", "mfa_token required")
      if (!code && !backupCode) return apiError(c, "validation", "code or backup_code required")

      let payload: { kind?: string; uid?: number }
      try {
        payload = await token.verify(mfaToken, secret) as { kind?: string; uid?: number }
      } catch {
        return apiError(c, "unauthorized", "Invalid or expired MFA challenge — start over")
      }
      if (payload.kind !== "mfa" || !payload.uid) {
        return apiError(c, "unauthorized", "Invalid MFA challenge")
      }

      const ipRate = await checkRate(db, `mfa:ip:${ip}`, 30, 900)
      if (!ipRate.ok) {
        return apiError(c, "rate_limited", "Too many attempts.", { retry_after: ipRate.retryAfterSeconds })
      }
      const userRate = await checkRate(db, `mfa:user:${payload.uid}`, 6, 900)
      if (!userRate.ok) {
        logEvent(db, { userId: payload.uid, event: "login.mfa_locked", ip, userAgent: ua })
        return apiError(c, "rate_limited", "Too many MFA attempts. Try again later.", { retry_after: userRate.retryAfterSeconds })
      }

      const user = await db.one(
        from("users")
          .where(q => q("id").equals(payload.uid!))
          .select("id", "email", "username", "name", "is_owner", "totp_enabled", "totp_secret", "totp_backup_codes"),
      ) as Pick<UserRow, "id" | "email" | "username" | "name" | "is_owner" | "totp_enabled" | "totp_secret" | "totp_backup_codes"> | null
      if (!user || !user.totp_enabled || !user.totp_secret) {
        return apiError(c, "unauthorized", "MFA not enabled for this user")
      }

      let verified = false
      if (code) {
        verified = verifyTotp(user.totp_secret, code)
      } else if (backupCode) {
        const stored = user.totp_backup_codes ? (JSON.parse(user.totp_backup_codes) as string[]) : []
        verified = await consumeBackupCode(db, user.id, stored, backupCode)
        if (verified) {
          logEvent(db, { userId: user.id, event: "login.mfa_backup_used", ip, userAgent: ua })
        }
      }

      if (!verified) {
        logEvent(db, { userId: user.id, event: "login.mfa_fail", ip, userAgent: ua })
        return apiError(c, "unauthorized", "Invalid code")
      }

      logEvent(db, { userId: user.id, event: "login.ok", metadata: { mfa: true }, ip, userAgent: ua })
      const sess = await issueSession(db, {
        id: user.id, email: user.email, username: user.username, name: user.name, is_owner: user.is_owner,
      }, secret, { ip, userAgent: ua })
      return json(c, 200, {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        is_owner: user.is_owner,
        token: sess.token,
      })
    })),
  ]
}
