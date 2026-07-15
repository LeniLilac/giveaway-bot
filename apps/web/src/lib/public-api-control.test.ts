import { describe, expect, it } from "vitest";
import {
  getCachedPublicEvidence,
  parseBoundedPositiveInteger,
  PublicEvidenceBusyError,
  publicApiClientKey,
  takePublicApiRateLimit,
} from "./public-api-control";

describe("public evidence API controls", () => {
  it("bounds positive integer query parameters", () => {
    expect(parseBoundedPositiveInteger("20", 1, 250)).toBe(20);
    expect(parseBoundedPositiveInteger("999", 1, 250)).toBe(250);
    expect(parseBoundedPositiveInteger("-1", 3, 250)).toBe(3);
    expect(parseBoundedPositiveInteger("nope", 3, 250)).toBe(3);
  });

  it("uses a distinct overload error for saturated evidence work", () => {
    const error = new PublicEvidenceBusyError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PublicEvidenceBusyError");
  });

  it("uses the address appended by the trusted reverse proxy", () => {
    const headers = new Headers({ "x-forwarded-for": "spoofed, 203.0.113.9" });
    expect(publicApiClientKey(headers)).toBe("203.0.113.9");
  });

  it("limits a client within a fixed window", () => {
    const key = `test-${crypto.randomUUID()}`;
    for (let index = 0; index < 120; index += 1) {
      expect(takePublicApiRateLimit(key, 1_000).allowed).toBe(true);
    }
    expect(takePublicApiRateLimit(key, 1_000).allowed).toBe(false);
    expect(takePublicApiRateLimit(key, 61_001).allowed).toBe(true);
  });

  it("does not retain identity-bearing evidence after a load completes", async () => {
    let calls = 0;
    const key = `test-${crypto.randomUUID()}`;
    const load = () => getCachedPublicEvidence(key, async () => ++calls);
    await expect(load()).resolves.toBe(1);
    await expect(load()).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it("shares a genuinely concurrent in-flight load", async () => {
    let calls = 0;
    let resolve!: (value: number) => void;
    const pending = new Promise<number>((complete) => {
      resolve = complete;
    });
    const key = `test-${crypto.randomUUID()}`;
    const loader = async () => {
      calls += 1;
      return pending;
    };

    const first = getCachedPublicEvidence(key, loader);
    const second = getCachedPublicEvidence(key, loader);
    expect(calls).toBe(1);
    resolve(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(calls).toBe(1);
  });

  it("bounds distinct evidence loads globally", async () => {
    const releases: Array<(value: number) => void> = [];
    let calls = 0;
    const load = (key: string) =>
      getCachedPublicEvidence(key, async () => {
        calls += 1;
        return new Promise<number>((resolve) => releases.push(resolve));
      });

    const first = load(`test-${crypto.randomUUID()}`);
    const second = load(`test-${crypto.randomUUID()}`);
    const third = load(`test-${crypto.randomUUID()}`);
    expect(calls).toBe(1);
    releases.shift()!(1);
    await first;
    await Promise.resolve();
    expect(calls).toBe(2);
    releases.shift()!(2);
    await second;
    await Promise.resolve();
    expect(calls).toBe(3);
    releases.shift()!(3);
    await expect(third).resolves.toBe(3);
  });

  it("releases the evidence slot when a loader fails", async () => {
    const failed = getCachedPublicEvidence(
      `test-${crypto.randomUUID()}`,
      async () => {
        throw new Error("database timeout");
      },
    );
    await expect(failed).rejects.toThrow("database timeout");
    await expect(
      getCachedPublicEvidence(`test-${crypto.randomUUID()}`, async () => 42),
    ).resolves.toBe(42);
  });
});
