import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createSession } from "../../../../lib/auth";
import { encrypt, verifyPayload } from "../../../../lib/crypto";
import { db } from "../../../../lib/db";
import {
  authorizeOAuthIdentityAfterLock,
  databaseClockMillis,
  lockPrivacyIdentity,
} from "../../../../lib/privacy-lock";
import {
  publicApiClientKey,
  takePublicApiRateLimit,
} from "../../../../lib/public-api-control";
import { normalizeReturnTo } from "../../../../lib/return-to";

interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
  issuedAt: number;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

const DISCORD_REQUEST_TIMEOUT_MS = 10_000;

function terminalRedirect(path: string, publicBaseUrl: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, publicBaseUrl));
  response.cookies.set("lilac_oauth", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rate = takePublicApiRateLimit(publicApiClientKey(request.headers));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required at runtime.");
  const stored = request.cookies.get("lilac_oauth")?.value;
  const state = stored ? verifyPayload<OAuthState>(stored) : null;
  if (
    !state ||
    typeof state.state !== "string" ||
    typeof state.verifier !== "string" ||
    typeof state.returnTo !== "string" ||
    !Number.isSafeInteger(state.issuedAt) ||
    !Number.isSafeInteger(state.expiresAt) ||
    state.expiresAt < state.issuedAt ||
    state.expiresAt - state.issuedAt > 10 * 60 * 1000 ||
    state.state !== request.nextUrl.searchParams.get("state")
  ) {
    return terminalRedirect("/?auth=invalid", publicBaseUrl);
  }
  const now = await databaseClockMillis(db);
  if (state.issuedAt > now + 60_000 || state.expiresAt < now) {
    return terminalRedirect("/?auth=invalid", publicBaseUrl);
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return terminalRedirect("/?auth=denied", publicBaseUrl);
  const callback = new URL("/api/auth/callback", publicBaseUrl).toString();
  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_APPLICATION_ID!,
      client_secret: process.env.DISCORD_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      code_verifier: state.verifier,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!tokenResponse.ok) {
    return terminalRedirect("/?auth=exchange_failed", publicBaseUrl);
  }
  const token = (await tokenResponse.json()) as TokenResponse;
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!userResponse.ok) {
    return terminalRedirect("/?auth=user_failed", publicBaseUrl);
  }
  const user = (await userResponse.json()) as DiscordUser;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockPrivacyIdentity(client, user.id);
    if (!(await authorizeOAuthIdentityAfterLock(client, user.id, state.issuedAt))) {
      await client.query("ROLLBACK");
      return terminalRedirect("/privacy?deletion=active", publicBaseUrl);
    }
    await client.query(
      `INSERT INTO oauth_accounts (
         user_id, username, global_name, avatar_hash, access_token_ciphertext,
         refresh_token_ciphertext, expires_at, scope
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         username = EXCLUDED.username,
         global_name = EXCLUDED.global_name,
         avatar_hash = EXCLUDED.avatar_hash,
         access_token_ciphertext = EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         updated_at = now()`,
      [
        user.id,
        user.username,
        user.global_name,
        user.avatar,
        encrypt(token.access_token),
        token.refresh_token ? encrypt(token.refresh_token) : null,
        new Date(Date.now() + token.expires_in * 1000),
        token.scope,
      ],
    );
    await createSession(user.id, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const response = NextResponse.redirect(
    new URL(normalizeReturnTo(state.returnTo), publicBaseUrl),
  );
  response.cookies.set("lilac_oauth", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 0,
  });
  return response;
}
