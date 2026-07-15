import { describe, expect, it } from "vitest";
import { commandData } from "./commands.js";
import {
  MAX_REROLL_WINNERS,
  parseRerollWinnerCount,
} from "./reroll.js";
import { MAX_REQUIRED_MESSAGES, MAX_WINNER_COUNT } from "./limits.js";

describe("reroll winner count", () => {
  it("accepts positive integer strings and numbers", () => {
    expect(parseRerollWinnerCount("3")).toBe(3);
    expect(parseRerollWinnerCount(7)).toBe(7);
    expect(parseRerollWinnerCount(String(MAX_REROLL_WINNERS))).toBe(
      MAX_REROLL_WINNERS,
    );
  });

  it("rejects missing, fractional, non-positive, and oversized values", () => {
    for (const value of ["", "1.5", "no", 0, -1, MAX_REROLL_WINNERS + 1]) {
      expect(() => parseRerollWinnerCount(value)).toThrow();
    }
  });

  it("keeps slash options optional so the picker and modal remain available", () => {
    const root = commandData[0] as {
      options?: Array<{
        name: string;
        options?: Array<{ name: string; required?: boolean }>;
      }>;
    };
    const reroll = root.options?.find((option) => option.name === "reroll");
    expect(reroll?.options?.find((option) => option.name === "message_id")?.required)
      .not.toBe(true);
    expect(reroll?.options?.find((option) => option.name === "winners")?.required)
      .not.toBe(true);
  });

  it("publishes exact downstream integer bounds on create options", () => {
    const root = commandData[0] as {
      options?: Array<{
        name: string;
        options?: Array<{ name: string; max_value?: number }>;
      }>;
    };
    const create = root.options?.find((option) => option.name === "create");
    expect(create?.options?.find((option) => option.name === "winners")?.max_value)
      .toBe(MAX_WINNER_COUNT);
    expect(
      create?.options?.find((option) => option.name === "required_messages")?.max_value,
    ).toBe(MAX_REQUIRED_MESSAGES);
  });
});
