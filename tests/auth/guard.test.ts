import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { APP_TOKEN_PREFIX, hashToken } from "../../src/auth/guard.ts"

describe("hashToken", () => {
  test("produces a stable sha256 hex digest", () => {
    const expected = createHash("sha256").update("hello").digest("hex")
    expect(hashToken("hello")).toBe(expected)
  })

  test("is deterministic for the same input", () => {
    expect(hashToken("tangle_pat_abc")).toBe(hashToken("tangle_pat_abc"))
  })

  test("differs for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"))
  })

  test("returns a 64-char hex string", () => {
    const digest = hashToken("anything")
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("APP_TOKEN_PREFIX", () => {
  test("matches the documented PAT prefix", () => {
    expect(APP_TOKEN_PREFIX).toBe("tangle_pat_")
  })
})
