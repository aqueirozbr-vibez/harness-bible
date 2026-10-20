# 14 · Ledger core — feature spec (canonical JSON, the hash chain, append, verify, export)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `context/architecture.md` § 3.1 (`lib/ledger/`: canonicalisation (RFC 8785), SHA-256 hashing, chain append, chain verification, JSONL export with a signed trailer; never delete or update a record), § 4 (`LedgerRecord`: PostgreSQL, append-only, `seq` autoincrement, `hash` unique, filters by `suggestionId` and `chapterVersionId`, never deleted), § 4.3 (the canonical form over `{seq, kind, actor, suggestionId, chapterVersionId, payload, createdAt, prevHash}`; `hash = sha256(canonical(record))` hex lower-case; genesis `prevHash = sha256("harness-bible-ledger-genesis")`; one chain for the whole ledger ordered by `seq`, views as filters; the eight record kinds; verification from `seq = from` to `to` ending at `headHash`; export as JSONL with a signed trailer, per-chapter exports carrying chain neighbours; payloads carry hashes of free text), § 4.5 (records never deleted; the actor a pseudonymous user id; deletion keeps the pseudonym), § 7 (an assistant answer is a ledger record with message id, citations, verdicts), § 11 invariants 16, 17, 18; `context/code-standards.md` § Data and storage (`LedgerRecord` written only through `lib/ledger/append()`, which canonicalises, hashes, links `prevHash` and inserts in one transaction with `SELECT … FOR UPDATE` on the chain head), § Testing (`lib/ledger/` pure, 100 % branch coverage), § Folder map (`lib/ledger/` `canonical.ts`, `hash.ts`, `append.ts`, `verify.ts`, `export.ts`; `lib/db/ledger.ts`); `context/project-overview.md` § Success criteria · Phase 2 ("every answer is a ledger record with citations, verdicts, guide version and model id, and the chain verifies") and Phase 4 (chain verification from submission to merge; per-chapter exports with neighbours). The screens fix the display: `chained · sha-256, first 12 hex`, `prev b18e44f02d97 · hash 9b41d2e07a3c` per record, `chain check 10 records · every prev-hash matches` (Improve-Record, Chapter-History), `hash 8c21f04e9ab3 · prev 3f7a91c2d0e5` on an answer (Assistant-Answer).

Prerequisite specs: none for the pure module. `13-assistant-agent.md` produces the first record's contents; `15-conversations-api.md` writes it. The Phase 4 kinds are named here so the schema does not change when they arrive.

Scope: tracker unit 28. The pure module (`lib/ledger/`), the `LedgerRecord` model and its migration, the append path, verification, the JSONL export with its signed trailer, the record-kind payload schemas that exist in Phase 2 (`answer`, `export`), and the display helper for hashes. Not here: the Phase 4 kinds' payloads beyond their names, `AuditExport` and the export endpoint (Phase 4, `ExportWorkflow`), any screen.

## 1. Purpose

Anything a person or an auditor will ask about later is a record in one chain: each record hashes its own contents and the previous record's hash, so a change to any record breaks every hash after it. The chain is the product's memory of decisions, answers and exports, and the reason the Improve-Record page can say "every prev-hash matches" rather than "trust us". In Phase 2 the first records are assistant answers; the module is built once, pure, and tested to every branch, because every later phase appends to it and none may edit it.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| `pipeline/renderHash.ts` has a `canonicalJson` (sorted keys, no whitespace, Dates as ISO) | not reused: RFC 8785 differs on number and string serialisation; the ledger's canonicaliser is its own, and the pipeline keeps its hash stable (D1) |
| `User` rows (done) | the actor is a user id, or a service identity |
| A platform signing key (`LEDGER_EXPORT_KEY`, § 7) | the export trailer's signature |

