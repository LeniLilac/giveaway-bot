export const MAX_REROLL_WINNERS = 2_147_483_647;

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
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_REROLL_WINNERS
  ) {
    throw new Error(
      `Winner count must be between 1 and ${MAX_REROLL_WINNERS.toLocaleString()}.`,
    );
  }
  return count;
}
