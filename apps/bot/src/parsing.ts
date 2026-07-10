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
  if (!value) return [];
  const matches = value.matchAll(/(?:<@&)?(\d{15,22})>?/g);
  return [...new Set(Array.from(matches, (match) => match[1]!))];
}

export function parseBonusRoles(
  value: string | null,
): Array<{ roleId: string; bonusEntries: number }> {
  if (!value) return [];
  const normalized = value.replaceAll("<@&", "").replaceAll(">", "");
  const pairs = normalized.matchAll(/(\d{15,22})\s*(?::|=|\+)\s*(\d+)/g);
  const totals = new Map<string, number>();
  for (const match of pairs) {
    const roleId = match[1]!;
    const bonus = Number(match[2]);
    if (!Number.isSafeInteger(bonus) || bonus <= 0) {
      throw new Error("Bonus entries must be positive integers.");
    }
    totals.set(roleId, (totals.get(roleId) ?? 0) + bonus);
  }
  if (totals.size === 0) {
    throw new Error("Use role:bonus pairs, for example @VIP:2, @Booster:5.");
  }
  return [...totals].map(([roleId, bonusEntries]) => ({ roleId, bonusEntries }));
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
  return new Date(now.getTime() + parseRelativeSeconds(trimmed) * 1000);
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
    return seconds;
  }
  return parseRelativeSeconds(trimmed);
}
