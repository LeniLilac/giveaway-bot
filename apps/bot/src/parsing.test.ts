import { describe, expect, it } from "vitest";
import { parseBonusRoles, parseDuration, parseRoleIds, parseStart } from "./parsing.js";
import { MAX_DURATION_SECONDS, MAX_TOTAL_BONUS_ENTRIES } from "./limits.js";

describe("Discord command parsing", () => {
  it("accepts compact, spaced, and reordered duration units", () => {
    const start = new Date("2026-07-10T00:00:00.000Z");
    expect(parseDuration("1d3h2m", start, start)).toBe(97_320);
    expect(parseDuration("2m, 3h, 1d", start, start)).toBe(97_320);
  });

  it("treats a Unix duration value as an end timestamp", () => {
    const start = new Date("2026-07-10T00:00:00.000Z");
    expect(parseDuration("1783728000", start, start)).toBe(86_400);
  });

  it("enforces the exact one-year duration boundary", () => {
    const start = new Date("2026-07-10T00:00:00.000Z");
    expect(parseDuration("1y", start, start)).toBe(MAX_DURATION_SECONDS);
    expect(() => parseDuration("1y1s", start, start)).toThrow("1 year");
  });

  it("parses a relative or Unix scheduled start", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");
    expect(parseStart("1h30m", now).toISOString()).toBe("2026-07-10T01:30:00.000Z");
    expect(parseStart("1783728000", now).toISOString()).toBe("2026-07-11T00:00:00.000Z");
    expect(() => parseStart("8640000000000s", now)).toThrow(
      "supported timestamp range",
    );
  });

  it("deduplicates role lists and adds duplicate role bonuses", () => {
    expect(
      parseRoleIds("<@&123456789012345678>, 123456789012345678 987654321098765432"),
    ).toEqual(["123456789012345678", "987654321098765432"]);
    expect(
      parseBonusRoles("123456789012345678:2, <@&123456789012345678>:3"),
    ).toEqual([{ roleId: "123456789012345678", bonusEntries: 5 }]);
  });

  it("rejects role-list text that is not entirely valid", () => {
    for (const value of [
      "   ",
      "role 123456789012345678",
      "123456789012345678 trailing",
      "<@&123456789012345678",
      "123456789012345678,",
      "123456789012345678xyz987654321098765432",
    ]) {
      expect(() => parseRoleIds(value)).toThrow();
    }
  });

  it("rejects malformed or overflowing role bonus lists", () => {
    for (const value of [
      "   ",
      "junk 123456789012345678:2",
      "123456789012345678:2 trailing",
      "123456789012345678:0",
      "123456789012345678:2,",
      `123456789012345678:${MAX_TOTAL_BONUS_ENTRIES}, 987654321098765432:1`,
    ]) {
      expect(() => parseBonusRoles(value)).toThrow();
    }
  });
});
