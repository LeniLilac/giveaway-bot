export const POSTGRES_INTEGER_MAX = 2_147_483_647;

// Draws persist their requested winner count in an integer column.
export const MAX_WINNER_COUNT = POSTGRES_INTEGER_MAX;
export const MAX_REQUIRED_MESSAGES = POSTGRES_INTEGER_MAX;
export const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;
export const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

// Candidate weight is base weight one plus every matching role bonus.
export const MAX_TOTAL_BONUS_ENTRIES = POSTGRES_INTEGER_MAX - 1;

export function assertWinnerCount(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_WINNER_COUNT
  ) {
    throw new Error(
      `Winner count must be between 1 and ${MAX_WINNER_COUNT.toLocaleString()}.`,
    );
  }
}

export function assertRequiredMessages(value: unknown): asserts value is number | null {
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_REQUIRED_MESSAGES)
  ) {
    throw new Error(
      `Required messages must be between 1 and ${MAX_REQUIRED_MESSAGES.toLocaleString()}.`,
    );
  }
}

export function assertDurationSeconds(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `Giveaway duration must be between 1 second and ${MAX_DURATION_SECONDS.toLocaleString()} seconds (1 year).`,
    );
  }
}

export function assertScheduledWindow(
  scheduledStartAt: string,
  durationSeconds: number,
): void {
  const start = Date.parse(scheduledStartAt);
  const end = start + durationSeconds * 1_000;
  if (
    !Number.isFinite(start) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    Math.abs(start) > MAX_JAVASCRIPT_DATE_MS ||
    Math.abs(end) > MAX_JAVASCRIPT_DATE_MS ||
    !Number.isFinite(new Date(end).getTime())
  ) {
    throw new Error("The giveaway start and end time must fit the supported timestamp range.");
  }
}

export function assertBonusEntriesFit(
  bonuses: ReadonlyArray<{ bonusEntries: number }>,
): void {
  let total = 0;
  for (const bonus of bonuses) {
    if (
      !Number.isSafeInteger(bonus.bonusEntries) ||
      bonus.bonusEntries < 1 ||
      bonus.bonusEntries > MAX_TOTAL_BONUS_ENTRIES
    ) {
      throw new Error(
        `Each role bonus must be between 1 and ${MAX_TOTAL_BONUS_ENTRIES.toLocaleString()}.`,
      );
    }
    total += bonus.bonusEntries;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BONUS_ENTRIES) {
      throw new Error(
        `Combined role bonuses cannot exceed ${MAX_TOTAL_BONUS_ENTRIES.toLocaleString()}.`,
      );
    }
  }
}
