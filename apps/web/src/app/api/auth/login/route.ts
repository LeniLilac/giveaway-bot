import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { pkceChallenge, randomToken, signPayload } from "../../../../lib/crypto";
import { db } from "../../../../lib/db";
import { databaseClockMillis } from "../../../../lib/privacy-lock";
import {
  publicApiClientKey,
  takePublicApiRateLimit,
} from "../../../../lib/public-api-control";
import { normalizeReturnTo } from "../../../../lib/return-to";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rate = takePublicApiRateLimit(publicApiClientKey(request.headers));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  const issuedAt = await databaseClockMillis(db);
  const returnTo = normalizeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required at runtime.");
  const callback = new URL("/api/auth/callback", publicBaseUrl).toString();
  const authorization = new URL("https://discord.com/oauth2/authorize");
  authorization.search = new URLSearchParams({
    client_id: process.env.DISCORD_APPLICATION_ID!,
    response_type: "code",
    redirect_uri: callback,
    scope: "identify guilds guilds.members.read",
    prompt: "consent",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();

  const response = NextResponse.redirect(authorization);
  response.cookies.set(
    "lilac_oauth",
    signPayload({
      state,
      verifier,
      returnTo,
      issuedAt,
      expiresAt: issuedAt + 10 * 60 * 1000,
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/auth",
      maxAge: 10 * 60,
    },
  );
  return response;
}
