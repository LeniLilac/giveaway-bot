import type { GiveawayStatus } from "./repository.js";

export const MANAGEMENT_ACTIONS = ["start", "end", "reroll", "delete"] as const;
export type ManagementAction = (typeof MANAGEMENT_ACTIONS)[number];

export const ACTION_STATUSES = {
  start: ["queued"],
  end: ["active"],
  reroll: ["ended"],
  delete: ["queued", "active", "ended", "error"],
} as const satisfies Record<ManagementAction, readonly GiveawayStatus[]>;

export const ACTION_JOB_TYPES = {
  start: "start_giveaway",
  end: "end_giveaway",
  reroll: "reroll_giveaway",
  delete: "delete_giveaway",
} as const;

export function parseManagementAction(value: unknown): ManagementAction {
  if (
    typeof value !== "string" ||
    !MANAGEMENT_ACTIONS.includes(value as ManagementAction)
  ) {
    throw new Error("Unknown giveaway action.");
  }
  return value as ManagementAction;
}

export function assertActionAllowed(
  action: ManagementAction,
  status: GiveawayStatus,
): void {
  const allowed = ACTION_STATUSES[action] as readonly GiveawayStatus[];
  if (!allowed.includes(status)) {
    throw new Error(`This giveaway cannot be ${action}ed while it is ${status}.`);
  }
}
