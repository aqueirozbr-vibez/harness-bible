import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import pt from "../../messages/pt.json";

import { fixtureStats, hasLabel, padCatalogue, paddedLength, padMessage, visibleText, type Messages } from "./pad";

/*
 * The padded PT catalogue (unit 23c; project-overview § Success criteria · Phase 1). The first half of the
 * criterion is a property of the fixture and is held here, over the two real catalogues: every string with a label
 * in it is at least 30 % longer than its EN counterpart. The second half, that nothing truncates when the screens
 * are rendered with it, is tests/layout/'s.
 */

describe("the text a reader sees of a message", () => {
  it("leaves placeholders out, since both languages fill them with the same value", () => {
    expect(visibleText("Ask about {id}")).toBe("Ask about ");
    expect(visibleText("{n} / {max}")).toBe(" / ");
    expect(visibleText("release {id} · sha {sha}")).toBe("release  · sha ");
  });

  it("reads a plural by its other branch, the number sign included", () => {
    expect(visibleText("{n, plural, one {# turn} other {# turns}}")).toBe("# turns");
    expect(visibleText("Log · {n, plural, one {# turn} other {# turns}}")).toBe("Log · # turns");
    expect(visibleText("{n, plural, one {One passage} other {# passages}} in {section} are cited")).toBe("# passages in  are cited");
  });

  it("knows a string with no label from one with a letter in it", () => {
    for (const none of ["·", "{n} / {max}", "{n}", "#{id}", "—", "1 / 2"]) expect(hasLabel(none), none).toBe(false);
    for (const some of ["Ask", "EN", "n = {n}", "{n, plural, one {# turn} other {# turns}}"]) expect(hasLabel(some), some).toBe(true);
  });
});

describe("a padded string", () => {
  it("is left alone when it is already 30 % longer than its EN counterpart", () => {
    expect(padMessage("Ask", "Perguntar")).toBe("Perguntar");
    expect(padMessage("Book", "Livro")).toBe("Livro também");
    expect(paddedLength("Book")).toBe(6);
  });

  it("is lengthened after the message, so its placeholders and plural branches are untouched", () => {
    const padded = padMessage("{n, plural, one {# conversation} other {# conversations}}", "{n, plural, one {# conversa} other {# conversas}}");
    expect(padded.startsWith("{n, plural, one {# conversa} other {# conversas}} ")).toBe(true);
    expect(visibleText(padded).length).toBeGreaterThanOrEqual(paddedLength("{n, plural, one {# conversation} other {# conversations}}"));
    expect(padMessage("About {id}: ", "Sobre {id}: ")).toMatch(/^Sobre \{id\}: {2}\S/);
  });

  it("is never changed when the EN string has no label", () => {
    expect(padMessage("{n} / {max}", "{n} / {max}")).toBe("{n} / {max}");
    expect(padMessage("·", "·")).toBe("·");
  });

  it("uses filler that wraps: words with spaces between them", () => {
    const padded = padMessage("A sentence that is rather long for a label in a narrow rail", "Curto");
    expect(padded.split(" ").length).toBeGreaterThan(8);
    expect(padded.split(" ").every((word) => word.length <= 8)).toBe(true);
  });
});

describe("the fixture, over the catalogues the product ships", () => {
  const fixture = padCatalogue(en as Messages, pt as Messages);
  const stats = fixtureStats(en as Messages, pt as Messages, fixture);

  it("has every string at least 30 % longer than its EN counterpart", () => {
    expect(stats.short).toEqual([]);
    expect(stats.strings).toBeGreaterThan(900);
    /* Most PT strings are not 30 % longer than their EN: the fixture is what makes the suite a test at all. */
    expect(stats.padded).toBeGreaterThan(stats.strings / 2);
    expect(stats.exempt).toBeLessThan(stats.strings / 10);
  });

  it("keeps the catalogue's keys exactly", () => {
    const keys = (messages: Messages, prefix = ""): ReadonlyArray<string> => Object.entries(messages).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`)));
    expect(keys(fixture)).toEqual(keys(pt as Messages));
  });

  it("is still a catalogue next-intl can format: every string, with a value for each of its arguments", () => {
    const t = createTranslator({
      locale: "pt",
      messages: fixture,
      onError: (error) => {
        throw error;
      },
    }) as unknown as { (key: string, values: Record<string, number>): string; markup: (key: string, values: Record<string, number | ((chunks: string) => string)>) => string };
    const flat = (messages: Messages, prefix = ""): ReadonlyArray<readonly [string, string]> =>
      Object.entries(messages).flatMap(([key, value]) => (typeof value === "string" ? [[`${prefix}${key}`, value] as const] : flat(value, `${prefix}${key}.`)));
    let formatted = 0;
    for (const [key, message] of flat(fixture)) {
      const values = Object.fromEntries([...message.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((match) => [match[1] ?? "", 3]));
      /* A string that marks part of itself (`<book>…</book>`: the book's text in a heading, in its own language) is formatted with each tag keeping its text. */
      const tags = Object.fromEntries([...message.matchAll(/<(\w+)>/g)].map((match) => [match[1] ?? "", (chunks: string) => chunks]));
      expect((Object.keys(tags).length === 0 ? t(key, values) : t.markup(key, { ...values, ...tags })).length, key).toBeGreaterThan(0);
      formatted += 1;
    }
    expect(formatted).toBe(stats.strings);
  });
});
