import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMessageSearchStateForTests,
  searchMessageCount,
} from "./message-search.js";

function jsonResponse(status: number, body: object, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Discord message search", () => {
  beforeEach(async () => {
    await Promise.resolve();
    resetMessageSearchStateForTests();
  });

  it("retries HTTP 202 indexing responses using the declared delay", async () => {
    const responses = [
      jsonResponse(202, { retry_after: 0.25 }),
      jsonResponse(200, { total_results: 12 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(
      searchMessageCount("token", "100000000000000001", "100000000000000002", null, {
        fetchImpl,
        sleep,
      }),
    ).resolves.toBe(12);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries HTTP 429 and respects Retry-After", async () => {
    let now = 1_000;
    const responses = [
      jsonResponse(429, {}, { "retry-after": "0.5" }),
      jsonResponse(200, { total_results: 1 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    await expect(
      searchMessageCount("token", "100000000000000001", "100000000000000002", null, {
        fetchImpl,
        sleep,
        now: () => now,
      }),
    ).resolves.toBe(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("fails without retrying early when Discord declares a long delay", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { retry_after: 30 }),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(
      searchMessageCount("token", "100000000000000001", "100000000000000002", null, {
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("wait 30 seconds");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds repeated indexing and rate-limit retries", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(202, { retry_after: 0 }),
    ) as unknown as typeof fetch;

    await expect(
      searchMessageCount("token", "100000000000000001", "100000000000000002", null, {
        fetchImpl,
        sleep: async () => undefined,
        maxAttempts: 2,
      }),
    ).rejects.toThrow("indexing or rate-limiting");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed success payloads instead of treating them as zero", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {}),
    ) as unknown as typeof fetch;
    await expect(
      searchMessageCount("token", "100000000000000001", "100000000000000002", null, {
        fetchImpl,
      }),
    ).rejects.toThrow("invalid message-search result");
  });

  it("coalesces concurrent searches for the same member and time window", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const first = searchMessageCount(
      "token",
      "100000000000000001",
      "100000000000000002",
      null,
      { fetchImpl },
    );
    const second = searchMessageCount(
      "token",
      "100000000000000001",
      "100000000000000002",
      null,
      { fetchImpl },
    );

    expect(second).toBe(first);
    release(jsonResponse(200, { total_results: 4 }));
    await expect(Promise.all([first, second])).resolves.toEqual([4, 4]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent searches per guild", async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    ) as unknown as typeof fetch;
    const searches = ["2", "3", "4"].map((suffix) =>
      searchMessageCount(
        "token",
        "100000000000000001",
        `10000000000000000${suffix}`,
        null,
        { fetchImpl },
      ),
    );
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    releases.shift()!(jsonResponse(200, { total_results: 1 }));
    await searches[0];
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const release of releases.splice(0)) {
      release(jsonResponse(200, { total_results: 1 }));
    }
    await Promise.all(searches);
  });

  it("limits concurrent searches globally", async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    ) as unknown as typeof fetch;
    const searches = ["1", "2", "3", "4", "5"].map((suffix) =>
      searchMessageCount(
        "token",
        `10000000000000000${suffix}`,
        `20000000000000000${suffix}`,
        null,
        { fetchImpl },
      ),
    );
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    releases.shift()!(jsonResponse(200, { total_results: 1 }));
    await searches[0];
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const release of releases.splice(0)) {
      release(jsonResponse(200, { total_results: 1 }));
    }
    await Promise.all(searches);
  });

  it("shares guild and global 429 cooldowns without exposing the token", async () => {
    let now = 1_000;
    const firstFetch = vi.fn(async () =>
      jsonResponse(429, { retry_after: 0.25 }),
    ) as unknown as typeof fetch;
    await expect(
      searchMessageCount("secret-token", "100000000000000001", "200000000000000001", null, {
        fetchImpl: firstFetch,
        maxAttempts: 1,
        now: () => now,
      }),
    ).rejects.toThrow("rate-limiting");
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const secondFetchMock = vi
      .fn<(url: string | URL | Request) => Promise<Response>>()
      .mockImplementation(async () => jsonResponse(200, { total_results: 2 }));
    const secondFetch = secondFetchMock as unknown as typeof fetch;
    await expect(
      searchMessageCount("secret-token", "100000000000000001", "200000000000000002", null, {
        fetchImpl: secondFetch,
        sleep,
        now: () => now,
      }),
    ).resolves.toBe(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(String(secondFetchMock.mock.calls[0]?.[0])).not.toContain("secret-token");

    const globalFetch = vi.fn(async () =>
      jsonResponse(429, { retry_after: 0.1, global: true }),
    ) as unknown as typeof fetch;
    await expect(
      searchMessageCount("secret-token", "100000000000000003", "200000000000000003", null, {
        fetchImpl: globalFetch,
        maxAttempts: 1,
        now: () => now,
      }),
    ).rejects.toThrow("rate-limiting");
    const otherGuildSleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    await expect(
      searchMessageCount("secret-token", "100000000000000004", "200000000000000004", null, {
        fetchImpl: secondFetch,
        sleep: otherGuildSleep,
        now: () => now,
      }),
    ).resolves.toBe(2);
    expect(otherGuildSleep).toHaveBeenCalledWith(100);
  });

  it("caches successful counts only for a short TTL", async () => {
    let now = 10_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { total_results: 7 }),
    ) as unknown as typeof fetch;
    const run = () =>
      searchMessageCount("token", "100000000000000001", "200000000000000001", null, {
        fetchImpl,
        now: () => now,
      });
    await expect(run()).resolves.toBe(7);
    now += 4_999;
    await expect(run()).resolves.toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    await expect(run()).resolves.toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
