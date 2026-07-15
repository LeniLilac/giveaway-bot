import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  PermissionsBitField,
  type Role,
} from "discord.js";

type PrizeRoleInteraction = ChatInputCommandInteraction | ButtonInteraction;

function memberRoleIds(member: PrizeRoleInteraction["member"]): string[] | null {
  if (!member || !("roles" in member)) return null;
  if (Array.isArray(member.roles)) return member.roles;
  if ("cache" in member.roles) return [...member.roles.cache.keys()];
  return null;
}

function memberPermissions(
  member: PrizeRoleInteraction["member"],
): PermissionsBitField | null {
  if (!member || !("permissions" in member)) return null;
  const bits =
    typeof member.permissions === "string"
      ? BigInt(member.permissions)
      : member.permissions.bitfield;
  return new PermissionsBitField(bits);
}

function highestRole(roles: Role[], fallback: Role): Role {
  return roles.reduce(
    (highest, role) => (role.comparePositionTo(highest) > 0 ? role : highest),
    fallback,
  );
}

export function assertPrizeRolesAwardable(
  interaction: PrizeRoleInteraction,
  prizeRoleIds: string[],
): void {
  if (prizeRoleIds.length === 0) return;

  const guild = interaction.guild;
  if (!guild) throw new Error("Prize roles can only be configured in a server.");

  const prizeRoles = prizeRoleIds.map((roleId) => {
    const role = guild.roles.cache.get(roleId);
    if (!role || role.id === guild.id) {
      throw new Error(`Prize roles contain an unknown or invalid role: ${roleId}.`);
    }
    if (!role.editable) {
      throw new Error(
        `I cannot award the prize role "${role.name}". Move my bot role above it or choose a role Discord allows me to manage.`,
      );
    }
    return role;
  });

  if (interaction.user.id === guild.ownerId) return;

  const permissions = memberPermissions(interaction.member);
  if (!permissions) {
    throw new Error("I could not verify your current server permissions. Try again.");
  }
  if (!permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error("You need the Manage Roles permission to configure role prizes.");
  }

  const roleIds = memberRoleIds(interaction.member);
  if (!roleIds) {
    throw new Error("I could not verify your current role hierarchy. Try again.");
  }
  const creatorRoles = roleIds.map((roleId) => {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      throw new Error("I could not verify your current role hierarchy. Try again.");
    }
    return role;
  });
  const everyoneRole = guild.roles.cache.get(guild.id);
  if (!everyoneRole) {
    throw new Error("I could not verify your current role hierarchy. Try again.");
  }
  const creatorHighestRole = highestRole(creatorRoles, everyoneRole);

  for (const prizeRole of prizeRoles) {
    if (creatorHighestRole.comparePositionTo(prizeRole) <= 0) {
      throw new Error(
        `The prize role "${prizeRole.name}" must be below your highest role.`,
      );
    }
  }
}
