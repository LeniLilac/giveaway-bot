import { randomUUID } from "node:crypto";
import type { DiscordMember } from "./discord.js";

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_USER_IDS_PER_REQUEST = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

interface MemberSnapshotResponseMember {
  userId: string;
  roles: string[];
  bot: boolean;
}

interface MemberSnapshotResponse {
  requestId: string;
  guildId: string;
  members: MemberSnapshotResponseMember[];
  notFoundIds: string[];
}

function groups<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function readResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Member snapshot response is too large.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Member snapshot response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function parseMember(value: unknown): MemberSnapshotResponseMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Member snapshot response contains an invalid member.");
  }
  const member = value as Record<string, unknown>;
  if (typeof member.userId !== "string" || !SNOWFLAKE.test(member.userId)) {
    throw new Error("Member snapshot response contains an invalid user ID.");
  }
  if (
    !Array.isArray(member.roles) ||
    !member.roles.every((roleId): roleId is string =>
      typeof roleId === "string" && SNOWFLAKE.test(roleId)
    ) ||
    new Set(member.roles).size !== member.roles.length
  ) {
    throw new Error("Member snapshot response contains invalid roles.");
  }
  if (typeof member.bot !== "boolean") {
    throw new Error("Member snapshot response contains an invalid bot flag.");
  }
  return { userId: member.userId, roles: member.roles, bot: member.bot };
}

function parseResponse(
  value: unknown,
  expectedRequestId: string,
  guildId: string,
  requestedUserIds: string[],
): MemberSnapshotResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Member snapshot response must be an object.");
  }
  const response = value as Record<string, unknown>;
  if (response.requestId !== expectedRequestId || response.guildId !== guildId) {
    throw new Error("Member snapshot response identity does not match the request.");
  }
  if (!Array.isArray(response.members) || !Array.isArray(response.notFoundIds)) {
    throw new Error("Member snapshot response is incomplete.");
  }
  const members = response.members.map(parseMember);
  const notFoundIds = response.notFoundIds;
  if (
    !notFoundIds.every((userId): userId is string =>
      typeof userId === "string" && SNOWFLAKE.test(userId)
    )
  ) {
    throw new Error("Member snapshot response contains an invalid missing user ID.");
  }
  const requested = new Set(requestedUserIds);
  const accountedFor = [...members.map((member) => member.userId), ...notFoundIds];
  if (
    new Set(accountedFor).size !== accountedFor.length ||
    accountedFor.length !== requested.size ||
    accountedFor.some((userId) => !requested.has(userId))
  ) {
    throw new Error("Member snapshot response does not account for every requested user.");
  }
  return {
    requestId: expectedRequestId,
    guildId,
    members,
    notFoundIds,
  };
}

export class MemberSnapshotClient {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs = 30_000,
  ) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("MEMBER_SNAPSHOT_URL must use HTTP or HTTPS.");
    }
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("INTERNAL_RPC_SECRET must contain at least 32 bytes.");
    }
  }

  async getMembers(
    guildId: string,
    userIds: string[],
  ): Promise<Map<string, DiscordMember | null>> {
    if (!SNOWFLAKE.test(guildId)) throw new Error("Member snapshot guild ID is invalid.");
    if (
      new Set(userIds).size !== userIds.length ||
      !userIds.every((userId) => SNOWFLAKE.test(userId))
    ) {
      throw new Error("Member snapshot user IDs are invalid.");
    }

    const result = new Map<string, DiscordMember | null>();
    for (const userIdGroup of groups(userIds, MAX_USER_IDS_PER_REQUEST)) {
      const requestId = randomUUID();
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId, guildId, userIds: userIdGroup }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(`Member snapshot service returned HTTP ${response.status}.`);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(body) as unknown;
      } catch {
        throw new Error("Member snapshot service returned invalid JSON.");
      }
      const snapshot = parseResponse(decoded, requestId, guildId, userIdGroup);
      for (const member of snapshot.members) {
        result.set(member.userId, {
          user: { id: member.userId, username: member.userId, bot: member.bot },
          roles: member.roles,
        });
      }
      for (const userId of snapshot.notFoundIds) result.set(userId, null);
    }
    if (result.size !== userIds.length) {
      throw new Error("Member snapshot did not resolve every requested user.");
    }
    return result;
  }
}
