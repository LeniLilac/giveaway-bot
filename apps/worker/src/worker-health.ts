export const MAX_IDLE_POLL_AGE_MS = 30_000;
export const MAX_LEASE_HEARTBEAT_AGE_MS = 90_000;

export interface ActiveJobHealth {
  jobId: string;
  lockToken: string;
  lastLeaseHeartbeatAt: number;
  leaseLost: boolean;
}

export interface WorkerHealthState {
  lastSuccessfulPollAt: number;
  activeJob: ActiveJobHealth | null;
}

export function assertWorkerHealthy(
  state: WorkerHealthState,
  now = Date.now(),
): void {
  if (!state.activeJob) {
    if (now - state.lastSuccessfulPollAt > MAX_IDLE_POLL_AGE_MS) {
      throw new Error("Worker poll loop is stale.");
    }
    return;
  }

  if (state.activeJob.leaseLost) {
    throw new Error("Active job lease was lost.");
  }
  if (
    now - state.activeJob.lastLeaseHeartbeatAt >
    MAX_LEASE_HEARTBEAT_AGE_MS
  ) {
    throw new Error("Active job lease heartbeat is stale.");
  }
}
