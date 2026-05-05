import { marked } from "marked"
import sanitize from "sanitize-html"

// One markdown pipeline for every place that renders user prose:
// READMEs, issue / PR bodies, comments. Keep it boring — Marked +
// sanitize-html with a strict allowlist. We deliberately do NOT enable
// arbitrary HTML inside markdown; if a user wants to write `<script>`
// it goes through as escaped text. The renderer is sync, server-side,
// and idempotent — same input always yields the same HTML.

// GFM by default — tables, strikethrough, autolinks. Mangle and
// header-ids stay off; mangle obfuscates emails (annoying), and we
// don't generate anchors here (the consumer can if it wants).
marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
})

const ALLOWED_TAGS = [
  // Block
  "p", "br", "hr", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  // Inline
  "a", "code", "em", "strong", "del", "ins", "sub", "sup",
  "img",
  // GFM checkbox lists render as <input type="checkbox" disabled>
  "input",
  "span",
]

const SAFE_PROTOCOLS = ["http", "https", "mailto", "tel"]

const sanitizeOpts: sanitize.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    input: ["type", "checked", "disabled"],
    code: ["class"],
    span: ["class"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: SAFE_PROTOCOLS,
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
  },
  // No `<style>`, no `<script>`, no `data:` URLs except images. The
  // sanitizer removes anything outside the allowlists silently rather
  // than escaping — matches GitHub's renderer behavior.
  disallowedTagsMode: "discard",
  // Force every `<a>` to open externally with a no-opener / no-referrer
  // tether. Cheap defense in depth against window.opener attacks.
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        rel: "noopener noreferrer nofollow",
        target: attribs.target === "_blank" ? "_blank" : "_blank",
      },
    }),
    // Force checkboxes (GFM task lists) to read-only — they're a
    // visual cue, not interactive.
    input: (_tagName, attribs) => ({
      tagName: "input",
      attribs: { ...attribs, disabled: "disabled" },
    }),
  },
}

export const renderMarkdown = (input: string | null | undefined): string => {
  if (!input) return ""
  // Marked's parse is sync when no async extensions are configured,
  // but the type signature is `string | Promise<string>`. We never set
  // an async extension, so the cast below is safe.
  const html = marked.parse(input, { async: false }) as string
  return sanitize(html, sanitizeOpts)
}
