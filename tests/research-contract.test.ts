import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ALL_ENDPOINTS } from "@/lib/api/endpoints/index";
import { NoBodySchema } from "@/lib/schemas/api";

/*
 * What a turn hands over to research stays in the rows (feature-specs/40 § 4, D4; unit 57b): `Message.uncovered` is the
 * model's own sentence about the reader's question behind a replaced claim, and no endpoint's schema carries it — not
 * the assistant's `final` event, not a conversation's read, not any other response. The same for the sections retrieved,
 * which are metadata but the research's to read. The check walks every endpoint's response and event schemas.
 */

const PRIVATE = ["uncovered", "retrievedSections"];

function keysOf(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "properties" && typeof entry === "object" && entry !== null) for (const name of Object.keys(entry)) found.add(name);
    keysOf(entry, found);
  }
}

describe("what a turn hands over to research reaches no client (40 § 4)", () => {
  it("names uncovered and retrievedSections in no endpoint's response or event schema", () => {
    const named: string[] = [];
    for (const endpoint of ALL_ENDPOINTS) {
      const schemas: Array<[string, z.ZodType]> = [["response", endpoint.response as z.ZodType]];
      for (const [name, schema] of Object.entries(endpoint.events ?? {})) schemas.push([`event ${name}`, schema as z.ZodType]);
      for (const [where, schema] of schemas) {
        const found = new Set<string>();
        keysOf(z.toJSONSchema(schema, { unrepresentable: "any", io: "output", reused: "inline" }), found);
        for (const key of PRIVATE) if (found.has(key)) named.push(`${endpoint.method} ${endpoint.path} ${where}: ${key}`);
      }
    }
    expect(named).toEqual([]);
    expect(ALL_ENDPOINTS.length).toBeGreaterThan(40);
  });
});

/*
 * What never reaches a client of a person's research (feature-specs/48 § 16; unit 71): the brief, the reader's notes on
 * the pages (`notes`, `says`), the seed answer's uncovered sentences, an invalid finding's reason, and the reader's
 * ordinal of a finding — a finding is numbered 1 to n among those that passed, and the run's own ordinal is its place in
 * the research. The walk reads every research endpoint's response schema, and each finding's properties apart.
 */
const RESEARCH_PRIVATE = ["brief", "briefSha256", "says", "notes", "uncovered", "invalidReason", "workflowId", "dropped"];

/** The property names under `findings` items, wherever a schema has them. */
function findingKeysOf(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) findingKeysOf(entry, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "findings" && typeof entry === "object" && entry !== null) {
      const items = (entry as { items?: { properties?: Record<string, unknown> } }).items;
      for (const name of Object.keys(items?.properties ?? {})) found.add(name);
    }
    findingKeysOf(entry, found);
  }
}

describe("what a person's research keeps from a client (48 § 16)", () => {
  const research = ALL_ENDPOINTS.filter((endpoint) => endpoint.path.startsWith("/api/v1/research/"));

  it("names no brief, page note, uncovered sentence, invalid reason, workflow id or dropped paragraph in any research endpoint's response", () => {
    expect(research.length).toBeGreaterThanOrEqual(6);
    const named: string[] = [];
    for (const endpoint of research) {
      const found = new Set<string>();
      keysOf(z.toJSONSchema(endpoint.response as z.ZodType, { unrepresentable: "any", io: "output", reused: "inline" }), found);
      for (const key of RESEARCH_PRIVATE) if (found.has(key)) named.push(`${endpoint.method} ${endpoint.path}: ${key}`);
    }
    expect(named).toEqual([]);
  });

  it("gives a finding its own id and its number among those that passed, never the reader's ordinal", () => {
    /* the views a GET answers; the export (unit 73) answers a file of ledger records, which holds no finding */
    const viewed = research.filter((endpoint) => endpoint.method === "GET" && endpoint.response !== NoBodySchema);
    expect(viewed.length).toBeGreaterThanOrEqual(2);
    for (const endpoint of viewed) {
      const found = new Set<string>();
      findingKeysOf(z.toJSONSchema(endpoint.response as z.ZodType, { unrepresentable: "any", io: "output", reused: "inline" }), found);
      expect(found.has("n"), `${endpoint.path} findings`).toBe(true);
      expect(found.has("ordinal"), `${endpoint.path} findings`).toBe(false);
    }
  });
});
