import { describe, expect, it } from "vitest";

import { SnippetHtmlSchema, snippetViolations } from "./search";

describe("snippet vocabulary (06 § 4.2)", () => {
  it("accepts text with mark and the four entities", () => {
    expect(snippetViolations("An <mark>idempotency</mark> key &amp; a &lt;retry&gt; &quot;safe&quot; &#39;s")).toEqual([]);
    expect(() => SnippetHtmlSchema.parse("plain")).not.toThrow();
  });
  it("refuses other tags, attributes and entities", () => {
    expect(snippetViolations('<mark class="x">a</mark>')).toContain("tag");
    expect(snippetViolations("<b>a</b>")).toContain("tag");
    expect(snippetViolations("a &nbsp; b")).toEqual(["entity &nbsp;"]);
    expect(() => SnippetHtmlSchema.parse("<script>1</script>")).toThrow(/snippet vocabulary/);
  });
});
