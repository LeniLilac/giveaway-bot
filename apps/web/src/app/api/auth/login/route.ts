import { NextRequest, NextResponse } from "next/server";
import { pkceChallenge, randomToken, signPayload } from "../../../../lib/crypto";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const requestedReturn = request.nextUrl.searchParams.get("returnTo") ?? "/dashboard";
  const returnTo =
    requestedReturn.startsWith("/") && !requestedReturn.startsWith("//")
      ? requestedReturn
      : "/dashboard";
  const callback = `${process.env.PUBLIC_BASE_URL}/api/auth/callback`;
  const authorization = new URL("https://discord.com/oauth2/authorize");
  authorization.search = new URLSearchParams({
    client_id: process.env.DISCORD_APPLICATION_ID!,
    response_type: "code",
    redirect_uri: callback,
    scope: "identify guilds",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();

  const response = NextResponse.redirect(authorization);
  response.cookies.set(
    "lilac_oauth",
    signPayload({ state, verifier, returnTo, expiresAt: Date.now() + 10 * 60 * 1000 }),
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
