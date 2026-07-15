import { describe, expect, it } from "vitest";
import {
  MAX_PICKER_GIVEAWAYS,
  giveawayListComponents,
  giveawayPickerComponents,
  type ApiComponent,
  type GiveawayView,
} from "./index.js";

function countComponents(component: ApiComponent): number {
  const children = Array.isArray(component.components)
    ? (component.components as ApiComponent[]).reduce(
        (total, child) => total + countComponents(child),
        0,
      )
    : 0;
  const accessory = component.accessory && typeof component.accessory === "object"
    ? countComponents(component.accessory as ApiComponent)
    : 0;
  return 1 + children + accessory;
}

describe("Discord Components V2 pickers", () => {
  it("renders the public giveaway list as compact message links without redirect buttons", () => {
    const payload = giveawayListComponents(
      "1407191574630109275",
      [
        {
          channelId: "1451991606176649276",
          messageId: "1516727037786853426",
          prize: "Shiny Kaguya",
          endsAt: new Date(1784278305 * 1000),
        },
        {
          channelId: "1451991606176649276",
          messageId: "1526652375954362440",
          prize: "Battlepass",
          endsAt: new Date(1784311890 * 1000),
        },
      ],
      { page: 0, pageAction: "list", hasPrevious: false, hasNext: true },
    );

    const containerChildren = payload[0]!.components as ApiComponent[];
    expect(containerChildren).toHaveLength(2);
    expect(containerChildren[0]).toMatchObject({
      type: 10,
      content: [
        "### Active Giveaways",
        "`1`. [Shiny Kaguya](https://discord.com/channels/1407191574630109275/1451991606176649276/1516727037786853426) \u2014Ends at <t:1784278305:f> (<t:1784278305:R>)",
        "-# Message ID: 1516727037786853426",
        "`2`. [Battlepass](https://discord.com/channels/1407191574630109275/1451991606176649276/1526652375954362440) \u2014Ends at <t:1784311890:f> (<t:1784311890:R>)",
        "-# Message ID: 1526652375954362440",
        "",
        "-# Page 1",
      ].join("\n"),
    });
    expect(containerChildren.some((component) => component.type === 9)).toBe(false);
    const paginationButtons = containerChildren[1]!.components as ApiComponent[];
    expect(paginationButtons).toHaveLength(2);
    expect(paginationButtons.every((component) => component.style !== 5)).toBe(true);
  });

  it("keeps a full picker page within Discord's nested and total component limits", () => {
    const giveaways: GiveawayView[] = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${index.toString().padStart(12, "0")}`,
      creatorUserId: "123456789012345678",
      hostUserId: "123456789012345678",
      prize: `Prize ${index + 1}`,
      status: "queued",
      winnerCount: 1,
      participantCount: index,
      scheduledStartAt: new Date("2026-07-10T12:00:00.000Z"),
      endsAt: new Date("2026-07-11T12:00:00.000Z"),
      endedAt: null,
      requiredRoleMode: null,
      requiredMessages: null,
      requiredRoleIds: [],
      bonusRoles: [],
    }));
    const payload = giveawayPickerComponents(
      "Queued giveaways",
      giveaways,
      "view",
      "https://giveaway.leni.cat",
      { page: 0, pageAction: "queue", hasPrevious: false, hasNext: true },
    );
    const containerChildren = payload[0]!.components as ApiComponent[];
    expect(containerChildren).toHaveLength(10);
    expect(containerChildren.filter((component) => component.type === 9)).toHaveLength(
      MAX_PICKER_GIVEAWAYS,
    );
    expect(payload.reduce((total, component) => total + countComponents(component), 0)).toBeLessThanOrEqual(40);
  });
});
