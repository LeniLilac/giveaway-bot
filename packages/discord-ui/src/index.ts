export const COMPONENTS_V2_FLAG = 1 << 15;
export const MAX_PICKER_GIVEAWAYS = 8;

const ComponentType = {
  ActionRow: 1,
  Button: 2,
  Section: 9,
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

export interface BonusRole {
  roleId: string;
  bonusEntries: number;
}

export interface GiveawayView {
  id: string;
  creatorUserId: string;
  hostUserId: string | null;
  prize: string;
  status: string;
  winnerCount: number;
  participantCount: number;
  scheduledStartAt: Date;
  endsAt: Date;
  endedAt: Date | null;
  requiredRoleMode: "all" | "one" | null;
  requiredMessages: number | null;
  requiredRoleIds: string[];
  bonusRoles: BonusRole[];
}

export interface GiveawayListItem {
  channelId: string;
  messageId: string | null;
  prize: string;
  endsAt: Date;
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

function section(content: string, accessory: ApiComponent): ApiComponent {
  return { type: ComponentType.Section, components: [text(content)], accessory };
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
  const closed = giveaway.status === "ending" || giveaway.status === "ended";
  const interactive = giveaway.status === "active";
  const endingLabel = closed ? "Ended at" : "Ends at";
  const endingTime = Math.floor(
    (closed ? giveaway.endedAt ?? giveaway.endsAt : giveaway.endsAt).getTime() / 1000,
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
      button("Join giveaway", ButtonStyle.Success, `giveaway:join:${giveaway.id}`, undefined, !interactive),
      button("Leave giveaway", ButtonStyle.Secondary, `giveaway:leave:${giveaway.id}`, undefined, !interactive),
    ),
  );
  return [container(parts, closed ? 0x747f8d : 0x5865f2)];
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

export function winnerComponents(
  giveaway: GiveawayView,
  winnerIds: string[],
  messageUrl: string,
  websiteUrl: string,
): ApiComponent[] {
  const winnerText = winnerIds.length > 1000
    ? `🏆 **${winnerIds.length.toLocaleString()} winners** were selected for **${giveaway.prize}**. The complete user ID list is available on the website.`
    : `🏆 The ${winnerIds.length === 1 ? "winner is" : "winners are"} ${winnerIds.map((id) => `<@${id}>`).join(" ")}, you won **${giveaway.prize}**.`;
  return [
    container(
      [
        text(`### Giveaway complete\n${winnerText}`),
        row(
          button("View giveaway message", ButtonStyle.Link, undefined, messageUrl),
          button("View proof and winners", ButtonStyle.Link, undefined, websiteUrl),
        ),
      ],
      0xfee75c,
    ),
  ];
}

export interface GiveawayPickerPagination {
  page: number;
  pageAction: "start" | "queue" | "list" | "reroll";
  hasPrevious: boolean;
  hasNext: boolean;
}

function escapeMarkdownLinkText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()<>#+\-.!|~])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

export function giveawayListComponents(
  guildId: string,
  giveaways: GiveawayListItem[],
  pagination: GiveawayPickerPagination,
): ApiComponent[] {
  const visibleGiveaways = giveaways.slice(0, MAX_PICKER_GIVEAWAYS);
  const firstNumber = pagination.page * MAX_PICKER_GIVEAWAYS + 1;
  const description = visibleGiveaways.length === 0
    ? "No active giveaways found on this page."
    : visibleGiveaways
        .map((giveaway, index) => {
          const prize = escapeMarkdownLinkText(giveaway.prize);
          const endTimestamp = Math.floor(giveaway.endsAt.getTime() / 1000);
          const linkedPrize = giveaway.messageId
            ? `[${prize}](https://discord.com/channels/${guildId}/${giveaway.channelId}/${giveaway.messageId})`
            : prize;
          return [
            `\`${firstNumber + index}\`. ${linkedPrize} \u2014Ends at <t:${endTimestamp}:f> (<t:${endTimestamp}:R>)`,
            `-# Message ID: ${giveaway.messageId ?? "Pending"}`,
          ].join("\n");
        })
        .join("\n");

  return [
    container(
      [
        text(`### Active Giveaways\n${description}\n\n-# Page ${pagination.page + 1}`),
        row(
          button(
            "Previous",
            ButtonStyle.Secondary,
            `giveaway:page:list:${Math.max(0, pagination.page - 1)}`,
            undefined,
            !pagination.hasPrevious,
          ),
          button(
            "Next",
            ButtonStyle.Secondary,
            `giveaway:page:list:${pagination.page + 1}`,
            undefined,
            !pagination.hasNext,
          ),
        ),
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
  pagination: GiveawayPickerPagination,
): ApiComponent[] {
  const components: ApiComponent[] = [
    text(`### ${title}\nPage **${pagination.page + 1}**`),
  ];
  if (giveaways.length === 0) {
    components.push(text("No giveaways found on this page."));
  }
  for (const giveaway of giveaways.slice(0, MAX_PICKER_GIVEAWAYS)) {
    const details = [
      `**${giveaway.prize}**`,
      `${giveaway.status} • <t:${Math.floor(giveaway.scheduledStartAt.getTime() / 1000)}:R>`,
      `${giveaway.participantCount} participants`,
      action === "view" ? null : `[Website](${websiteBaseUrl}/g/${giveaway.id})`,
    ].filter((value): value is string => value !== null).join("\n");
    const accessory = action === "view"
      ? button("Open", ButtonStyle.Link, undefined, `${websiteBaseUrl}/g/${giveaway.id}`)
      : button(
          action[0]!.toUpperCase() + action.slice(1),
          action === "delete" ? ButtonStyle.Danger : ButtonStyle.Primary,
          `giveaway:action:${action}:${giveaway.id}`,
        );
    components.push(section(details, accessory));
  }
  components.push(
    row(
      button(
        "Previous",
        ButtonStyle.Secondary,
        `giveaway:page:${pagination.pageAction}:${Math.max(0, pagination.page - 1)}`,
        undefined,
        !pagination.hasPrevious,
      ),
      button(
        "Next",
        ButtonStyle.Secondary,
        `giveaway:page:${pagination.pageAction}:${pagination.page + 1}`,
        undefined,
        !pagination.hasNext,
      ),
    ),
  );
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
