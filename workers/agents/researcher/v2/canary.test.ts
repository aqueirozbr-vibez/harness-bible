import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResearchSection } from "@/lib/db/research";
import { loadGuidePart } from "@/lib/guides/load";
import { ReaderFindingSchema, ReaderNoteSchema } from "@/lib/schemas/researcher";
import { checkBrief } from "@/lib/sensors/brief";
import { checkReport } from "@/lib/sensors/report";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";
import { startStubGateway, type StubGateway } from "@/tests/fixtures/research/stubGateway";

import { earlierQuestionsRead, plan, type PlannerInput } from "./planner";
import { read } from "./reader";
import { pagesForWriter, reportReferencesOf, write, type WriterInput } from "./writer";

/*
 * Invariant 33 across the three calls of a person's research (feature-specs/48 § 2, § 26; unit 69), on the stub
 * gateway: a marker word asked as the question is in the planner's request and in the writer's, and in no byte of the
 * reader's request nor of any search or fetch the stub ran; the asker's id, e-mail address and name are in none of the
 * three, since no input has a field for them; the reader's request holds the two server tools and the planner's and
 * the writer's hold none. The steps between the calls are done here as the run will do them (unit 70): the brief
 * sensor, the targets' sections alone for the reader, the notes whose page the turn saw, the pages numbered as the run's
 * list numbers them, and the report sensor.
 */

