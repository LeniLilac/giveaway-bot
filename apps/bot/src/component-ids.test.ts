import { describe, expect, it } from "vitest";
import {
  parseDraftComponentId,
  parseGiveawayComponentId,
  parseRerollModalId,
} from "./component-ids.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("component custom IDs", () => {
  it("parses every supported component shape", () => {
    expect(parseDraftComponentId(`draft:roles:all:${ID}`)).toEqual({
      type: "roles",
      value: "all",
      draftId: ID,
    });
    expect(parseDraftComponentId(`draft:messages:since_start:${ID}`)).toEqual({
      type: "messages",
      value: "since_start",
      draftId: ID,
    });
    expect(parseDraftComponentId(`draft:create:${ID}`)).toEqual({
      type: "create",
      draftId: ID,
    });
    expect(parseGiveawayComponentId("giveaway:page:reroll:3")).toEqual({
      type: "page",
      kind: "reroll",
      page: 3,
    });
    expect(parseGiveawayComponentId(`giveaway:action:delete:${ID}`)).toEqual({
      type: "action",
      action: "delete",
      giveawayId: ID,
    });
    expect(parseGiveawayComponentId(`giveaway:join:${ID}`)).toEqual({
      type: "join",
      giveawayId: ID,
    });
    expect(parseRerollModalId(`giveaway:reroll:${ID}`)).toBe(ID);
  });

  it("rejects unknown actions, values, malformed IDs, and extra fields", () => {
    for (const customId of [
      `draft:roles:any:${ID}`,
      `draft:create:${ID}:extra`,
      "draft:cancel:not-a-uuid",
      `giveaway:page:start:01`,
      `giveaway:page:unknown:0`,
      `giveaway:action:ban:${ID}`,
      `giveaway:join:${ID}:extra`,
      `giveaway:unknown:${ID}`,
    ]) {
      const parser = customId.startsWith("draft:")
        ? parseDraftComponentId
        : parseGiveawayComponentId;
      expect(() => parser(customId)).toThrow();
    }
    expect(() => parseRerollModalId(`giveaway:reroll:${ID}:extra`)).toThrow();
  });
});
