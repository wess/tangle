import { describe, expect, test } from "bun:test"
import * as schema from "../../src/schema/index.ts"

const tables = Object.values(schema).filter(
  (s): s is { table: string; columns: Record<string, { type: string; defaultValue: unknown }> } =>
    typeof s === "object" && s !== null && "table" in s && "columns" in s,
)

describe("schema definitions", () => {
  test("every export defines a non-empty table name and columns", () => {
    expect(tables.length).toBeGreaterThan(0)
    for (const t of tables) {
      expect(t.table.length).toBeGreaterThan(0)
      expect(Object.keys(t.columns).length).toBeGreaterThan(0)
    }
  })

  test("table names are unique", () => {
    const names = tables.map(t => t.table)
    expect(new Set(names).size).toBe(names.length)
  })

  test("timestamp columns never carry a string SQL-expression default", () => {
    // Regression guard: schema-level defaults must be type-correct. SQL
    // expression defaults like "now()" belong in the migration DDL, not the
    // typed schema (they break tsc and are ignored at runtime).
    for (const t of tables) {
      for (const [name, col] of Object.entries(t.columns)) {
        if (col.type === "timestamp" && col.defaultValue !== undefined) {
          expect(typeof col.defaultValue).not.toBe("string")
        }
      }
    }
  })

  test("bigint defaults are bigint-typed, not number", () => {
    for (const t of tables) {
      for (const col of Object.values(t.columns)) {
        if (col.type === "bigint" && col.defaultValue !== undefined) {
          expect(typeof col.defaultValue).toBe("bigint")
        }
      }
    }
  })
})
