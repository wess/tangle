import { spawn } from "node:child_process"

// Smart-HTTP framing helpers. The protocol uses pkt-line — a 4-hex-byte
// length prefix followed by the line, with the special "0000" flush
// terminator. The advertise step prepends a service header and a flush.

const pktLine = (s: string): string => {
  const len = (s.length + 4).toString(16).padStart(4, "0")
  return `${len}${s}`
}

const FLUSH_PKT = "0000"

export const advertiseHeader = (service: "git-upload-pack" | "git-receive-pack"): Uint8Array => {
  const text = pktLine(`# service=${service}\n`) + FLUSH_PKT
  return new TextEncoder().encode(text)
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

const collectStream = async (stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> => {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return concat(chunks)
}

// Run `git <service> --stateless-rpc --advertise-refs` against a bare
// repo and return the stdout bytes. The `--stateless-rpc` flag is
// mandatory for Smart-HTTP — it tells git to consume one request worth
// of input and exit, rather than holding the connection open.
export const runAdvertise = async (
  service: "git-upload-pack" | "git-receive-pack",
  repoPath: string,
): Promise<Uint8Array> =>
  new Promise((resolveP, rejectP) => {
    const cmd = service === "git-upload-pack" ? "git-upload-pack" : "git-receive-pack"
    const proc = spawn(cmd, ["--stateless-rpc", "--advertise-refs", repoPath], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks: Uint8Array[] = []
    let stderr = ""
    proc.stdout.on("data", b => chunks.push(new Uint8Array(b)))
    proc.stderr.on("data", b => { stderr += b.toString() })
    proc.on("error", rejectP)
    proc.on("close", code => {
      if (code === 0) {
        const out = concat(chunks)
        resolveP(concat([advertiseHeader(service), out]))
      } else {
        rejectP(new Error(`${cmd} --advertise-refs exited ${code}: ${stderr.trim()}`))
      }
    })
  })

// Drive the protocol RPC: read the request body (the client's pkt-line
// stream), feed it into git's stdin, stream stdout back as the
// response. We collect-then-write because Bun.serve hands us the body as
// a ReadableStream and `git` needs a writable end-of-input to finish.
export const runRpc = async (
  service: "git-upload-pack" | "git-receive-pack",
  repoPath: string,
  request: Request,
): Promise<{ status: number; body: Uint8Array; contentType: string }> => {
  const cmd = service === "git-upload-pack" ? "git-upload-pack" : "git-receive-pack"
  const input = await collectStream(request.body)
  return await new Promise((resolveP, rejectP) => {
    const proc = spawn(cmd, ["--stateless-rpc", repoPath], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const chunks: Uint8Array[] = []
    let stderr = ""
    proc.stdout.on("data", b => chunks.push(new Uint8Array(b)))
    proc.stderr.on("data", b => { stderr += b.toString() })
    proc.on("error", rejectP)
    proc.on("close", code => {
      if (code === 0) {
        resolveP({
          status: 200,
          body: concat(chunks),
          contentType: `application/x-${service}-result`,
        })
      } else {
        rejectP(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))
      }
    })
    proc.stdin.write(input)
    proc.stdin.end()
  })
}
