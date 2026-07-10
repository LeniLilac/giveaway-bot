import { NextRequest, NextResponse } from "next/server";
import { createSession } from "../../../../lib/auth";
import { encrypt, verifyPayload } from "../../../../lib/crypto";
import { db } from "../../../../lib/db";

interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const stored = request.cookies.get("lilac_oauth")?.value;
  const state = stored ? verifyPayload<OAuthState>(stored) : null;
  if (
    !state ||
    state.expiresAt < Date.now() ||
    state.state !== request.nextUrl.searchParams.get("state")
  ) {
    return NextResponse.redirect(new URL("/?auth=invalid", request.url));
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/?auth=denied", request.url));
  const callback = `${process.env.PUBLIC_BASE_URL}/api/auth/callback`;
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
  });
  if (!tokenResponse.ok) {
    return NextResponse.redirect(new URL("/?auth=exchange_failed", request.url));
  }
  const token = (await tokenResponse.json()) as TokenResponse;
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
  });
  if (!userResponse.ok) {
    return NextResponse.redirect(new URL("/?auth=user_failed", request.url));
  }
  const user = (await userResponse.json()) as DiscordUser;
  await db.query(
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
  await createSession(user.id);
  const response = NextResponse.redirect(new URL(state.returnTo, request.url));
  response.cookies.delete("lilac_oauth");
  return response;
}
