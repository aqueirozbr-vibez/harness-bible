import { describe, expect, it } from "vitest";

import { lexemesOf, markupSnippet, matchedTerms } from "./hybrid";

describe("snippet markup", () => {
  it("escapes the text and keeps only the headline's marks", () => {
    expect(markupSnippet('Garcia-Molina & Salem, "Sagas" <mark>idempotency</mark> a < b')).toBe("Garcia-Molina &amp; Salem, &quot;Sagas&quot; <mark>idempotency</mark> a &lt; b");
    expect(markupSnippet("<b>bold</b> </mark>")).toBe("&lt;b&gt;bold&lt;/b&gt; </mark>");
  });
});

describe("search terms", () => {
  it("reads lexemes from a tsquery's text form", () => {
    expect(lexemesOf("'idempot'")).toEqual(["idempot"]);
    expect(lexemesOf("'idempot' & 'key' | !'retri'")).toEqual(["idempot", "key", "retri"]);
    expect(lexemesOf("")).toEqual([]);
    expect(lexemesOf("'o''neil'")).toEqual(["o'neil"]);
  });

  it("collects marked words that differ from the query", () => {
    const snippets = ["An <mark>idempotency</mark> key", "<mark>Idempotent</mark> writes and <mark>idempotence</mark>", "no marks"];
    expect(matchedTerms(snippets, "idempotency")).toEqual(["idempotence", "idempotent"]);
    expect(matchedTerms(snippets, "Idempotency idempotent")).toEqual(["idempotence"]);
    expect(matchedTerms([], "x")).toEqual([]);
  });
});
