import "dotenv/config";

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import { mergedOfChapter } from "@/lib/db/improve";
import { env } from "@/lib/env";
import { append } from "@/lib/ledger/append";
import { exportJsonl, exportKeyFromPem, type ExportScope } from "@/lib/ledger/export";
import { shortHash } from "@/lib/ledger/hash";
import type { ExportTrailer } from "@/lib/schemas/ledger";

/*
 * npm run ledger:export -- --scope all|suggestion|chapter [--id <id>]
 * [--from <iso>] [--to <iso>] --out <file> (feature-specs/14 § 5.2): writes
 * the scope's records as signed JSONL, then appends the EXPORT record that
 * names the file's hash (architecture § 4.3: the export is a ledger record).
 * Refuses without LEDGER_EXPORT_KEY (§ 7). The account scope is Phase 4's. The chapter scope is the chapter's history
 * (feature-specs/37 § 7; unit 54d): `--id 21` names the chapter, and its records are its merged suggestions'.
 */

const SCOPES = ["all", "suggestion", "chapter"] as const;
type ScopeKind = (typeof SCOPES)[number];

function usage(message: string): never {
  console.error(`${message}\nusage: npm run ledger:export -- --scope all|suggestion|chapter [--id <id>] [--from <iso>] [--to <iso>] --out <file>`);
  process.exit(1);
}

function isScopeKind(value: string): value is ScopeKind {
  return (SCOPES as readonly string[]).includes(value);
}

function instant(name: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) usage(`--${name} is not a date: ${value}`);
  return date;
}

async function scopeFromArgs(): Promise<{ scope: ExportScope; out: string }> {
  const { values } = parseArgs({ options: { scope: { type: "string" }, id: { type: "string" }, from: { type: "string" }, to: { type: "string" }, out: { type: "string" } }, strict: true });
  if (values.scope === undefined || !isScopeKind(values.scope)) usage("--scope must be all, suggestion or chapter");
  if (values.out === undefined) usage("--out names the file to write");
  const window = { from: instant("from", values.from), to: instant("to", values.to) };
  if (values.scope === "all") {
    if (values.id !== undefined) usage("--id does not apply to the all scope");
    return { scope: { kind: "all", ...window }, out: values.out };
  }
  if (values.id === undefined) usage(`--id names the ${values.scope} to export`);
  if (values.scope === "chapter") {
    if (!/^\d{1,2}$/.test(values.id)) usage("--id names the chapter by its number for the chapter scope");
    const merged = await mergedOfChapter(Number(values.id));
    return { scope: { kind: "chapter", id: values.id.padStart(2, "0"), suggestionIds: merged.map((row) => row.id), ...window }, out: values.out };
  }
  return { scope: { kind: "suggestion", id: values.id, ...window }, out: values.out };
}

async function main(): Promise<void> {
  const key = exportKeyFromPem(env.LEDGER_EXPORT_KEY);
  const { scope, out } = await scopeFromArgs();
  const sink = createWriteStream(out, { encoding: "utf8" });
  let trailer: ExportTrailer;
  try {
    // The error listener is on before the first write, so a path that cannot be opened is reported by the catch below, not as an unhandled 'error' event.
    trailer = await new Promise<ExportTrailer>((resolve, reject) => {
      sink.once("error", reject);
      exportJsonl(scope, sink, { key, now: () => new Date() }).then((written) => sink.end(() => resolve(written)), reject);
    });
  } catch (error) {
    // A refusal writes no file: the stream opened the path before the scope was read, so the empty file it left is removed once the descriptor is closed.
    if (!sink.closed) {
      sink.destroy();
      await once(sink, "close");
    }
    if (sink.bytesWritten === 0) rmSync(out, { force: true });
    throw error;
  }
  const fileSha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
  const record = await append({
    kind: "EXPORT",
    actor: "service:export",
    suggestionId: null,
    chapterVersionId: null,
    payload: { scope: trailer.scope, fromSeq: trailer.fromSeq, toSeq: trailer.toSeq, records: trailer.records, headHash: trailer.headHash, fileSha256 },
  });
  console.log(`ledger:export wrote ${trailer.records} record(s), seq ${trailer.fromSeq}–${trailer.toSeq}, head ${shortHash(trailer.headHash)}, to ${out} (sha256 ${shortHash(fileSha256)}); EXPORT record seq ${record.seq}, hash ${shortHash(record.hash)}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  // A refusal before any query (no key) must not end in a NO_DATABASE trace from a client built only to disconnect.
  .finally(() => (env.DATABASE_URL === undefined ? undefined : getPrisma().$disconnect()));
