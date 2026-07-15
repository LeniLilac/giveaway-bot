import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Pool, PoolClient } from "pg";
import { decrypt, encrypt, hash, randomToken } from "./crypto";
import { db } from "./db";

const SESSION_COOKIE = "lilac_session";
const DISCORD_REQUEST_TIMEOUT_MS = 10_000;

export interface SessionUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date;
  scope: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export interface DiscordGuildMember {
  roles: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function createSession(
  userId: string,
  client: Pick<Pool | PoolClient, "query"> = db,
): Promise<void> {
  const token = randomToken();
  await client.query(
    `INSERT INTO web_sessions (id_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [hash(token), userId],
  );
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.query("DELETE FROM web_sessions WHERE id_hash = $1", [hash(token)]);
  jar.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = await db.query(
    `SELECT a.*, s.expires_at AS session_expires_at
     FROM web_sessions s
     JOIN oauth_accounts a ON a.user_id = s.user_id
     WHERE s.id_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  await db.query("UPDATE web_sessions SET last_seen_at = now() WHERE id_hash = $1", [
    hash(token),
  ]);
  return {
    id: row.user_id as string,
    username: row.username as string,
    globalName: (row.global_name as string | null) ?? null,
    avatarHash: (row.avatar_hash as string | null) ?? null,
    accessToken: decrypt(row.access_token_ciphertext as string),
    refreshToken: row.refresh_token_ciphertext
      ? decrypt(row.refresh_token_ciphertext as string)
      : null,
    tokenExpiresAt: new Date(row.expires_at as string),
    scope: row.scope as string,
  };
}

export async function requireSession(returnTo = "/dashboard"): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  return session;
}

async function refreshDiscordToken(session: SessionUser): Promise<SessionUser> {
  if (!session.refreshToken) return session;
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_APPLICATION_ID!,
      client_secret: process.env.DISCORD_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Discord OAuth token refresh failed.");
  const token = (await response.json()) as TokenResponse;
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  await db.query(
    `UPDATE oauth_accounts SET access_token_ciphertext = $2,
       refresh_token_ciphertext = $3, expires_at = $4, scope = $5, updated_at = now()
     WHERE user_id = $1`,
    [
      session.id,
      encrypt(token.access_token),
      token.refresh_token
        ? encrypt(token.refresh_token)
        : session.refreshToken
          ? encrypt(session.refreshToken)
          : null,
      expiresAt,
      token.scope,
    ],
  );
  Object.assign(session, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? session.refreshToken,
    tokenExpiresAt: expiresAt,
    scope: token.scope,
  });
  return session;
}

export async function getDiscordGuilds(session: SessionUser): Promise<DiscordGuild[]> {
  const current =
    session.tokenExpiresAt.getTime() < Date.now() + 60_000
      ? await refreshDiscordToken(session)
      : session;
  const response = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bearer ${current.accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Could not load Discord servers.");
  return (await response.json()) as DiscordGuild[];
}

export async function getCurrentDiscordGuildMember(
  session: SessionUser,
  guildId: string,
): Promise<DiscordGuildMember | null> {
  const current =
    session.tokenExpiresAt.getTime() < Date.now() + 60_000
      ? await refreshDiscordToken(session)
      : session;
  const response = await fetch(
    `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`,
    {
      headers: { Authorization: `Bearer ${current.accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Discord role access is missing or expired. Sign out, sign in again, and approve the requested access.",
    );
  }
  if (!response.ok) throw new Error("Could not verify your current Discord roles.");
  const member = (await response.json()) as Partial<DiscordGuildMember>;
  if (!Array.isArray(member.roles) || member.roles.some((role) => typeof role !== "string")) {
    throw new Error("Discord returned invalid server role data.");
  }
  return { roles: member.roles };
}

export function canManageGuild(guild: DiscordGuild): boolean {
  const permissions = BigInt(guild.permissions);
  return guild.owner || (permissions & 0x8n) === 0x8n || (permissions & 0x20n) === 0x20n;
}

export function avatarUrl(user: {
  id: string;
  avatarHash: string | null;
}): string {
  if (user.avatarHash) {
    const extension = user.avatarHash.startsWith("a_") ? "gif" : "webp";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatarHash}.${extension}?size=128`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
}
