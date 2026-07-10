const UNIT_SECONDS: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3_600n,
  d: 86_400n,
  w: 604_800n,
  mo: 2_592_000n,
  y: 31_536_000n
};

export type ParsedTime =
  | { kind: "absolute"; unixSeconds: bigint; date: Date }
  | { kind: "duration"; seconds: bigint };

function dateFromUnix(seconds: bigint): Date {
  const milliseconds = seconds * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Timestamp is outside the supported range.");
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid timestamp.");
  return date;
}

export function parseTimeInput(value: string): ParsedTime {
  const trimmed = value.trim();
  if (/^\d{10}$/.test(trimmed)) {
    const unixSeconds = BigInt(trimmed);
    return { kind: "absolute", unixSeconds, date: dateFromUnix(unixSeconds) };
  }
  const compact = trimmed.replace(/[\s,]+/g, "");
  if (!compact) throw new Error("A time value is required.");
  const token = /(\d+)(mo|s|m|h|d|w|y)/gy;
  let offset = 0;
  let total = 0n;
  while (offset < compact.length) {
    token.lastIndex = offset;
    const match = token.exec(compact);
    if (!match || match.index !== offset) throw new Error(`Invalid time token near "${compact.slice(offset)}".`);
    const amount = BigInt(match[1]!);
    if (amount <= 0n) throw new Error("Time amounts must be positive.");
    total += amount * UNIT_SECONDS[match[2]!]!;
    offset = token.lastIndex;
  }
  if (total <= 0n) throw new Error("Time must be greater than zero.");
  return { kind: "duration", seconds: total };
}

export function resolveStart(value: string | null, now = new Date()): Date {
  if (!value) return now;
  const parsed = parseTimeInput(value);
  const start = parsed.kind === "absolute" ? parsed.date : new Date(now.getTime() + Number(parsed.seconds * 1_000n));
  return start.getTime() <= now.getTime() ? now : start;
}

export function resolveEnd(durationInput: string, effectiveStart: Date): { durationSeconds?: string; absoluteEndAt?: string } {
  const parsed = parseTimeInput(durationInput);
  if (parsed.kind === "duration") return { durationSeconds: parsed.seconds.toString() };
  if (parsed.date.getTime() <= effectiveStart.getTime()) throw new Error("The end timestamp must be after the giveaway start.");
  return { absoluteEndAt: parsed.date.toISOString() };
}

export function unixSeconds(date: Date | string): bigint {
  return BigInt(Math.floor(new Date(date).getTime() / 1_000));
}
