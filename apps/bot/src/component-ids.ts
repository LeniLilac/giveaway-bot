import { parseManagementAction, type ManagementAction } from "./action-policy.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PICKER_KINDS = ["start", "queue", "list", "reroll"] as const;

export type PickerKind = (typeof PICKER_KINDS)[number];

export type DraftComponentId =
  | { type: "cancel"; draftId: string }
  | { type: "create"; draftId: string }
  | { type: "roles"; value: "all" | "one"; draftId: string }
  | { type: "messages"; value: "all_time" | "since_start"; draftId: string };

export type GiveawayComponentId =
  | { type: "page"; kind: PickerKind; page: number }
  | { type: "action"; action: ManagementAction; giveawayId: string }
  | { type: "join" | "leave"; giveawayId: string };

function assertUuid(value: string | undefined, label: string): string {
  if (!value || !UUID.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function parsePickerKind(value: unknown): PickerKind {
  if (typeof value !== "string" || !PICKER_KINDS.includes(value as PickerKind)) {
    throw new Error("Unknown giveaway picker.");
  }
  return value as PickerKind;
}

export function parseDraftComponentId(customId: string): DraftComponentId {
  const parts = customId.split(":");
  if (parts[0] !== "draft") throw new Error("Invalid draft action.");
  if (parts[1] === "cancel" || parts[1] === "create") {
    if (parts.length !== 3) throw new Error("Invalid draft action.");
    return { type: parts[1], draftId: assertUuid(parts[2], "draft") };
  }
  if (parts[1] === "roles") {
    if (parts.length !== 4 || (parts[2] !== "all" && parts[2] !== "one")) {
      throw new Error("Invalid required-role choice.");
    }
    return {
      type: "roles",
      value: parts[2],
      draftId: assertUuid(parts[3], "draft"),
    };
  }
  if (parts[1] === "messages") {
    if (
      parts.length !== 4 ||
      (parts[2] !== "all_time" && parts[2] !== "since_start")
    ) {
      throw new Error("Invalid message-history choice.");
    }
    return {
      type: "messages",
      value: parts[2],
      draftId: assertUuid(parts[3], "draft"),
    };
  }
  throw new Error("Unknown draft action.");
}

export function parseGiveawayComponentId(customId: string): GiveawayComponentId {
  const parts = customId.split(":");
  if (parts[0] !== "giveaway") throw new Error("Invalid giveaway action.");
  if (parts[1] === "page") {
    if (parts.length !== 4 || !/^(?:0|[1-9]\d*)$/.test(parts[3] ?? "")) {
      throw new Error("Invalid giveaway page.");
    }
    const page = Number(parts[3]);
    if (!Number.isSafeInteger(page) || page < 0 || page > 100) {
      throw new Error("Invalid giveaway page.");
    }
    return { type: "page", kind: parsePickerKind(parts[2]), page };
  }
  if (parts[1] === "action") {
    if (parts.length !== 4) throw new Error("Invalid giveaway action.");
    return {
      type: "action",
      action: parseManagementAction(parts[2]),
      giveawayId: assertUuid(parts[3], "giveaway"),
    };
  }
  if (parts[1] === "join" || parts[1] === "leave") {
    if (parts.length !== 3) throw new Error("Invalid giveaway entry action.");
    return {
      type: parts[1],
      giveawayId: assertUuid(parts[2], "giveaway"),
    };
  }
  throw new Error("Unknown giveaway action.");
}

export function parseRerollModalId(customId: string): string {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "giveaway" || parts[1] !== "reroll") {
    throw new Error("Invalid reroll request.");
  }
  return assertUuid(parts[2], "giveaway");
}
