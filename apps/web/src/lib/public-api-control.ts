const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_KEYS = 10_000;
// One evidence loader holds a pool client across a multi-query, repeatable-read
// snapshot. Keeping only one active bounds that work and reserves web-pool
// capacity for OAuth and authenticated actions.
const MAX_ACTIVE_EVIDENCE_LOADS = 1;
const MAX_QUEUED_EVIDENCE_LOADS = 32;

export class PublicEvidenceBusyError extends Error {
  constructor() {
    super("Public evidence is busy. Try again shortly.");
    this.name = "PublicEvidenceBusyError";
  }
}

interface RateWindow {
  count: number;
  resetAt: number;
}

const rateWindows = new Map<string, RateWindow>();
const inFlightEvidence = new Map<string, Promise<unknown>>();
const evidenceQueue: Array<{
  loader: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}> = [];
let activeEvidenceLoads = 0;

function drainEvidenceQueue(): void {
  while (activeEvidenceLoads < MAX_ACTIVE_EVIDENCE_LOADS) {
    const next = evidenceQueue.shift();
    if (!next) return;
    startEvidenceLoad(next.loader).then(next.resolve, next.reject);
  }
}

function startEvidenceLoad<T>(loader: () => Promise<T>): Promise<T> {
  activeEvidenceLoads += 1;
  let loaded: Promise<T>;
  try {
    loaded = loader();
  } catch (error) {
    activeEvidenceLoads -= 1;
    drainEvidenceQueue();
    return Promise.reject(error);
  }
  return loaded.finally(() => {
    activeEvidenceLoads -= 1;
    drainEvidenceQueue();
  });
}

function scheduleEvidenceLoad<T>(loader: () => Promise<T>): Promise<T> {
  if (activeEvidenceLoads < MAX_ACTIVE_EVIDENCE_LOADS) {
    return startEvidenceLoad(loader);
  }
  if (evidenceQueue.length >= MAX_QUEUED_EVIDENCE_LOADS) {
    return Promise.reject(new PublicEvidenceBusyError());
  }
  return new Promise<T>((resolve, reject) => {
    evidenceQueue.push({
      loader,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
  });
}

export function parseBoundedPositiveInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/u.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function publicApiClientKey(headers: Pick<Headers, "get">): string {
  const forwarded = headers.get("x-forwarded-for");
  const forwardedAddress = forwarded?.split(",").at(-1)?.trim();
  return (forwardedAddress || headers.get("x-real-ip") || "unknown").slice(0, 128);
}

export function takePublicApiRateLimit(
  key: string,
  now = Date.now(),
): { allowed: boolean; limit: number; remaining: number; resetAt: number } {
  let window = rateWindows.get(key);
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateWindows.set(key, window);
  }
  window.count += 1;

  if (rateWindows.size > MAX_RATE_KEYS) {
    for (const [candidate, candidateWindow] of rateWindows) {
      if (candidateWindow.resetAt <= now || rateWindows.size > MAX_RATE_KEYS) {
        rateWindows.delete(candidate);
      }
    }
  }

  return {
    allowed: window.count <= RATE_LIMIT,
    limit: RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - window.count),
    resetAt: window.resetAt,
  };
}

export async function getCachedPublicEvidence<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = inFlightEvidence.get(key);
  if (existing) return existing as Promise<T>;

  const pending = scheduleEvidenceLoad(loader).finally(() => {
    if (inFlightEvidence.get(key) === pending) inFlightEvidence.delete(key);
  });
  inFlightEvidence.set(key, pending);
  return pending;
}
