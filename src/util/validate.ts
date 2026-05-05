// Tiny validator. The point is uniformity — every route returns the
// same `apiError(c, "validation", ...)` shape on bad input. Keeping it
// dependency-free so MCP and any future thin client can reuse the same
// rules. The patterns mirror what's already enforced ad-hoc in
// signup/login/repo create — just centralized now.

export type ValidationIssue = { field: string; message: string }

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] }

export type Rule<T> = (value: unknown, field: string) => { ok: true; value: T } | { ok: false; message: string }

export const required = <T>(rule: Rule<T>): Rule<T> =>
  (value, field) => {
    if (value === undefined || value === null || value === "") {
      return { ok: false, message: `${field} is required` }
    }
    return rule(value, field)
  }

export const optional = <T>(rule: Rule<T>): Rule<T | undefined> =>
  (value, field) => {
    if (value === undefined || value === null || value === "") return { ok: true, value: undefined }
    return rule(value, field)
  }

export const string = (opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Rule<string> =>
  (value, field) => {
    if (typeof value !== "string") return { ok: false, message: `${field} must be a string` }
    const v = opts.trim === false ? value : value.trim()
    if (opts.min !== undefined && v.length < opts.min) return { ok: false, message: `${field} must be at least ${opts.min} characters` }
    if (opts.max !== undefined && v.length > opts.max) return { ok: false, message: `${field} must be at most ${opts.max} characters` }
    if (opts.pattern && !opts.pattern.test(v)) return { ok: false, message: `${field} format is invalid` }
    return { ok: true, value: v }
  }

export const integer = (opts: { min?: number; max?: number } = {}): Rule<number> =>
  (value, field) => {
    const n = typeof value === "number" ? value : Number(value)
    if (!Number.isInteger(n)) return { ok: false, message: `${field} must be an integer` }
    if (opts.min !== undefined && n < opts.min) return { ok: false, message: `${field} must be at least ${opts.min}` }
    if (opts.max !== undefined && n > opts.max) return { ok: false, message: `${field} must be at most ${opts.max}` }
    return { ok: true, value: n }
  }

export const boolean: Rule<boolean> = (value, field) => {
  if (typeof value === "boolean") return { ok: true, value }
  return { ok: false, message: `${field} must be a boolean` }
}

export const oneOf = <T extends string>(values: readonly T[]): Rule<T> =>
  (value, field) => {
    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
      return { ok: true, value: value as T }
    }
    return { ok: false, message: `${field} must be one of ${values.join(", ")}` }
  }

export const validate = <S extends Record<string, Rule<unknown>>>(
  input: Record<string, unknown>,
  schema: S,
): ValidationResult<{ [K in keyof S]: ReturnType<S[K]> extends { value: infer V } ? V : never }> => {
  const issues: ValidationIssue[] = []
  const out: Record<string, unknown> = {}
  for (const [field, rule] of Object.entries(schema)) {
    const result = rule(input[field], field)
    if (!result.ok) issues.push({ field, message: result.message })
    else out[field] = result.value
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: out as never }
}

// First-issue formatter — for endpoints that report a single string in
// the error envelope (most of Tangle today). Multi-issue reports can
// pass `issues` as the extra field for clients that want them all.
export const firstIssue = (issues: ValidationIssue[]): string =>
  issues[0] ? `${issues[0].field}: ${issues[0].message}` : "Invalid input"
