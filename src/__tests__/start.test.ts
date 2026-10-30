// @vitest-environment node
import { csrfSymbol } from "@tanstack/react-start";
import { describe, expect, it } from "vitest";

import { startInstance } from "../start";

describe("src/start.ts", () => {
  it("keeps the CSRF middleware, which Start stops adding once this file exists", async () => {
    const options = await startInstance.getOptions();
    expect((options.requestMiddleware ?? []).some((m) => csrfSymbol in m)).toBe(
      true,
    );
  });
});
