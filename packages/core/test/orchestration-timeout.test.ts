import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  formatTimeoutMs,
  parseTimeoutToMs,
  TimeoutParseError,
} from "../src/orchestration/timeout.js";

describe("parseTimeoutToMs", () => {
  it("parses explicit units", () => {
    expect(parseTimeoutToMs("500ms")).toBe(500);
    expect(parseTimeoutToMs("30s")).toBe(30_000);
    expect(parseTimeoutToMs("5m")).toBe(300_000);
    expect(parseTimeoutToMs("1h")).toBe(3_600_000);
    expect(parseTimeoutToMs("1.5h")).toBe(5_400_000);
  });

  it("treats plain numbers as seconds", () => {
    expect(parseTimeoutToMs("90")).toBe(90_000);
    expect(parseTimeoutToMs(" 10 ")).toBe(10_000);
  });

  it("is case-insensitive and trims", () => {
    expect(parseTimeoutToMs(" 5M ")).toBe(300_000);
    expect(parseTimeoutToMs("30S")).toBe(30_000);
  });

  it("rejects empty/zero/unknown/over-limit with actionable errors", () => {
    for (const bad of ["", "0s", "0", "-5s", "abc", "10x", "2m30s", "25h"]) {
      expect(() => parseTimeoutToMs(bad)).toThrowError(TimeoutParseError);
    }
    expect(() => parseTimeoutToMs("")).toThrowError(/30s, 5m/);
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(formatTimeoutMs(500)).toBe("500ms");
    expect(formatTimeoutMs(30_000)).toBe("30s");
    expect(formatTimeoutMs(300_000)).toBe("5m");
    expect(formatTimeoutMs(3_600_000)).toBe("1h");
  });
});
