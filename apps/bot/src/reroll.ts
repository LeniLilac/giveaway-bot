import { MAX_WINNER_COUNT, assertWinnerCount } from "./limits.js";

export const MAX_REROLL_WINNERS = MAX_WINNER_COUNT;

export function parseRerollWinnerCount(value: unknown): number {
  const raw =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^\d+$/.test(raw)) {
    throw new Error("Winner count must be a whole number.");
  }
  const count = Number(raw);
  assertWinnerCount(count);
  return count;
}
