import { describe, expect, test } from "bun:test"
import { advertiseHeader } from "../../src/git/protocol.ts"

const decode = (b: Uint8Array) => new TextDecoder().decode(b)

describe("advertiseHeader", () => {
  test("frames the upload-pack service header as a pkt-line + flush", () => {
    const out = decode(advertiseHeader("git-upload-pack"))
    // pkt-line is a 4-hex length prefix over the payload (incl. the 4 bytes).
    const payload = "# service=git-upload-pack\n"
    const len = (payload.length + 4).toString(16).padStart(4, "0")
    expect(out).toBe(`${len}${payload}0000`)
  })

  test("frames the receive-pack service header", () => {
    const out = decode(advertiseHeader("git-receive-pack"))
    expect(out).toContain("# service=git-receive-pack\n")
    expect(out.endsWith("0000")).toBe(true)
  })

  test("length prefix is a valid 4-hex value matching content length", () => {
    const out = decode(advertiseHeader("git-upload-pack"))
    const prefix = out.slice(0, 4)
    expect(prefix).toMatch(/^[0-9a-f]{4}$/)
    const declared = Number.parseInt(prefix, 16)
    // The flush "0000" is appended after the framed line.
    expect(out.length).toBe(declared + 4)
  })
})