Build order: 28a `lib/ledger/canonical.ts` and `hash.ts` with the RFC 8785 test vectors → 28b the `LedgerRecord` model, migration `0010_ledger`, `lib/ledger/append.ts` and `lib/db/ledger.ts` with the concurrency test → 28c `verify.ts` and `export.ts` with the trailer and the neighbour rule → 28d the payload schemas (`lib/schemas/ledger.ts`) and the display helper → verification.

## 3. Canonical form and hash (28a)

### 3.1 `canonical.ts`

`canonicalize(value: JsonValue): string` implements RFC 8785 (JSON Canonicalization Scheme): object members sorted by the UTF-16 code units of their names, no whitespace, strings serialised with JSON's minimal escaping (control characters as `\uXXXX` in lower-case hex, `"` and `\` escaped, everything else literal including non-ASCII), numbers in ECMAScript `Number.prototype.toString` form (integers without a decimal point, no exponent for magnitudes below 1e21, `-0` as `0`), `true`, `false`, `null`; arrays in order. Input is restricted to JSON values: the type refuses `undefined`, `Date`, `bigint`, `NaN` and `Infinity` at compile time, and the function throws on them at run time (a record with a non-finite number is a defect, not something to round). The test file carries the RFC's own vectors (the appendix examples, including the number and Unicode cases) and one adversarial object with keys that sort differently by code unit and by code point.

### 3.2 `hash.ts`

`sha256Hex(text: string): string` (lower-case hex over UTF-8), `GENESIS_PREV_HASH = sha256Hex("harness-bible-ledger-genesis")` (a compile-time constant, its literal value pinned in the test), `recordHash(record: HashableRecord): string = sha256Hex(canonicalize(hashable(record)))` where `hashable` is exactly `{seq, kind, actor, suggestionId, chapterVersionId, payload, createdAt, prevHash}` with `createdAt` as an ISO-8601 UTC string with millisecond precision and nulls kept (a null `suggestionId` is part of the hashed form). `shortHash(hash) = hash.slice(0, 12)` is the display form the screens use (`chained · sha-256, first 12 hex`).

## 4. The record and the append path (28b)

### 4.1 Schema (migration `0010_ledger`)

```prisma
enum LedgerKind { SUBMITTED GRADED SENSORS DECIDED CURATOR MERGED ANSWER EXPORT }

model LedgerRecord {
  seq              Int         @id @default(autoincrement())
  kind             LedgerKind
  /** A pseudonymous user id, or a service identity (`service:adjudicator`, `service:export`); never a name or e-mail. */
  actor            String
  suggestionId     String?
  chapterVersionId String?
  /** The kind's payload (lib/schemas/ledger.ts); free text appears only as sha256 hashes. */
  payload          Json
  createdAt        DateTime    @default(now())
  prevHash         String
  hash             String      @unique

  @@index([suggestionId, seq])
  @@index([chapterVersionId, seq])
  @@index([kind, createdAt])
}
```

Raw SQL in the migration (`RAW_SQL.md`): a trigger `ledger_append_only` that raises on `UPDATE` and `DELETE` of `LedgerRecord`, so the database itself refuses what invariant 16 forbids, whatever the client code does; and a `CHECK (hash ~ '^[0-9a-f]{64}$' AND "prevHash" ~ '^[0-9a-f]{64}$')`. `LedgerRecord` is not a tenant model (the platform owns the chain; per-account views are filters at the query layer) and is listed in `lib/db/client.ts` as append-only: the extension throws `LEDGER_APPEND_ONLY` on any `update`, `upsert`, `delete`, `deleteMany` or `updateMany` before the trigger would.

### 4.2 `append.ts`

```ts
interface AppendInput { readonly kind: LedgerKind; readonly actor: string; readonly suggestionId: string | null; readonly chapterVersionId: string | null; readonly payload: LedgerPayload }
export async function append(input: AppendInput, deps?: { now?: () => Date }): Promise<LedgerRecord>
```

