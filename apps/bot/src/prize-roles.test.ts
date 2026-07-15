import { describe, expect, it } from "vitest";
import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  PermissionsBitField,
} from "discord.js";
import { assertPrizeRolesAwardable } from "./prize-roles.js";

interface FakeRole {
  id: string;
  name: string;
  editable: boolean;
  position: number;
  comparePositionTo(other: FakeRole): number;
}

function fakeRole(
  id: string,
  name: string,
  position: number,
  editable = true,
): FakeRole {
  return {
    id,
    name,
    editable,
    position,
    comparePositionTo(other) {
      return position - other.position;
    },
  };
}

function interaction(options: {
  userId?: string;
  ownerId?: string;
  permissions?: bigint;
  memberRoleIds?: string[] | null;
  roles?: FakeRole[];
} = {}): ChatInputCommandInteraction | ButtonInteraction {
  const guildId = "100000000000000001";
  const everyone = fakeRole(guildId, "@everyone", 0);
  const roles = new Map(
    [everyone, ...(options.roles ?? [])].map((role) => [role.id, role]),
  );
  const memberRoleIds = options.memberRoleIds === undefined
    ? ["100000000000000002"]
    : options.memberRoleIds;
  return {
    guild: {
      id: guildId,
      ownerId: options.ownerId ?? "100000000000000099",
      roles: { cache: roles, everyone },
    },
    member:
      memberRoleIds === null
        ? null
        : {
            permissions: String(options.permissions ?? PermissionsBitField.Flags.ManageRoles),
            roles: memberRoleIds,
          },
    user: { id: options.userId ?? "100000000000000010" },
  } as unknown as ChatInputCommandInteraction;
}

const creatorRole = fakeRole("100000000000000002", "Creator", 20);
const lowerPrize = fakeRole("100000000000000003", "Member", 10);
const higherPrize = fakeRole("100000000000000004", "Moderator", 30);

describe("prize role authorization", () => {
  it("does not require guild context when no prize roles are configured", () => {
    expect(() =>
      assertPrizeRolesAwardable({} as ChatInputCommandInteraction, []),
    ).not.toThrow();
  });

  it("requires effective Manage Roles for non-owners", () => {
    const roles = [creatorRole, lowerPrize];
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ roles, permissions: PermissionsBitField.Flags.ManageGuild }),
        [lowerPrize.id],
      ),
    ).toThrow("Manage Roles");
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ roles, permissions: 0n }),
        [lowerPrize.id],
      ),
    ).toThrow("Manage Roles");
  });

  it("accepts Manage Roles and Administrator when the prize is below the creator", () => {
    const roles = [creatorRole, lowerPrize];
    expect(() =>
      assertPrizeRolesAwardable(interaction({ roles }), [lowerPrize.id]),
    ).not.toThrow();
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ roles, permissions: PermissionsBitField.Flags.Administrator }),
        [lowerPrize.id],
      ),
    ).not.toThrow();
  });

  it("rejects equal and higher roles even for non-owner Administrators", () => {
    const permissions = PermissionsBitField.Flags.Administrator;
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({
          roles: [creatorRole],
          permissions,
          memberRoleIds: [creatorRole.id],
        }),
        [creatorRole.id],
      ),
    ).toThrow("below your highest role");
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ roles: [creatorRole, higherPrize], permissions }),
        [higherPrize.id],
      ),
    ).toThrow("below your highest role");
  });

  it("lets the guild owner bypass creator permissions and hierarchy", () => {
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({
          userId: "100000000000000010",
          ownerId: "100000000000000010",
          permissions: 0n,
          memberRoleIds: null,
          roles: [higherPrize],
        }),
        [higherPrize.id],
      ),
    ).not.toThrow();
  });

  it("rejects roles Lilac cannot edit, including for the guild owner", () => {
    const managedPrize = fakeRole("100000000000000005", "Integration", 10, false);
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({
          userId: "100000000000000010",
          ownerId: "100000000000000010",
          roles: [managedPrize],
        }),
        [managedPrize.id],
      ),
    ).toThrow("I cannot award");
  });

  it("rejects unknown roles and fails a multi-role prize atomically", () => {
    const roles = [creatorRole, lowerPrize, higherPrize];
    expect(() =>
      assertPrizeRolesAwardable(interaction({ roles }), ["999999999999999999"]),
    ).toThrow("unknown or invalid role");
    expect(() =>
      assertPrizeRolesAwardable(interaction({ roles }), ["100000000000000001"]),
    ).toThrow("unknown or invalid role");
    expect(() =>
      assertPrizeRolesAwardable(interaction({ roles }), [lowerPrize.id, higherPrize.id]),
    ).toThrow("below your highest role");
  });

  it("fails closed when current member or hierarchy data cannot be resolved", () => {
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ memberRoleIds: null, roles: [creatorRole, lowerPrize] }),
        [lowerPrize.id],
      ),
    ).toThrow("verify your current server permissions");
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({
          memberRoleIds: ["888888888888888888"],
          roles: [lowerPrize],
        }),
        [lowerPrize.id],
      ),
    ).toThrow("verify your current role hierarchy");
  });

  it("uses current permission and hierarchy state when revalidated", () => {
    const roles = [creatorRole, lowerPrize];
    expect(() =>
      assertPrizeRolesAwardable(interaction({ roles }), [lowerPrize.id]),
    ).not.toThrow();
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ roles, permissions: PermissionsBitField.Flags.ManageGuild }),
        [lowerPrize.id],
      ),
    ).toThrow("Manage Roles");
    expect(() =>
      assertPrizeRolesAwardable(
        interaction({ roles, memberRoleIds: [] }),
        [lowerPrize.id],
      ),
    ).toThrow("below your highest role");
  });
});
