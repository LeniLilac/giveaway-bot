import { describe, expect, it } from "vitest";
import {
  MAX_PICKER_GIVEAWAYS,
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
