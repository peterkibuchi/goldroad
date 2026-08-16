import { describe, expect, it } from "vitest";

// write.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { Route } from "../routes/write";

type ValidateSearch = (search: Record<string, unknown>) => {
  edit?: string;
  draft?: string;
};

const validateSearch = (
  Route.options as unknown as { validateSearch: ValidateSearch }
).validateSearch;

/** A well-formed TID — the shape every rkey this app writes actually has. */
const RKEY = "3laaa2bbb3ccc";
/** A draft id, in the shape ~/lib/drafts-schema mints (a randomUUID). */
const DRAFT_ID = "0f9a1b2c-3d4e-4f50-8a1b-2c3d4e5f6071";

describe("/write search params — edit and draft are held to the same standard", () => {
  it("keeps a well-formed rkey and a well-formed draft id", () => {
    expect(validateSearch({ edit: RKEY })).toEqual({ edit: RKEY });
    expect(validateSearch({ draft: DRAFT_ID })).toEqual({ draft: DRAFT_ID });
  });

  it("drops an edit that isn't an rkey, exactly as it drops a bad draft id", () => {
    // `draft` has been validated here since it was added; `edit` was taken on
    // trust, so a path segment, a traversal or a whole URL became part of this
    // route's address and rode into the loader untouched.
    for (const bad of [
      "",
      "not-a-tid",
      "../../etc/passwd",
      "3laaa2bbb3ccc/extra",
      "https://example.com",
      "3LAAA2BBB3CCC",
      "3laaa2bbb3cccc",
    ]) {
      expect(validateSearch({ edit: bad })).toEqual({});
      expect(validateSearch({ draft: bad })).toEqual({});
    }
  });

  it("ignores a non-string edit, as it does a non-string draft", () => {
    expect(validateSearch({ edit: 1, draft: 1 })).toEqual({});
    expect(validateSearch({ edit: null, draft: null })).toEqual({});
    expect(validateSearch({ edit: [RKEY], draft: [DRAFT_ID] })).toEqual({});
  });

  it("leaves the params it already validated alone", () => {
    expect(validateSearch({ error: "not_found" })).toEqual({
      error: "not_found",
    });
    expect(validateSearch({ unscheduled: "1" })).toEqual({ unscheduled: true });
    expect(validateSearch({ returnTo: "/dashboard" })).toEqual({
      returnTo: "/dashboard",
    });
  });
});
