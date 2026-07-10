import type { BonusRole, Giveaway } from "@giveaway/core";

export const COMPONENTS_V2_FLAG = 1 << 15;

const ComponentType = {
  ActionRow: 1,
  Button: 2,
  TextDisplay: 10,
  Separator: 14,
  Container: 17,
} as const;

const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
} as const;

export type ApiComponent = Record<string, unknown>;

export interface GiveawayView extends Giveaway {
  requiredRoleIds: string[];
  bonusRoles: BonusRole[];
}

function text(content: string): ApiComponent {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): ApiComponent {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function button(
  label: string,
  style: number,
  customId?: string,
  url?: string,
  disabled = false,
): ApiComponent {
  return {
    type: ComponentType.Button,
    label,
    style,
    ...(customId ? { custom_id: customId } : {}),
    ...(url ? { url } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

function row(...components: ApiComponent[]): ApiComponent {
  return { type: ComponentType.ActionRow, components };
}

function container(components: ApiComponent[], accentColor = 0x5865f2): ApiComponent {
  return { type: ComponentType.Container, accent_color: accentColor, components };
}

function roleMentions(roleIds: string[]): string {
  return roleIds.map((roleId) => `<@&${roleId}>`).join(" ");
}

function bonusLines(bonusRoles: BonusRole[]): string {
  return bonusRoles
    .map((role) => `- <@&${role.roleId}> • **${role.bonusEntries}** bonus entries`)
    .join("\n");
}

export function giveawayComponents(giveaway: GiveawayView): ApiComponent[] {
  const host = giveaway.hostUserId ?? giveaway.creatorUserId;
  const ended = giveaway.status === "ended";
  const endingLabel = ended ? "Ended at" : "Ends at";
  const endingTime = Math.floor(
    (ended ? giveaway.endedAt ?? giveaway.endsAt : giveaway.endsAt).getTime() / 1000,
  );
  const main = [
    `### ${giveaway.prize}`,
    `- Hosted by <@${host}>`,
    `- ${endingLabel}: <t:${endingTime}:F> (<t:${endingTime}:R>)`,
    `- Winners: **${giveaway.winnerCount}**`,
    `- Participants: **${giveaway.participantCount}**`,
  ].join("\n");

  const requirements: string[] = [];
  if (giveaway.requiredRoleIds.length > 0) {
    requirements.push(
      `- Roles required (${giveaway.requiredRoleMode ?? "all"}): ${roleMentions(giveaway.requiredRoleIds)}`,
    );
  }
  if (giveaway.requiredMessages !== null) {
    requirements.push(`- Messages required: **${giveaway.requiredMessages}**`);
  }

  const parts: ApiComponent[] = [text(main)];
  if (requirements.length > 0) {
    parts.push(separator(), text(`### Requirements\n${requirements.join("\n")}`));
  }
  if (giveaway.bonusRoles.length > 0) {
    parts.push(
      separator(),
      text(`### Roles with bonus entries\n${bonusLines(giveaway.bonusRoles)}`),
    );
  }
  parts.push(
    row(
      button("Join giveaway", ButtonStyle.Success, `giveaway:join:${giveaway.id}`, undefined, ended),
      button("Leave giveaway", ButtonStyle.Secondary, `giveaway:leave:${giveaway.id}`, undefined, ended),
    ),
  );
  return [container(parts, ended ? 0x747f8d : 0x5865f2)];
}

export function requirementDecisionComponents(
  draftId: string,
  hasRoles: boolean,
  hasMessages: boolean,
): ApiComponent[] {
  const parts: ApiComponent[] = [
    text("### Confirm giveaway requirements"),
    text("Choose how the supplied requirements should be evaluated before the giveaway is created."),
  ];
  if (hasRoles) {
    parts.push(
      text("**Required roles**"),
      row(
        button("Require every role", ButtonStyle.Primary, `draft:roles:all:${draftId}`),
        button("Require any one role", ButtonStyle.Secondary, `draft:roles:one:${draftId}`),
      ),
    );
  }
  if (hasMessages) {
    parts.push(
      text("**Required message count**"),
      row(
        button("All-time messages", ButtonStyle.Primary, `draft:messages:all_time:${draftId}`),
        button("Since giveaway starts", ButtonStyle.Secondary, `draft:messages:since_start:${draftId}`),
      ),
    );
  }
  parts.push(
    separator(),
    row(button("Cancel", ButtonStyle.Danger, `draft:cancel:${draftId}`)),
  );
  return [container(parts, 0xfee75c)];
}

export function draftReadyComponents(draftId: string): ApiComponent[] {
  return [
    container(
      [
        text("### Giveaway ready"),
        text("All requirement choices are set. Create the giveaway or cancel this draft."),
        row(
          button("Create giveaway", ButtonStyle.Success, `draft:create:${draftId}`),
          button("Cancel", ButtonStyle.Danger, `draft:cancel:${draftId}`),
        ),
      ],
      0x57f287,
    ),
  ];
}

export function consentComponents(giveawayId: string): ApiComponent[] {
  return [
    container(
      [
        text("### Privacy confirmation"),
        text(
          "Entering stores your Discord user ID, current username, avatar hash, and join/leave history so the draw can be audited publicly. You can request deletion from the website.",
        ),
        row(
          button("I agree and want to enter", ButtonStyle.Success, `consent:accept:${giveawayId}`),
          button("Cancel", ButtonStyle.Secondary, `consent:cancel:${giveawayId}`),
        ),
      ],
      0x5865f2,
    ),
  ];
}

export function winnerComponents(
  giveaway: GiveawayView,
  winnerIds: string[],
  messageUrl: string,
  websiteUrl: string,
): ApiComponent[] {
  const noun = winnerIds.length === 1 ? "winner is" : "winners are";
  const winnerText =
    winnerIds.length <= 1000
      ? winnerIds.map((id) => `<@${id}>`).join(" ")
      : `${winnerIds.length} winners are listed on the website.`;
  return [
    container(
      [
        text(`### Giveaway complete\n🏆 The ${noun} ${winnerText}, you won **${giveaway.prize}**.`),
        row(
          button("View giveaway message", ButtonStyle.Link, undefined, messageUrl),
          button("View proof and winners", ButtonStyle.Link, undefined, websiteUrl),
        ),
      ],
      0xfee75c,
    ),
  ];
}

export function proofPendingComponents(
  giveaway: GiveawayView,
  candidateHash: string,
  round: bigint,
  websiteUrl: string,
): ApiComponent[] {
  return [
    container(
      [
        text("### Winner selection committed"),
        text(
          `Candidate snapshot: **${candidateHash}**\nDrand round: **${round.toString()}**\nThe winner calculation will run after this public beacon is available.`,
        ),
        row(button("Inspect verification data", ButtonStyle.Link, undefined, websiteUrl)),
      ],
      0x5865f2,
    ),
  ];
}

export function giveawayPickerComponents(
  title: string,
  giveaways: GiveawayView[],
  action: "start" | "end" | "reroll" | "delete" | "view",
  websiteBaseUrl: string,
): ApiComponent[] {
  if (giveaways.length === 0) {
    return [container([text(`### ${title}\nNo giveaways found.`)], 0x747f8d)];
  }

  const components: ApiComponent[] = [text(`### ${title}`)];
  for (const giveaway of giveaways.slice(0, 20)) {
    const details = [
      `**${giveaway.prize}**`,
      `${giveaway.status} • <t:${Math.floor(giveaway.scheduledStartAt.getTime() / 1000)}:R>`,
      `${giveaway.participantCount} participants`,
    ].join("\n");
    components.push(
      separator(),
      text(details),
      row(
        action === "view"
          ? button("Open details", ButtonStyle.Link, undefined, `${websiteBaseUrl}/g/${giveaway.id}`)
          : button(
              action[0]!.toUpperCase() + action.slice(1),
              action === "delete" ? ButtonStyle.Danger : ButtonStyle.Primary,
              `giveaway:action:${action}:${giveaway.id}`,
            ),
        button("Website", ButtonStyle.Link, undefined, `${websiteBaseUrl}/g/${giveaway.id}`),
      ),
    );
  }
  return [container(components, 0x5865f2)];
}

export function simpleNotice(
  title: string,
  description: string,
  tone: "info" | "success" | "warning" | "danger" = "info",
): ApiComponent[] {
  const colors = {
    info: 0x5865f2,
    success: 0x57f287,
    warning: 0xfee75c,
    danger: 0xed4245,
  };
  return [container([text(`### ${title}\n${description}`)], colors[tone])];
}
