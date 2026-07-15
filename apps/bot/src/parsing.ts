import {
  MAX_TOTAL_BONUS_ENTRIES,
  assertBonusEntriesFit,
  assertDurationSeconds,
} from "./limits.js";

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
  mo: 30 * 24 * 60 * 60,
  y: 365 * 24 * 60 * 60,
};

export function parseRoleIds(value: string | null): string[] {
  if (value === null) return [];
  const input = value.trim();
  if (!input) throw new Error("A role list cannot be blank.");
  const token = /(?:<@&(\d{15,22})>|(\d{15,22}))/y;
  const roles: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    token.lastIndex = cursor;
    const match = token.exec(input);
    if (!match || match.index !== cursor) {
      throw new Error(
        "Use only complete role mentions or IDs separated by spaces or commas.",
      );
    }
    roles.push(match[1] ?? match[2]!);
    cursor = token.lastIndex;
    if (cursor === input.length) break;
    const separator = /^(?:\s*,\s*|\s+)/.exec(input.slice(cursor));
    if (!separator) {
      throw new Error(
        "Use only complete role mentions or IDs separated by spaces or commas.",
      );
    }
    cursor += separator[0].length;
    if (cursor === input.length) {
      throw new Error("A role list cannot end with a separator.");
    }
  }
  return [...new Set(roles)];
}

export function parseBonusRoles(
  value: string | null,
): Array<{ roleId: string; bonusEntries: number }> {
  if (value === null) return [];
  const input = value.trim();
  if (!input) throw new Error("A role bonus list cannot be blank.");
  const pair = /(?:<@&(\d{15,22})>|(\d{15,22}))\s*(?::|=|\+)\s*(\d+)/y;
  const totals = new Map<string, number>();
  let cursor = 0;
  while (cursor < input.length) {
    pair.lastIndex = cursor;
    const match = pair.exec(input);
    if (!match || match.index !== cursor) {
      throw new Error(
        "Use only role:bonus pairs, for example @VIP:2, @Booster:5.",
      );
    }
    const roleId = match[1] ?? match[2]!;
    const bonus = Number(match[3]);
    const combined = (totals.get(roleId) ?? 0) + bonus;
    if (
      !Number.isSafeInteger(bonus) ||
      bonus <= 0 ||
      !Number.isSafeInteger(combined) ||
      combined > MAX_TOTAL_BONUS_ENTRIES
    ) {
      throw new Error(
        `Role bonus entries must be between 1 and ${MAX_TOTAL_BONUS_ENTRIES.toLocaleString()}.`,
      );
    }
    totals.set(roleId, combined);
    cursor = pair.lastIndex;
    if (cursor === input.length) break;
    const separator = /^(?:\s*,\s*|\s+)/.exec(input.slice(cursor));
    if (!separator) {
      throw new Error(
        "Use only role:bonus pairs, for example @VIP:2, @Booster:5.",
      );
    }
    cursor += separator[0].length;
    if (cursor === input.length) {
      throw new Error("A role bonus list cannot end with a separator.");
    }
  }
  const bonuses = [...totals].map(([roleId, bonusEntries]) => ({
    roleId,
    bonusEntries,
  }));
  assertBonusEntriesFit(bonuses);
  return bonuses;
}

function parseRelativeSeconds(value: string): number {
  const compact = value.toLowerCase().replace(/[\s,]+/g, "");
  if (!compact) throw new Error("A time value is required.");
  const expression = /(\d+)(mo|[smhdwy])/gy;
  let cursor = 0;
  let seconds = 0;
  while (cursor < compact.length) {
    expression.lastIndex = cursor;
    const match = expression.exec(compact);
    if (!match || match.index !== cursor) {
      throw new Error("Invalid time. Use combinations such as 1d3h2m.");
    }
    const amount = Number(match[1]);
    seconds += amount * UNIT_SECONDS[match[2]!]!;
    cursor = expression.lastIndex;
  }
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Time must be greater than zero.");
  }
  return seconds;
}

export function parseStart(value: string | null, now = new Date()): Date {
  if (!value) return now;
  const trimmed = value.trim();
  if (/^\d{10,13}$/.test(trimmed)) {
    const raw = Number(trimmed);
    const milliseconds = trimmed.length === 13 ? raw : raw * 1000;
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime()) || date <= now) {
      throw new Error("The start time must be in the future.");
    }
    return date;
  }
  const date = new Date(now.getTime() + parseRelativeSeconds(trimmed) * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("The start time is outside the supported timestamp range.");
  }
  return date;
}

export function parseDuration(
  value: string,
  scheduledStart: Date,
  now = new Date(),
): number {
  const trimmed = value.trim();
  if (/^\d{10,13}$/.test(trimmed)) {
    const raw = Number(trimmed);
    const milliseconds = trimmed.length === 13 ? raw : raw * 1000;
    const anchor = scheduledStart > now ? scheduledStart : now;
    const seconds = Math.floor((milliseconds - anchor.getTime()) / 1000);
    if (seconds <= 0) throw new Error("The Unix end time must follow the start time.");
    assertDurationSeconds(seconds);
    return seconds;
  }
  const seconds = parseRelativeSeconds(trimmed);
  assertDurationSeconds(seconds);
  return seconds;
}
