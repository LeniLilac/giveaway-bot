import { describe, expect, it } from "vitest";
import { assertActionAllowed, parseManagementAction } from "./action-policy.js";

describe("management action policy", () => {
  it("uses exact allowed states for every management action", () => {
    expect(() => assertActionAllowed("start", "queued")).not.toThrow();
    expect(() => assertActionAllowed("end", "active")).not.toThrow();
    expect(() => assertActionAllowed("reroll", "ended")).not.toThrow();
    for (const status of ["queued", "active", "ended", "error"] as const) {
      expect(() => assertActionAllowed("delete", status)).not.toThrow();
    }
    expect(() => assertActionAllowed("start", "active")).toThrow();
    expect(() => assertActionAllowed("end", "ending")).toThrow();
    expect(() => assertActionAllowed("delete", "ending")).toThrow();
  });

  it("rejects unrecognized runtime action values", () => {
    expect(parseManagementAction("reroll")).toBe("reroll");
    for (const value of ["", "view", "start_giveaway", null, 1]) {
      expect(() => parseManagementAction(value)).toThrow("Unknown giveaway action");
    }
  });
});
