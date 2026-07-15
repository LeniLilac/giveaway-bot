import { getPublicStats, type PublicStats } from "./queries";

const STATS_TTL_MS = 60_000;

let cached: { value: PublicStats; expiresAt: number } | null = null;
let inFlight: Promise<PublicStats> | null = null;

export async function getCachedPublicStats(now = Date.now()): Promise<PublicStats> {
  if (cached && cached.expiresAt > now) return cached.value;
  if (inFlight) return inFlight;

  inFlight = getPublicStats()
    .then((value) => {
      cached = { value, expiresAt: Date.now() + STATS_TTL_MS };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
