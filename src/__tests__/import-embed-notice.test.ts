// @vitest-environment node
import { describe, expect, it } from "vitest";

import { hasEmbed } from "~/routes/import";

/**
 * Conversion drops iframes and other embedded players — correctly, since
 * conversion is the sanitizer. What it never did was say WHICH posts lost one.
 * A silently-shorter post found weeks later is worse than a labelled one found
 * now, because the labelled one can be fixed while the original is still up.
 */
describe("flagging posts whose embeds won't survive conversion", () => {
  it("catches the players an export actually carries", () => {
    for (const html of [
      '<p>Watch:</p><iframe src="https://youtube.com/embed/x"></iframe>',
      '<video controls src="clip.mp4"></video>',
      '<audio src="episode.mp3"></audio>',
      '<embed src="thing.pdf">',
      '<object data="thing.swf"></object>',
    ]) {
      expect(hasEmbed(html)).toBe(true);
    }
  });

  it("is not fooled by case or by whitespace after the bracket", () => {
    expect(hasEmbed("<IFRAME SRC='x'></IFRAME>")).toBe(true);
    expect(hasEmbed("< iframe src='x'>")).toBe(true);
  });

  it("leaves ordinary prose alone", () => {
    for (const html of [
      "<p>An ordinary paragraph.</p>",
      '<p>With <a href="https://youtube.com/watch?v=x">a link</a> to a video.</p>',
      '<figure><img src="photo.jpg" alt="A photo"></figure>',
      "",
    ]) {
      expect(hasEmbed(html)).toBe(false);
    }
  });

  it("does not match a tag that merely starts with one of the names", () => {
    // The word boundary is what stops <videographer> and <objection> — element
    // names an export could plausibly carry from a hand-rolled theme.
    expect(hasEmbed("<videographer>Jane</videographer>")).toBe(false);
    expect(hasEmbed("<objections>None</objections>")).toBe(false);
  });
});
