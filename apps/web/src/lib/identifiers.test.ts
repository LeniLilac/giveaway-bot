import { describe, expect, it } from "vitest";
import { isUuid, parseNonNegativeInt32, parsePositiveInt32 } from "./identifiers";

describe("public identifiers", () => {
  it("accepts canonical UUIDs only", () => {
    expect(isUuid("019f6544-efae-7121-a0b5-5f5fa5279764")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("019f6544efae7121a0b55f5fa5279764")).toBe(false);
  });

  it("bounds signed PostgreSQL integer inputs", () => {
    expect(parsePositiveInt32("1")).toBe(1);
    expect(parsePositiveInt32("0")).toBeNull();
    expect(parsePositiveInt32("2147483648")).toBeNull();
    expect(parseNonNegativeInt32("0")).toBe(0);
    expect(parseNonNegativeInt32("2147483647")).toBe(2_147_483_647);
    expect(parseNonNegativeInt32("9007199254740992")).toBeNull();
  });
});