In one transaction: `SELECT seq, hash FROM "LedgerRecord" ORDER BY seq DESC LIMIT 1 FOR UPDATE` (the chain head; the genesis prev-hash when the table is empty; the row lock serialises concurrent appends), then `seq = head.seq + 1`, `createdAt = now()`, `prevHash = head.hash`, `hash = recordHash(...)`, then the insert. The payload is validated by the kind's schema (§ 6) before the transaction opens; a payload that fails is a thrown `AppError("LEDGER_PAYLOAD", …)` and nothing is written. `append` is the only exported writer; `lib/db/ledger.ts` holds the queries (head, range, filtered views, neighbours) and nothing that writes.

The autoincrement and the computed `seq` must agree: the insert names `seq` explicitly (the sequence is advanced with `setval` in the same transaction), so a gap in `seq` cannot appear and a concurrent writer that read a stale head fails on the primary key, retries once after re-reading the head (the row lock makes this rare), and surfaces `LEDGER_CONFLICT` after that. The concurrency test (§ 9.2) runs twenty appends in parallel and expects `seq` 1…20 with an unbroken chain.

### 4.3 Who appends

- Phase 2: spec 15 appends `ANSWER` from the answer flow's result (in the workers, after the final SSE event is built and before it is sent, so the event can carry `hash` and `prev`: the screen's `hash 8c21f04e9ab3 · prev 3f7a91c2d0e5`), and the export script appends `EXPORT`.
- Phase 4: the workflows append the six suggestion kinds (invariant 17: the workflow, never the route handler).
- Nothing else. A code search for `ledgerRecord.create` outside `lib/ledger/append.ts` is a CI failure (§ 9.5).

## 5. Verification and export (28c)

### 5.1 `verify.ts` (pure)

```ts
interface ChainCheck { readonly ok: boolean; readonly records: number; readonly from: number; readonly to: number; readonly firstBreak: { seq: number; expected: string; found: string } | null; readonly headHash: string | null }
export function verifyChain(records: readonly LedgerRecord[], opts?: { prevOfFirst?: string; expectHead?: string }): ChainCheck
```

Recomputes every hash from its fields, checks each `prevHash` against the previous record's `hash` (the first against `prevOfFirst`, which is the genesis hash for a full chain or the neighbour's hash for a filtered view), checks `seq` is contiguous, and compares the last hash with `expectHead` when given. It stops at the first break and names it. `verifyView(records, neighbours)` runs the same on a filtered set (a suggestion's or a chapter's records) using the two chain neighbours outside it (the record before the first and after the last, by `seq`): the Improve-Record line "chain check 10 records · every prev-hash matches" is this call; gaps between the view's records are allowed (other suggestions' records sit there) and each record's `prevHash` is checked against its own predecessor's `hash` as recorded, which the export carries (§ 5.2).

### 5.2 `export.ts`

```ts
interface ExportScope { readonly kind: "all" | "suggestion" | "chapter" | "account"; readonly id?: string; readonly from?: Date; readonly to?: Date }
export async function exportJsonl(scope: ExportScope, sink: Writable, deps: { key: ExportKey; now: () => Date }): Promise<ExportTrailer>
```

Writes one canonical record per line (the hashed form plus `hash`), then the trailer line `{ "trailer": { headHash, fromSeq, toSeq, records, scope, exportedAt, signature } }`. For a filtered scope each line also carries `predecessor: { seq, hash }` (its chain predecessor, whichever scope that record belongs to), so a per-chapter or per-suggestion export verifies without the other records' payloads (architecture § 4.3). `signature` is an Ed25519 signature over the canonical trailer without the `signature` field, by the platform export key (`LEDGER_EXPORT_KEY`, a PEM in the workers' and the export script's environment; the public key is published at `/.well-known/hb-ledger-key` in Phase 4; until then it sits in `infra/ledger/export-public.pem`). `verifyExport(lines, publicKey)` (pure) re-verifies a file: every line's hash, the chain through predecessors, the head, the signature. The `account` scope filters `actor` to the account's pseudonymous ids and is Phase 4's `AuditExport`; in Phase 2 only `all`, `suggestion` and `chapter` are reachable, through `npm run ledger:export -- --scope <…> --out <file>`, which itself appends an `EXPORT` record (architecture § 4.3: the export is a ledger record) after the file is written.

