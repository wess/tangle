import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { buildBody, sign } from "../../src/webhooks/dispatch.ts"

describe("sign", () => {
  test("matches the GitHub sha256= HMAC convention over the exact body", () => {
    const body = JSON.stringify({ a: 1 })
    const expected =
      "sha256=" + createHmac("sha256", "topsecret").update(body).digest("hex")
    expect(sign("topsecret", body)).toBe(expected)
  })

  test("is sensitive to the body bytes", () => {
    expect(sign("s", "a")).not.toBe(sign("s", "b"))
  })

  test("is sensitive to the secret", () => {
    expect(sign("s1", "a")).not.toBe(sign("s2", "a"))
  })

  test("emits a sha256= prefixed hex digest", () => {
    expect(sign("s", "payload")).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})

describe("buildBody", () => {
  test("defaults to a JSON body", () => {
    const out = buildBody("application/json", { hello: "world" })
    expect(out).toBe(JSON.stringify({ hello: "world" }))
  })

  test("wraps JSON in a payload= form field for urlencoded delivery", () => {
    const out = buildBody("application/x-www-form-urlencoded", { hello: "world" })
    const params = new URLSearchParams(out)
    expect(params.get("payload")).toBe(JSON.stringify({ hello: "world" }))
  })

  test("signature is computed over the form-encoded body, not raw JSON", () => {
    const payload = { event: "push" }
    const body = buildBody("application/x-www-form-urlencoded", payload)
    expect(body.startsWith("payload=")).toBe(true)
    // The receiver verifies the signature against the bytes it receives.
    const sig = sign("k", body)
    expect(sig).toBe(
      "sha256=" + createHmac("sha256", "k").update(body).digest("hex"),
    )
  })
})
