const FALLBACK_RETURN_TO = "/dashboard";
const RETURN_TO_BASE = new URL("https://lilac.invalid");

export function normalizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return FALLBACK_RETURN_TO;
  }
  if (
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(value)
  ) {
    return FALLBACK_RETURN_TO;
  }

  try {
    const parsed = new URL(value, RETURN_TO_BASE);
    if (parsed.origin !== RETURN_TO_BASE.origin) return FALLBACK_RETURN_TO;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return FALLBACK_RETURN_TO;
  }
}