## 6. Payloads (`lib/schemas/ledger.ts`, 28d)

One zod schema per kind; `LedgerPayloadSchema` is the discriminated union on `kind`. Phase 2 defines two and names the rest:

```ts
const AnswerPayloadSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  releaseId: ReleaseIdSchema,
  mode: ModeSchema,
  refusal: z.object({ cause: RefusalCauseSchema, beforeRetrieval: z.boolean() }).nullable(),
  citations: z.array(z.object({ sectionId: SectionIdSchema, figureId: FigureIdSchema.nullable(), version: z.string(), editionLang: z.enum(["EN", "PT"]) })),
  claims: z.object({ total: z.number().int(), substituted: z.number().int() }),
  verdicts: z.array(z.object({ sensor: z.string(), verdict: z.enum(["PASS", "FAIL", "WARN", "NA"]) })),
  grounded: z.number().min(0).max(1).nullable(),
  repaired: z.boolean(),
  guide: z.object({ version: z.string(), sha256: z.string().length(64) }),
  modelId: z.string(),
  promptSha256: z.string().length(64),
  questionSha256: z.string().length(64),        // the question's text never; its hash, so a purged conversation still matches its record
  answerSha256: z.string().length(64),
  timings: z.object({ firstTokenMs: z.number().nullable(), totalMs: z.number() }),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int() }),
  traceId: z.string(),
});
const ExportPayloadSchema = z.object({ scope: ExportScopeSchema, fromSeq: z.number().int(), toSeq: z.number().int(), records: z.number().int(), headHash: z.string().length(64), fileSha256: z.string().length(64) });
```

Characters a payload may carry (decided 2026-09-24, unit 38): every string in a payload, and every key, must be one PostgreSQL's `jsonb` can store. A null character (U+0000) and an unpaired surrogate are valid JavaScript strings and valid JSON but not storable, and without a check they reach `append`'s transaction and fail there as a raw driver error, after the head lock is taken. `LedgerPayloadSchema` therefore walks the payload and refuses both as `LEDGER_PAYLOAD`, naming the path, before the transaction opens; `unstorableText` and `firstUnstorable` in `lib/schemas/ledger.ts` are the check. Nothing is transformed: a caller that wants such a string in the ledger hashes it, as every free-text field already does.

