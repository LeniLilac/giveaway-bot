import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Client, GuildMember } from "discord.js";
import type { Logger } from "pino";

export const MEMBER_SNAPSHOT_PATH = "/internal/member-snapshot/v1";
export const MEMBER_SNAPSHOT_MAX_USER_IDS = 5_000;

const MAX_REQUEST_BYTES = 256 * 1024;
const GATEWAY_BATCH_SIZE = 100;
const GATEWAY_BATCH_CONCURRENCY = 4;
const GATEWAY_BATCH_TIMEOUT_MS = 15_000;
const SNOWFLAKE = /^\d{17,20}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MemberSnapshotRecord {
  userId: string;
  roles: string[];
  bot: boolean;
}

export interface MemberSnapshotResult {
  members: MemberSnapshotRecord[];
  notFoundIds: string[];
}

interface MemberSnapshotRequest {
  requestId: string;
  guildId: string;
  userIds: string[];
}

interface MemberSnapshotServerOptions {
  port: number;
  secret: string;
  client: Client;
  logger: Logger;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function authorized(request: IncomingMessage, secret: string): boolean {
  const supplied = request.headers.authorization;
  if (!supplied) return false;
  const expectedBytes = Buffer.from(`Bearer ${secret}`, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "Member snapshot request is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(value: unknown): MemberSnapshotRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Member snapshot request must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) {
    throw new HttpError(400, "Member snapshot request ID is invalid.");
  }
  if (typeof input.guildId !== "string" || !SNOWFLAKE.test(input.guildId)) {
    throw new HttpError(400, "Member snapshot guild ID is invalid.");
  }
  if (!Array.isArray(input.userIds) || input.userIds.length > MEMBER_SNAPSHOT_MAX_USER_IDS) {
    throw new HttpError(400, "Member snapshot user IDs are invalid.");
  }
  const userIds = input.userIds;
  if (!userIds.every((userId): userId is string => typeof userId === "string" && SNOWFLAKE.test(userId))) {
    throw new HttpError(400, "Member snapshot contains an invalid user ID.");
  }
  if (new Set(userIds).size !== userIds.length) {
    throw new HttpError(400, "Member snapshot user IDs must be unique.");
  }
  return { requestId: input.requestId, guildId: input.guildId, userIds };
}

function batches<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await operation(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function memberRecord(member: GuildMember): MemberSnapshotRecord {
  return {
    userId: member.id,
    roles: [...member.roles.cache.keys()].filter((roleId) => roleId !== member.guild.id),
    bot: member.user.bot,
  };
}

export async function fetchGatewayMemberSnapshot(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<MemberSnapshotResult> {
  if (!client.isReady()) throw new HttpError(503, "Discord gateway is not ready.");
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new HttpError(503, "Discord guild is unavailable.");
  if (userIds.length === 0) return { members: [], notFoundIds: [] };

  const groups = batches(userIds, GATEWAY_BATCH_SIZE);
  const requested = new Set(userIds);
  const collections = await mapConcurrent(groups, GATEWAY_BATCH_CONCURRENCY, (userBatch) =>
    guild.members.fetch({ user: userBatch, time: GATEWAY_BATCH_TIMEOUT_MS }),
  );
  const found = new Map<string, MemberSnapshotRecord>();
  for (const collection of collections) {
    for (const member of collection.values()) {
      if (requested.has(member.id)) found.set(member.id, memberRecord(member));
    }
  }
  return {
    members: userIds.flatMap((userId) => {
      const member = found.get(userId);
      return member ? [member] : [];
    }),
    notFoundIds: userIds.filter((userId) => !found.has(userId)),
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export function startMemberSnapshotServer(options: MemberSnapshotServerOptions): Server {
  if (Buffer.byteLength(options.secret, "utf8") < 32) {
    throw new Error("INTERNAL_RPC_SECRET must contain at least 32 bytes.");
  }
  const server = createServer(async (request, response) => {
    if (request.url !== MEMBER_SNAPSHOT_PATH) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (!authorized(request, options.secret)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return;
    }

    let input: MemberSnapshotRequest | null = null;
    const startedAt = Date.now();
    try {
      const body = await readRequestBody(request);
      let decoded: unknown;
      try {
        decoded = JSON.parse(body) as unknown;
      } catch {
        throw new HttpError(400, "Member snapshot request contains invalid JSON.");
      }
      input = parseRequest(decoded);
      const snapshot = await fetchGatewayMemberSnapshot(
        options.client,
        input.guildId,
        input.userIds,
      );
      options.logger.info(
        {
          guildId: input.guildId,
          requestedMemberCount: input.userIds.length,
          resolvedMemberCount: snapshot.members.length,
          durationMs: Date.now() - startedAt,
        },
        "gateway member snapshot completed",
      );
      sendJson(response, 200, {
        requestId: input.requestId,
        guildId: input.guildId,
        ...snapshot,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      options.logger.error(
        {
          error,
          guildId: input?.guildId,
          requestedMemberCount: input?.userIds.length,
          durationMs: Date.now() - startedAt,
        },
        "gateway member snapshot failed",
      );
      sendJson(response, status, { error: "Member snapshot could not be completed." });
    }
  });
  server.listen(options.port, "0.0.0.0");
  return server;
}
