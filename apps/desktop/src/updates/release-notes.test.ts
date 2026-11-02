import { describe, expect, it } from "vitest";

import { releaseNotesText } from "./release-notes.js";

describe("releaseNotesText", () => {
  it("decodes named, decimal, and hexadecimal HTML entities", () => {
    expect(releaseNotesText("Fix &amp; polish &#128512; &#x1F680; &quot;done&quot;"))
      .toBe('Fix & polish 😀 🚀 "done"');
  });

  it("keeps invalid scalar references literal without throwing", () => {
    expect(releaseNotesText("&#xD800; &#55296; &#x110000; &#9999999999;"))
      .toBe("&#xD800; &#55296; &#x110000; &#9999999999;");
  });

  it("decodes once after stripping markup so entity-produced tags remain text", () => {
    expect(releaseNotesText("<p>Fix &amp;lt;script&amp;gt; now</p>"))
      .toBe("Fix &lt;script&gt; now");
    expect(releaseNotesText("&lt;script&gt;alert(1)&lt;/script&gt;"))
      .toBe("<script>alert(1)</script>");
  });

  it("converts basic markup to plain text and removes control characters", () => {
    expect(releaseNotesText("<div>First\u0001 line<br>Second</div><li>Third</li>"))
      .toBe("First line\nSecond\nThird");
    expect(releaseNotesText("First&#1;&#x0d; line&#10;Second")).toBe("First line\nSecond");
    expect(releaseNotesText("&toString; &constructor; &unknown;")).toBe("&toString; &constructor; &unknown;");
  });

  it("accepts only string notes and includes at most six array entries", () => {
    expect(releaseNotesText([
      { note: "One" }, { note: "Two" }, { note: "Three" },
      { note: "Four" }, { note: "Five" }, { note: "Six" }, { note: "Ignored" },
    ])).toBe("One\n\nTwo\n\nThree\n\nFour\n\nFive\n\nSix");
    expect(releaseNotesText([{ note: 42 }, null, "not a note", { note: "Valid" }]))
      .toBe("Valid");
    expect(releaseNotesText({ note: "not an array or string" })).toBe("");
  });

  it("bounds input to 32,000 characters and output to 8,000 characters", () => {
    expect(releaseNotesText(`${"<i></i>".repeat(4_572)}visible`)).toBe("");
    expect(releaseNotesText("y".repeat(32_000))).toBe("y".repeat(8_000));
  });
});
