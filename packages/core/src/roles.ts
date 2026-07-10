import type { BonusRole } from "./types.js";

const ROLE = /<@&($d{17,20})>|($d{17,20})/g;
const BONUS = /(?:<@&($d{17,20})>|($d{17,20}))$s*[:=]$s*($d+)/g;

function validSeparator(value: string): boolean {
  return value.replace(/[$s,]+/g, "") === "";
}

export function parseRoleList(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  const ids: string[] = [];
  let end = 0;
  ROLE.lastIndex = 0;
  for (let match = ROLE.exec(value); match; match = ROLE.exec(value)) {
    if (!validSeparator(value.slice(end, match.index))) throw new Error("Role lists may only contain role mentions, IDs, commas, and spaces.");
    ids.push(match[1] ?? match[2]!);
    end = ROLE.lastIndex;
  }
  if (!ids.length || !validSeparator(value.slice(end))) throw new Error("Role lists must contain only role mentions or IDs.");
  return [...new Set(ids)];
}

export function parseBonusRoles(value: string | null | undefined): BonusRole[] {
  if (!value?.trim()) return [];
  const roles: BonusRole[] = [];
  const seen = new Set<string>();
  let end = 0;
  BONUS.lastIndex = 0;
  for (let match = BONUS.exec(value); match; match = BONUS.exec(value)) {
    if (!validSeparator(value.slice(end, match.index))) throw new Error("Bonus roles must use role:entries pairs.");
    const roleId = match[1] ?? match[2]!;
    const bonus = BigInt(match[3]!);
    if (bonus <= 0n) throw new Error("Bonus entries must be positive.");
    if (seen.has(roleId)) throw new Error(`Role ${roleId} has more than one bonus.`);
    seen.add(roleId);
    roles.push({ roleId, bonus: bonus.toString() });
    end = BONUS.lastIndex;
  }
  if (!roles.length || !validSeparator(value.slice(end))) throw new Error("Bonus roles must use role:entries pairs.");
  return roles;
}

export function satisfiesRoles(memberRoleIds: Iterable<string>, required: string[], mode: "all" | "one"): boolean {
  if (!required.length) return true;
  const held = new Set(memberRoleIds);
  return mode === "all" ? required.every((role) => held.has(role)) : required.some((role) => held.has(role));
}

export function calculateWeight(memberRoleIds: Iterable<string>, bonuses: BonusRole[]): { bonus: bigint; weight: bigint; matched: string[] } {
  const held = new Set(memberRoleIds);
  const matched = bonuses.filter((item) => held.has(item.roleId));
  const bonus = matched.reduce((total, item) => total + BigInt(item.bonus), 0n);
  return { bonus, weight: 1n + bonus, matched: matched.map((item) => item.roleId) };
}
