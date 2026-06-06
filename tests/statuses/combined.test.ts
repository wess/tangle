import { describe, expect, test } from "bun:test"
import { combinedState } from "../../src/statuses/index.ts"

describe("combinedState", () => {
  test("empty rolls up to pending", () => {
    expect(combinedState([])).toBe("pending")
  })

  test("all success rolls up to success", () => {
    expect(combinedState(["success", "success"])).toBe("success")
  })

  test("any pending keeps it pending", () => {
    expect(combinedState(["success", "pending"])).toBe("pending")
  })

  test("any failure rolls up to failure", () => {
    expect(combinedState(["success", "failure"])).toBe("failure")
  })

  test("error is treated as failure", () => {
    expect(combinedState(["success", "error"])).toBe("failure")
  })

  test("failure wins over pending", () => {
    expect(combinedState(["pending", "failure", "success"])).toBe("failure")
  })

  test("single success", () => {
    expect(combinedState(["success"])).toBe("success")
  })
})
