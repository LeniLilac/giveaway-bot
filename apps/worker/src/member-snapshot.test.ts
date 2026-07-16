import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberSnapshotClient } from "./member-snapshot.js";

const guildId = "100000000000000000";
const secret = "internal-member-snapshot-test-secret-32-bytes";
const url = "http://bot:3003/internal/member-snapshot/v1";

function userId(index: number): string {
  return (300_000_000_000_000_000n + BigInt(index)).toString();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MemberSnapshotClient", () => {
  it("authenticates and accepts only a completely accounted response", async () => {
    const requested = [userId(1), userId(2)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.headers).toMatchObject({ authorization: `Bearer ${secret}` });
        const request = JSON.parse(String(init.body)) as {
          requestId: string;
          guildId: string;
          userIds: string[];
        };
        return new Response(
          JSON.stringify({
            requestId: request.requestId,
            guildId: request.guildId,
            members: [{ userId: requested[0], roles: [userId(90)], bot: false }],
            notFoundIds: [requested[1]],
          }),
          { status: 200 },
        );
      }),
    );

    const members = await new MemberSnapshotClient(url, secret).getMembers(
      guildId,
      requested,
    );

    expect(members.get(requested[0]!)).toEqual({
      user: { id: requested[0]!, username: requested[0]!, bot: false },
      roles: [userId(90)],
    });
    expect(members.get(requested[1]!)).toBeNull();
  });

  it("fails closed when the response omits a requested user", async () => {
    const requested = [userId(1), userId(2)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as { requestId: string };
        return new Response(
          JSON.stringify({
            requestId: request.requestId,
            guildId,
            members: [{ userId: requested[0], roles: [], bot: false }],
            notFoundIds: [],
          }),
          { status: 200 },
        );
      }),
    );

    await expect(
      new MemberSnapshotClient(url, secret).getMembers(guildId, requested),
    ).rejects.toThrow("does not account for every requested user");
  });

  it("splits very large participant sets without weakening accounting", async () => {
    const requested = Array.from({ length: 5_001 }, (_, index) => userId(index));
    const requestSizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          requestId: string;
          guildId: string;
          userIds: string[];
        };
        requestSizes.push(request.userIds.length);
        return new Response(
          JSON.stringify({
            requestId: request.requestId,
            guildId: request.guildId,
            members: [],
            notFoundIds: request.userIds,
          }),
          { status: 200 },
        );
      }),
    );

    const members = await new MemberSnapshotClient(url, secret).getMembers(
      guildId,
      requested,
    );

    expect(requestSizes).toEqual([5_000, 1]);
    expect(members.size).toBe(requested.length);
    expect([...members.values()].every((member) => member === null)).toBe(true);
  });
});