const MARKER = "zebrafinch-7731";
const ASKER = { id: "5d0c7a52-9e3b-4c61-a1f0-7b2e8c4d9a13", email: "ana.souza@acme-payments.example", name: "Ana Souza" } as const;
const QUESTION = `Has the recommended retention window for idempotency keys changed since this was written (${MARKER})?`;
const TRACE = "0123456789abcdef0123456789abcdef";
const RUN = "44444444-4444-4444-8444-444444444444";
const CALL = { principal: { organisationId: "org-of-the-asker" }, traceId: TRACE, ref: RUN } as const;
const RUBRIC = { version: "v1.2", appliesAt: "2026-07-01", tiers: RUBRIC_V1_2.tiers, chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" } } as const;
const section = (id: string, title: string): ResearchSection => ({ id, chapter: 21, version: "v1.0.0", title, text: "A retried write without a key is a second write. Keep the key for 24 hours.", verifiedOn: new Date("2026-03-04T00:00:00Z"), figures: [], rows: [] });
const SECTIONS = [section("21.3", "Idempotency keys"), section("21.4", "Retries and backoff"), section("21.5", "Exactly once")];

let stub: StubGateway;

beforeAll(async () => {
  stub = await startStubGateway();
}, 60_000);

afterAll(async () => {
  await stub.close();
});

describe("the three calls of a person's research (invariant 33)", () => {
  it("carries the question to the planner and the writer only, nothing of the asker to any, and a tool to the reader alone", async () => {
    await threeCalls(CALL);
  });

  it("for an individual account, names the asker's id in each request's metadata alone, the gateway's spend attribution, and never in a prompt (48 § 22; the review of unit 69)", async () => {
    const bodies = await threeCalls({ ...CALL, principal: { userId: ASKER.id } });
    for (const body of bodies) {
      const { metadata, ...rest } = body.json as { metadata?: { user_id?: string } } & Record<string, unknown>;
      expect(metadata?.user_id).toBe(`user:${ASKER.id}`);
      expect(JSON.stringify(rest)).not.toContain(ASKER.id);
    }
  });
});

/** The three calls of one run on the stub, under a call's principal: what each request carried, in order. */
async function threeCalls(call: typeof CALL | (Omit<typeof CALL, "principal"> & { readonly principal: { readonly userId: string } })) {
  stub.bodies.length = 0;
  stub.log.length = 0;
  const gateway = stub.gateway();

  const planner: PlannerInput = { guide: loadGuidePart("researcher", "v2.0", "planner"), rubric: RUBRIC, language: "EN", sections: SECTIONS, context: { kind: "followUp", earlier: [{ question: "How long should a key be kept?", brief: "Look for the retention window." }] }, question: QUESTION };
  const planned = await plan({ prompt: planner, call }, { gateway });
  expect(planned.ok).toBe(true);
  if (!planned.ok || !planned.output.research) throw new Error("the stub's planner planned nothing");
  const { brief, targets } = planned.output;
  expect(checkBrief({ brief, targets, sections: SECTIONS.map((s) => s.id), question: QUESTION, earlierQuestions: earlierQuestionsRead(planner) })).toEqual({ ok: true });

  const targetSections = SECTIONS.filter((s) => targets.some((target) => target.section === s.id));
  const answer = await read({ prompt: { guide: loadGuidePart("researcher", "v2.0", "reader"), rubric: RUBRIC, today: "2026-10-12", sections: targetSections, brief }, call }, { gateway });
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw new Error("the stub's reader failed");

  const says = answer.output.notes.flatMap((note) => {
    const parsed = ReaderNoteSchema.safeParse(note);
    return parsed.success && answer.pages.includes(parsed.data.url) ? [parsed.data] : [];
  });
  const findings = answer.output.findings.flatMap((finding) => {
    const parsed = ReaderFindingSchema.safeParse(finding);
    if (!parsed.success || parsed.data.proposal.kind !== "ADD_CLAIM") return [];
    return [{ section: parsed.data.anchor.id, anchor: parsed.data.anchor, changeKind: parsed.data.changeKind, before: null, after: parsed.data.proposal.text, note: parsed.data.note }];
  });
  const writer: WriterInput = { guide: loadGuidePart("researcher", "v2.0", "writer"), rubric: RUBRIC, language: "EN", question: QUESTION, earlier: [{ question: "How long should a key be kept?", report: ["The pages said a day [1]."] }], sections: targetSections, findings, pages: pagesForWriter(answer.read, says) };
  const written = await write({ prompt: writer, call }, { gateway });
  expect(written.ok).toBe(true);
  if (!written.ok) throw new Error("the stub's writer failed");
  expect(checkReport({ paragraphs: written.output.paragraphs, ...reportReferencesOf(writer) })).toMatchObject({ ok: true, report: { dropped: {} } });

  const bodies = stub.bodies.map((body) => ({ text: body, json: JSON.parse(body) as { model: string; tools?: ReadonlyArray<{ type: string }>; system: ReadonlyArray<{ text: string }> } }));
  expect(bodies).toHaveLength(3);
  const [plannerBody, readerBody, writerBody] = bodies;
  expect(plannerBody.json.system[0].text.startsWith("# The researcher's planner — guide v2.0")).toBe(true);
  expect(readerBody.json.system[0].text.startsWith("# The researcher's reader — guide v2.0")).toBe(true);
  expect(writerBody.json.system[0].text.startsWith("# The researcher's writer — guide v2.0")).toBe(true);

  /* the question: the planner's and the writer's, never the reader's nor any search or fetch it ran */
  expect(plannerBody.text).toContain(MARKER);
  expect(writerBody.text).toContain(MARKER);
  expect(readerBody.text).not.toContain(MARKER);
  expect(readerBody.text).not.toContain("How long should a key be kept");
  const searched = stub.log.filter((line) => line.startsWith("stub research: search ") || line.startsWith("stub research: fetch "));
  expect(searched).toHaveLength(2);
  for (const line of searched) expect(line).not.toContain(MARKER);

  /* the asker: in no prompt of the three; an individual account's id is the request's metadata alone, which the next case reads */
  for (const body of bodies) for (const value of Object.values(ASKER)) expect(JSON.stringify({ ...body.json, metadata: undefined })).not.toContain(value);

  /* the tools: the reader's two server tools, and none for the planner or the writer */
  expect(plannerBody.json.tools).toBeUndefined();
  expect(writerBody.json.tools).toBeUndefined();
  expect(readerBody.json.tools?.map((tool) => tool.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
  expect(bodies.map((body) => body.json.model)).toEqual(["hb-small", "hb-frontier", "hb-frontier"]);
  return bodies;
}

