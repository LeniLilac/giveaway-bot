import { describe, expect, it } from "vitest";
import {
  assertWorkerHealthy,
  MAX_IDLE_POLL_AGE_MS,
  MAX_LEASE_HEARTBEAT_AGE_MS,
  type WorkerHealthState,
} from "./worker-health.js";

const activeState = (now: number): WorkerHealthState => ({
  lastSuccessfulPollAt: now - MAX_IDLE_POLL_AGE_MS - 1,
  activeJob: {
    jobId: "job-1",
    lockToken: "lease-1",
    lastLeaseHeartbeatAt: now,
    leaseLost: false,
  },
});

describe("worker health", () => {
  it("rejects a stale idle poll loop", () => {
    const now = 100_000;

    expect(() =>
      assertWorkerHealthy(
        { lastSuccessfulPollAt: now - MAX_IDLE_POLL_AGE_MS - 1, activeJob: null },
        now,
      ),
    ).toThrow("Worker poll loop is stale.");
  });

  it("keeps a long-running job healthy while its lease heartbeat is fresh", () => {
    const now = 100_000;

    expect(() => assertWorkerHealthy(activeState(now), now)).not.toThrow();
  });

  it("rejects an active job with a stale lease heartbeat", () => {
    const now = 100_000;
    const state = activeState(now);
    state.activeJob!.lastLeaseHeartbeatAt = now - MAX_LEASE_HEARTBEAT_AGE_MS - 1;

    expect(() => assertWorkerHealthy(state, now)).toThrow(
      "Active job lease heartbeat is stale.",
    );
  });

  it("rejects a lost active job lease immediately", () => {
    const now = 100_000;
    const state = activeState(now);
    state.activeJob!.leaseLost = true;

    expect(() => assertWorkerHealthy(state, now)).toThrow(
      "Active job lease was lost.",
    );
  });
});