`SUBMITTED`, `GRADED`, `SENSORS`, `DECIDED`, `CURATOR`, `MERGED` are `z.object({}).passthrough()` placeholders that Phase 4 replaces (their fields are architecture § 4.3's); `append` refuses them until then (`LEDGER_KIND_NOT_YET`), so no Phase 2 code can write a Phase 4 kind by accident. Every free-text field across all kinds is a `sha256` of the text, never the text (invariant 18); the schema names end in `Sha256` so a reviewer sees it. **Replaced in unit 46c (2026-10-05):** each has its strict payload, with `RESEARCH` and `ENDORSED` beside them, and `append` admits all of them (feature-specs/29 § 5, § 13).

The display helper `ledgerLine(record)` returns `{ short: "8c21f04e9ab3", prevShort: "3f7a91c2d0e5", seq, kind, createdAt }` for the screens' `hash … · prev …` line; it lives in `lib/ledger/display.ts` and is the only ledger module the web tier renders from besides the queries.

## 7. Environment

| Variable | Where | Meaning |
|---|---|---|
| `LEDGER_EXPORT_KEY` | workers, the export script | Ed25519 private key (PEM) signing export trailers; absent = exports refuse (`LEDGER_KEY_MISSING`), appends still work |
| `infra/ledger/export-public.pem` | repository | the public half, for `verifyExport` and CI |

The development key pair is generated by `npm run ledger:keygen` into git-ignored paths and the public half copied to `infra/ledger/`; production keys live in the vault.

## 8. Out of scope

- `AuditExport` rows, the `POST /org/audit-exports` endpoint, signed URLs, object storage, the four-per-day limit (Phase 4, `ExportWorkflow`).
- The Chapter-History and Improve-Record screens (Phase 4); the answer's `hash · prev` line on the dock is spec 17's, from `ledgerLine`.
- Merkle anchoring or external timestamping of the head hash: not in the TRD; a later decision if an auditor asks.
- Rewriting the pipeline's `canonicalJson` to RFC 8785 (D1).

## 9. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Unit, `canonical.ts`: the RFC 8785 appendix vectors byte for byte; key ordering by UTF-16 code unit on a mixed-script object; numbers (`1e21`, `0.1`, `-0`, `1.0`, large integers) in ECMAScript form; a `Date`, `undefined`, `NaN` refused; 100 % branch coverage reported by vitest's coverage for `lib/ledger/**` and enforced in CI (`--coverage.thresholds.branches=100` scoped to the folder).
2. Unit, `hash.ts` and `append.ts`: the genesis constant's literal value; the hashable form's key set and null handling; two records with the same contents but different `prevHash` hash differently; twenty parallel appends produce `seq` 1…20 with a verifying chain (integration, against the database); the trigger refuses an `UPDATE` and a `DELETE` at the database level and the client extension refuses them before the database; a Phase 4 kind is refused with `LEDGER_KIND_NOT_YET`; a payload with a free-text field where a hash is expected fails the schema.
3. Unit, `verify.ts`: a chain of 30 verifies; altering one payload breaks at that `seq` and names the expected and found hashes; altering `createdAt` breaks; a filtered view of every third record verifies with its neighbours and predecessors; an `expectHead` mismatch is named.
4. `export.ts`: an `all` export of 30 records round-trips through `verifyExport`; a `chapter` export carries predecessors and verifies without the other chapter's payloads; a byte flipped in one line fails; a trailer signed by another key fails; the export appends an `EXPORT` record whose `fileSha256` matches the file; the script refuses without `LEDGER_EXPORT_KEY`.
5. Scope: `grep -rn "ledgerRecord\.\(create\|update\|upsert\|delete\)" --include="*.ts" --exclude="*.test.ts" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=generated . | grep -v "lib/ledger/append.ts"` returns nothing, and CI runs that grep. The exclusions are the integration test (it must call `update` and `delete` to show the guard and the trigger refuse them) and the generated client's doc comments; `upsert` is in the set because the guard refuses it too.
6. Invariant check: 16 (trigger, extension guard, one writer), 17 (no route handler imports `append`: a grep over `app/` and `lib/api/`), 18 (schemas carry `*Sha256` fields, never text).

## 10. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Canonical JSON implementation | A a new RFC 8785 canonicaliser in `lib/ledger/` / B reuse `pipeline/renderHash.ts`'s `canonicalJson` | **A**: the pipeline's form (JSON.stringify numbers, Dates as ISO) is not RFC 8785 and changing it would change every render hash; the ledger's must be the RFC so an external verifier can recompute it |
| D2 | Trailer signature algorithm | A Ed25519 / B HMAC-SHA256 with a shared secret | **A**: an auditor verifies with the public key alone; HMAC would require sharing the secret |
| D3 | `seq` assignment | A computed from the locked head and set explicitly / B database autoincrement alone | **A**: the hash covers `seq`, so it must be known before the insert; the row lock on the head makes it consistent, the primary key makes a stale read fail loudly |
| D4 | The answer record's text fields | hashes of the question and the answer, never the text | **as stated**: invariant 18; the conversation row holds the text for 30 days, the record outlives it |
| D5 | Phase 4 kinds before Phase 4 | A named in the enum, refused by `append` / B absent until then | **A**: the migration is written once; the guard keeps them unreachable |
