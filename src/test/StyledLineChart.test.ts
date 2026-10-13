import { describe, expect, it } from "@jest/globals";
import { rgbToHex } from "../lib/StyledLineChart";

describe("rgbToHex", () => {
  it("ignores whitespace around computed CSS color tokens", () => {
    expect(rgbToHex("  247 247 247")).toBe("#f7f7f7");
    expect(rgbToHex("12 12 12")).toBe("#0c0c0c");
  });
});
