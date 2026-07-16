import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Client, GuildMember } from "discord.js";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchGatewayMemberSnapshot,
  MEMBER_SNAPSHOT_PATH,
  startMemberSnapshotServer,
} from "./member-snapshot-server.js";

const guildId = "100000000000000000";
const roleId = "200000000000000000";
const secret = "internal-member-snapshot-test-secret-32-bytes";
const logger = pino({ level: "silent" });
const servers = new Set<ReturnType<typeof startMemberSnapshotServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

function userId(index: number): string {
  return (300_000_000_000_000_000n + BigInt(index)).toString();
}

function fakeMember(id: string): GuildMember {
  return {
    id,
    guild: { id: guildId },
    user: { bot: false },
    roles: { cache: new Map([[guildId, {}], [roleId, {}]]) },
  } as unknown as GuildMember;
}

function fakeClient(
  fetchBatch: (ids: string[]) => Promise<Map<string, GuildMember>>,
): Client {
  return {
    isReady: () => true,
    guilds: {
      cache: new Map([
        [
          guildId,
          {
            members: {
              fetch: ({ user }: { user: string[] }) => fetchBatch(user),
            },
          },
        ],
      ]),
    },
  } as unknown as Client;
}

async function serverUrl(server: ReturnType<typeof startMemberSnapshotServer>): Promise<string> {
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${MEMBER_SNAPSHOT_PATH}`;
}

describe("gateway member snapshots", () => {
  it("fetches exact member IDs in bounded Gateway batches", async () => {
    const requested = Array.from({ length: 250 }, (_, index) => userId(index));
    const calls: string[][] = [];
    const client = fakeClient(async (ids) => {
      calls.push(ids);
      return new Map(ids.map((id) => [id, fakeMember(id)]));
    });

    const snapshot = await fetchGatewayMemberSnapshot(client, guildId, requested);

    expect(calls.map((call) => call.length).sort((left, right) => right - left)).toEqual([
      100,
      100,
      50,
    ]);
    expect(snapshot.members).toHaveLength(250);
    expect(snapshot.members[0]).toEqual({ userId: requested[0], roles: [roleId], bot: false });
    expect(snapshot.notFoundIds).toEqual([]);
  });

  it("accounts for members Discord reports as missing", async () => {
    const requested = [userId(1), userId(2), userId(3)];
    const client = fakeClient(async (ids) =>
      new Map(ids.filter((id) => id !== requested[1]).map((id) => [id, fakeMember(id)])),
    );

    const snapshot = await fetchGatewayMemberSnapshot(client, guildId, requested);

    expect(snapshot.members.map((member) => member.userId)).toEqual([
      requested[0],
      requested[2],
    ]);
    expect(snapshot.notFoundIds).toEqual([requested[1]]);
  });
});

describe("member snapshot server", () => {
  it("requires the internal bearer secret", async () => {
    let fetches = 0;
    const server = startMemberSnapshotServer({
      port: 0,
      secret,
      client: fakeClient(async () => {
        fetches += 1;
        return new Map();
      }),
      logger,
    });
    servers.add(server);

    const response = await fetch(await serverUrl(server), {
      method: "POST",
      headers: { authorization: "Bearer incorrect-secret" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), guildId, userIds: [] }),
    });

    expect(response.status).toBe(401);
    expect(fetches).toBe(0);
  });

  it("returns a completely accounted fresh snapshot", async () => {
    const requested = [userId(10), userId(11)];
    const server = startMemberSnapshotServer({
      port: 0,
      secret,
      client: fakeClient(async (ids) =>
        new Map(ids.slice(0, 1).map((id) => [id, fakeMember(id)])),
      ),
      logger,
    });
    servers.add(server);
    const requestId = crypto.randomUUID();

    const response = await fetch(await serverUrl(server), {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId, guildId, userIds: requested }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      requestId,
      guildId,
      members: [{ userId: requested[0], roles: [roleId], bot: false }],
      notFoundIds: [requested[1]],
    });
  });
});
