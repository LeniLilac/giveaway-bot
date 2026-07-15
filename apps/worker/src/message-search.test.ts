import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMessageSearchStateForTests,
  searchMessageCount,
} from "./message-search.js";

function response(status: number, body: object, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) });
}

describe("worker Discord message search", () => {
  beforeEach(() => resetMessageSearchStateForTests());

  it("retries indexing and rate-limit responses using retry_after", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(202, { retry_after: 0.1 }))
      .mockResolvedValueOnce(response(429, { retry_after: 0.2 }))
      .mockResolvedValueOnce(response(200, { total_results: 7 })) as typeof fetch;
    const sleep = vi.fn(async (delay: number) => {
      now += delay;
    });
    await expect(searchMessageCount(
      "token",
      "100000000000000001",
      "100000000000000002",
      null,
      { fetchImpl, sleep, now: () => now },
    )).resolves.toBe(7);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("times out a fetch implementation that ignores abort", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;
    await expect(searchMessageCount(
      "token",
      "100000000000000003",
      "100000000000000004",
      null,
      { fetchImpl, requestTimeoutMs: 10 },
    )).rejects.toThrow("timed out");
  });

  it("uses the exact start timestamp as the minimum Discord snowflake", async () => {
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => response(200, { total_results: 1 }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const since = new Date("2026-01-02T03:04:05.000Z");
    await searchMessageCount(
      "token",
      "100000000000000005",
      "100000000000000006",
      since,
      { fetchImpl },
    );
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    const expected = ((BigInt(since.getTime()) - 1_420_070_400_000n) << 22n).toString();
    expect(url.searchParams.get("min_id")).toBe(expected);
  });

  it("fails closed on malformed successful results", async () => {
    const fetchImpl = vi.fn(async () => response(200, {})) as typeof fetch;
    await expect(searchMessageCount(
      "token",
      "100000000000000007",
      "100000000000000008",
      null,
      { fetchImpl },
    )).rejects.toThrow("invalid message-search result");
  });
});
