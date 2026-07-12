import { describe, expect, it } from "vitest";
import { canFulfillReroll, countExclusionReasons } from "./reroll-policy.js";

describe("reroll winner-count policy", () => {
  it("requires the full requested winner count", () => {
    expect(canFulfillReroll(3, 3)).toBe(true);
    expect(canFulfillReroll(3, 2)).toBe(false);
  });

  it("summarizes rejection reasons without participant payloads", () => {
    expect(
      countExclusionReasons([
        { userId: "1", reason: "previous_winner" },
        { userId: "2", reason: "previous_winner" },
        { userId: "3", reason: "required_roles_missing" },
      ]),
    ).toEqual({
      previous_winner: 2,
      required_roles_missing: 1,
    });
  });
});
