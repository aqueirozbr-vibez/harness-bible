import "dotenv/config";

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import { loadGuide } from "@/lib/guides/load";
import { sniffMedia } from "@/lib/improve/media";
import { loadRubric } from "@/lib/rubrics/load";
import type { Principal } from "@/lib/schemas/gateway";
import type { EvidenceContent } from "@/workers/agents/grader/assemble";
import { gradeEvidence } from "@/workers/agents/grader/evidence";
import { checkPrincipalOf } from "@/workers/env";

/*
 * npm run grade:check -- <fixture> [--org <id> | --user <id>] (feature-specs/32 § 7, § 13.5; unit 49d): one evidence
 * fixture through the real grader — the guide, the rubric, the request row, the gateway at GATEWAY_URL with the
 * principal's key — and what code made of the answer printed: the tier, the classifications, the factors, the
 * arithmetic, the reason, the model, the usage. **A paid call**, one per run, charged to the principal as any grade
 * is; Andre's to start, as every real-model run is. The fixture is a name under workers/agents/grader/__fixtures__
 * (`B-standard.txt`, …, `injection.txt`) or a path to a text file. The anchor and the change are the fixtures' own
 * (chapter 21's retries); the contributor's address is nobody's, so independence is the grader's stake alone.
 *
 * Since unit 49f a fixture may be a PDF or an image (`C-vendor.pdf`, `C-vendor.png`, `C-vendor.jpg`): the file's own
 * first bytes say which, and it goes to the model as the provider's document or image content (§ 9). That run is
 * the proof § 9 asks for — that the pinned proxy passes those blocks and `hb-small` reads them — and is Andre's.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run grade:check -- <fixture-name | text, PDF or image file> [--org <organisationId> | --user <userId>]`);
  process.exit(1);
}

const { values, positionals } = parseArgs({ options: { org: { type: "string" }, user: { type: "string" } }, allowPositionals: true, strict: true });
const [fixture] = positionals;
if (fixture === undefined || positionals.length > 1) usage("name one fixture or one text file");
if (values.org !== undefined && values.user !== undefined) usage("name at most one of --org and --user");

function principalOf(): Principal {
  if (values.org !== undefined) return { organisationId: values.org };
  if (values.user !== undefined) return { userId: values.user };
  const configured = ((): Principal | null => {
    try {
      return checkPrincipalOf();
    } catch (error: unknown) {
      usage(error instanceof Error ? error.message : String(error));
    }
  })();
  if (configured === null) usage("GATEWAY_CHECK_PRINCIPAL is not set: name --org or --user, or set it in .env (feature-specs/11 § 3.6)");
  return configured;
}

/** The file as the grader reads it: a PDF or an image by its own first bytes, anything else as UTF-8 text. */
function contentOf(name: string): { readonly content: EvidenceContent; readonly mediaType: string; readonly name: string; readonly size: number } {
  const candidates = [join(process.cwd(), "workers", "agents", "grader", "__fixtures__", name), name];
  for (const path of candidates) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    const sniffed = sniffMedia(bytes);
    if (sniffed !== null) return { content: { kind: "bytes", mediaType: sniffed, data: bytes }, mediaType: sniffed, name: basename(path), size: bytes.length };
    const text = bytes.toString("utf8");
    return { content: { kind: "text", text }, mediaType: "text/plain", name: basename(path), size: bytes.length };
  }
  return usage(`no fixture or file named ${name}`);
}

const document = contentOf(fixture ?? "");
const principal = principalOf();
const guide = loadGuide("grader", "v1.3");
const { rubric } = loadRubric("v1.2");

gradeEvidence({
  prompt: {
    guide,
    rubric,
    anchor: { kind: "SECTION", id: "21.3", chapter: 21, text: "Retries are not optional at eleven steps.", fastMoving: false },
    change: { kind: "EDIT_TEXT", anchoredPassage: "Retries are not optional at eleven steps.", proposedText: "Retries are required at eleven steps." },
    /* No title, as an upload has none (fetchItem): a fixture's name states the tier it should get, and the fence would show it to the model. */
    document: { kind: "UPLOAD", host: null, mediaType: document.mediaType, title: null, publishedOn: null, content: document.content },
  },
  independence: { publisherHost: null, contributorEmail: null },
  call: { principal, traceId: randomBytes(16).toString("hex"), ref: "grade-check" },
})
  .then((grade) => {
    /* What the grader read is the fixture; the report carries its hash and not the text. */
    const report: Record<string, unknown> = { fixture: document.name, mediaType: document.mediaType, size: document.size, ...grade };
    delete report["text"];
    console.log(JSON.stringify(report, null, 2));
    if (!grade.graded) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
