import { describe, expect, it } from "vitest";

import type { StandardPublication } from "#/lib/atproto";
import { buildPublicationRecord, withBasicTheme } from "#/lib/publish";
import { type BasicTheme, parseTheme, themeRecord } from "#/lib/theme";

const rgb = (r: number, g: number, b: number) => ({ r, g, b });

const theme: BasicTheme = {
  background: rgb(250, 247, 240),
  foreground: rgb(28, 26, 24),
  accent: rgb(20, 84, 140),
  accentForeground: rgb(255, 255, 255),
};

/** A publication as it comes back from a PDS, carrying fields we don't own. */
const existing: StandardPublication = {
  $type: "site.standard.publication",
  name: "The Long Way",
  description: "Essays about slow software.",
  url: "https://trygoldroad.com/@writer.example",
  icon: { $type: "blob", ref: { $link: "bafkreiicon" } },
};

describe("withBasicTheme — a theme write is a publication write", () => {
  it("embeds the theme where the lexicon puts it: publication.basicTheme", () => {
    const record = withBasicTheme(existing, theme);
    expect(record.basicTheme).toEqual(themeRecord(theme));
    expect(record.$type).toBe("site.standard.publication");
  });

  it("round-trips: what we write is what parseTheme reads back", () => {
    const record = withBasicTheme(existing, theme);
    expect(parseTheme(record.basicTheme)).toEqual(theme);
  });

  it("preserves every other field, including ones other apps wrote", () => {
    const withForeign = {
      ...existing,
      preferences: { showInDiscover: false },
      somethingLeafletWrote: { keep: "me" },
    } as StandardPublication;
    const record = withBasicTheme(withForeign, theme) as Record<
      string,
      unknown
    >;
    expect(record.name).toBe("The Long Way");
    expect(record.description).toBe("Essays about slow software.");
    expect(record.url).toBe("https://trygoldroad.com/@writer.example");
    expect(record.icon).toEqual(existing.icon);
    expect(record.preferences).toEqual({ showInDiscover: false });
    expect(record.somethingLeafletWrote).toEqual({ keep: "me" });
  });

  it("REMOVES the field for 'use the defaults' rather than storing our palette", () => {
    const themed = withBasicTheme(existing, theme);
    const reverted = withBasicTheme(
      themed as StandardPublication,
      null,
    ) as Record<string, unknown>;
    expect(reverted.basicTheme).toBeUndefined();
    // A writer who reverted must be indistinguishable from one who never set
    // a theme — to us and to every other app reading the same record.
    expect(parseTheme(reverted.basicTheme)).toBeNull();
    expect(reverted.name).toBe("The Long Way");
  });

  it("replaces a theme another app wrote instead of merging into it", () => {
    const foreignTheme = {
      ...existing,
      basicTheme: {
        $type: "site.standard.theme.basic",
        accent: rgb(1, 1, 1),
        accentForeground: rgb(2, 2, 2),
        background: rgb(3, 3, 3),
        foreground: rgb(4, 4, 4),
      },
    } as StandardPublication;
    expect(parseTheme(withBasicTheme(foreignTheme, theme).basicTheme)).toEqual(
      theme,
    );
  });

  it("refuses a record that isn't a usable publication, rather than writing a broken one", () => {
    expect(() => withBasicTheme({ url: existing.url }, theme)).toThrow();
    expect(() => withBasicTheme({ name: "No URL" }, theme)).toThrow();
    expect(() =>
      withBasicTheme({ name: "Bad URL", url: "at://not-a-web-url" }, theme),
    ).toThrow();
  });
});

describe("buildPublicationRecord — the name/description save leaves a theme alone", () => {
  it("keeps basicTheme through an unrelated settings save", () => {
    const themed = withBasicTheme(existing, theme) as StandardPublication;
    const saved = buildPublicationRecord(
      {
        name: "The Long Way Home",
        description: "Still essays.",
        url: "https://trygoldroad.com/@writer.example",
      },
      themed,
    );
    expect(parseTheme(saved.basicTheme)).toEqual(theme);
    expect(saved.name).toBe("The Long Way Home");
  });
});
