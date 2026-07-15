export const INT32_MAX = 2_147_483_647;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parseNonNegativeInt32(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= INT32_MAX
    ? parsed
    : null;
}

export function parsePositiveInt32(value: string | null | undefined): number | null {
  const parsed = parseNonNegativeInt32(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
