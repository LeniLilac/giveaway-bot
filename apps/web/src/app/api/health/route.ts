import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import {
  publicApiClientKey,
  takePublicApiRateLimit,
} from "../../../lib/public-api-control";

const HEALTH_CACHE_MS = 1_000;
let cached: { ok: boolean; expiresAt: number } | null = null;
let inFlight: Promise<boolean> | null = null;

async function databaseHealthy(): Promise<boolean> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.ok;
  inFlight ??= db.query("SELECT 1").then(
    () => true,
    () => false,
  ).then((ok) => {
    cached = { ok, expiresAt: Date.now() + HEALTH_CACHE_MS };
    return ok;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function GET(request: Request): Promise<NextResponse> {
  const rate = takePublicApiRateLimit(publicApiClientKey(request.headers));
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, service: "web" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const ok = await databaseHealthy();
  return NextResponse.json(
    { ok, service: "web" },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
