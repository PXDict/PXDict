import { describe, expect, it } from "vitest";
import { ErrorBody, errorBody } from "./error";

describe("ErrorBody", () => {
  it.each([
    ["not_found", true],
    ["rate_limited2", true],
    ["NotFound", false],
    ["not-found", false],
    ["", false],
  ])("code %j valid=%s", (code, valid) => {
    expect(ErrorBody.safeParse(errorBody(code, "msg")).success).toBe(valid);
  });
});
