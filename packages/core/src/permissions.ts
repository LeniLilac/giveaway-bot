import type { PermissionSnapshot } from "./types.js";

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export function hasManagementBypass(snapshot: PermissionSnapshot): boolean {
  return snapshot.isOwner ||
    (snapshot.permissions & ADMINISTRATOR) === ADMINISTRATOR ||
    (snapshot.permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

export function hasCommandPermission(snapshot: PermissionSnapshot, allowedRoleIds: string[]): boolean {
  if (hasManagementBypass(snapshot)) return true;
  const roles = new Set(snapshot.roleIds);
  return allowedRoleIds.some((role) => roles.has(role));
}
