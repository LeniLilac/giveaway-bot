export const COMMAND_NAMES = ["create", "start", "end", "reroll", "delete", "queue", "list"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export type GiveawayStatus = "queued" | "starting" | "active" | "closing" | "ended" | "deleted" | "failed";
export type RequiredRoleMode = "all" | "one";
export type MessageWindow = "all_time" | "since_start";

export interface BonusRole { roleId: string; bonus: string; }

export interface GiveawayDraftPayload {
  guildId: string;
  channelId: string;
  creatorId: string;
  hostId: string;
  prize: string;
  winnerCount: string;
  scheduledStartAt: string;
  durationSeconds?: string;
  absoluteEndAt?: string;
  requiredMessageCount?: string;
  messageWindow?: MessageWindow;
  requiredRoleMode?: RequiredRoleMode;
  requiredRoleIds: string[];
  prizeRoleIds: string[];
  bonusRoles: BonusRole[];
}

export interface GiveawayRecord extends GiveawayDraftPayload {
  id: string;
  messageId: string | null;
  status: GiveawayStatus;
  startedAt: string | null;
  endsAt: string | null;
  closedAt: string | null;
  endedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface EntryRecord {
  giveawayId: string;
  userId: string;
  username: string | null;
  avatarUrl: string | null;
  joinedAt: string;
  leftAt: string | null;
  active: boolean;
  messageCountAtJoin: string | null;
  roleIds: string[];
  roleVerifiedAt: string;
}

export interface PermissionSnapshot {
  isOwner: boolean;
  permissions: bigint;
  roleIds: string[];
}
