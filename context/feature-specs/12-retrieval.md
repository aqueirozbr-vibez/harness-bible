# 12 · Retrieval — feature spec (embeddings, the hybrid rank, the re-ranker, the assistant's context)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `context/architecture.md` § 1 (PostgreSQL with pgvector and tsvector; the re-ranker: a small cross-encoder via the gateway, top 40 to top 8 before the assistant drafts, citation precision being the Phase 2 gate), § 3.1 (`lib/search/`: the single hybrid SQL, tsvector rank fused with pgvector cosine; no re-rank on the search page), § 4 (`Section.embedding vector(1024)`, HNSW; the embedding stage, which D3 placed in the workers, so § 4.5 there no longer names it as the pipeline's — amended review round 2, 2026-09-24), § 6.1 (the assistant may read retrieved sections; prefix slot 4), § 6.3 (`AnswerWorkflow`: hybrid retrieval with the release filter, top 8 after re-rank), § 8 (retrieval and re-rank budget 600 ms inside the 2 s first-token budget; the scope check runs in parallel with retrieval), § 11 invariants 1, 3, 6; `context/feature-specs/06-search.md` § 5.2 (the seam: the vector CTE and reciprocal-rank fusion left as a comment, `timings.vectorMs` null, the instrument row `vector — · phase 2`; D2), `04-content-domain-schema.md` § 3 (`embedding vector(1024)?`, filled in Phase 2) and D8 (pgvector deferred: no Windows build); `11-model-gateway.md` § 3.2 (`hb-embed` and `hb-rerank` aliases left to this spec), § 4 (the stub gateway), § 5 (the client every gateway call goes through).

Prerequisite specs: `06-search.md` (the statement and its seam), `11-model-gateway.md` (the gateway, the stub, the workers).

Scope: tracker unit 26. The vector column and its index, the embedding job that fills it, the query embedding, the fused rank in the existing statement, the re-ranker, the retrieval function the assistant calls with its per-mode scoping, and the search page's `vector` row switching on. Not here: the scope sensor and the prompt (spec 13), the conversation (spec 15).

## 1. Purpose

The assistant answers only from sections it was shown, so what it is shown decides what it can cite. Retrieval must find the right sections of the pinned release for a question in the reader's words, not the book's, and hand the model a short, ordered set it can cite precisely. Lexical rank alone finds the book's vocabulary; the vector half finds the reader's; the re-ranker reads the question against each candidate and keeps the eight that answer it. The same fused rank improves the search page, where no re-ranker runs (architecture § 3.1).

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Docker on the development machine (done) and the compose `db` service (`pgvector/pgvector:pg17`; `pg16` until unit 26a, § 8) | pgvector has no Windows build for the local PostgreSQL 17 (04 D8); the migration creates the `vector` extension, so the development database moves to the container (§ 8, D5) |
| The gateway, its client and the stub (spec 11, unit 25) | embeddings and re-ranking are gateway calls with the principal's key; the stub answers them deterministically in dev and CI |
| The workers container (spec 11) | the only place a gateway key exists: the embedding job and the query embedding run there |
| `Section.textEn` (06 § 4.3), the chapter title prefixed | the text that is embedded and re-ranked, already the search index's input |

Build order: 26a the migration and the embedding job (`Section.embedding`, `embeddingModel`, `embeddedAt`, the HNSW index; `workers/embed.ts` and `npm run embed:release`; the stub's `/v1/embeddings`) → 26b the fused rank in `lib/search/hybrid.ts` and the search page's `vector` row through the workers' query-embedding route → 26c the re-ranker (`lib/gateway/rerank.ts`, the stub's `/rerank`) and `lib/search/retrieve.ts` with the per-mode scoping the assistant calls → verification.

## 3. Models (extends spec 11 § 3.2)

| Alias | Pinned target | Why |
|---|---|---|
| `hb-embed` | `infinity/BAAI/bge-m3` (1,024 dimensions, the column's size) | self-hosted since 2026-09-25 (Andre, 2026-09-24: self-host, but so a service can replace it later). MIT, multilingual for the PT editions, an 8,192-token window, and **1,024 dimensions**, which is what `Section.embedding` already is: the one property that makes a later move to a provider a configuration edit and a re-index rather than a migration |
| `hb-rerank` | `infinity/BAAI/bge-reranker-base` | a cross-encoder scoring a query against each document, the TRD's "small cross-encoder"; MIT, multilingual, 278M parameters with a 512-token window. A re-ranker returns a score, not a vector, so unlike the embedder it carries no dimension constraint and the smallest usable model wins |

Both run in the compose services `embeddings` and `reranker` from one pinned image, one model each, pinned by revision, with no published port and no route off the host once their weights are cached. The application never learns they exist: it asks the gateway for an alias, and `infra/gateway/litellm.yaml` alone maps the alias to a container, which is the whole of the coupling a swap has to undo (§ 3.1 below). Both calls go through `lib/gateway/` with the principal's key, are ledger rows of kind `EMBED` and `RERANK` (spec 11 § 6) and count against the same budget; the ledger's cost for them uses the provider's published per-token price, added to `prices.ts` with its date.

### 3.1 Swapping the two aliases for a service

Measured on the development machine (16 cores, no GPU, 2026-09-25) and recorded so the trade is explicit, not discovered later:

| | Self-hosted here | What a service or a GPU host buys |
|---|---|---|
| Warm query embedding | 133 ms, inside § 8's 600 ms budget | the same or better |
| One 6,000-character section | 5.2 s, so a release is a half-hour batch | minutes |
| Re-rank of 40 candidates | 8.9 s at the p50 of a 50-question run, against 257 ms without it | inside the budget |
| Recall with the local re-ranker | **worse**: 16 of 50 in the eight, against 18 without it | the improvement a re-ranker is for |
| A 32,250-character section (the book's longest) | killed by the OOM killer; 16,000 characters is the measured bound (§ 4.2) | accepted whole |

The re-rank overrun is deliberate and bounded: `Retrieved.overBudget` records it and an answer is never refused for it (§ 7.2). **The local stack does not run the re-ranker at all** (`docker compose up db gateway embeddings`): measured over 50 figure questions of the golden set on 2026-09-25, the fused order put the expected section in the eight 18 times and the cross-encoder 16, at 257 ms against 8.9 s, because on a processor the model can only be shown each section's first `RERANK_DOCUMENT_CHARACTERS` and the figure a question asks about is usually deeper in. `rerank` then raises and retrieval keeps the fused order, which is D8's documented degradation rather than a failure. The step stays in the design and in the code path; what it needs to earn its place is the hardware or the service that lets it see whole sections quickly. The procedure, when a service replaces either model: edit that alias's four lines in `infra/gateway/litellm.yaml` (the target, the `api_base`, the key), put the provider key in `infra/gateway/.env`, update the pin constants in `lib/gateway/prices.ts` (which `tests/gateway-config.test.ts` compares with the YAML, so a half-done swap fails there), and re-index the release — the vectors of one model are not comparable with another's, whatever their width. No migration follows a swap to a 1,024-dimension model; another width needs one, and `Section.embedding`'s type is the only reason why.

Embeddings are versioned: `Section.embeddingModel` holds the pinned target string. A pin change re-embeds the release (§ 4.2) before the new alias is used; the query and the stored vectors are always from the same model.

## 4. Embeddings (26a)

### 4.1 Schema (migration `0009_embeddings`)

```prisma
model Section {
  // …
  embedding       Unsupported("vector(1024)")?     // cosine; null until the embedding job ran
  embeddingModel  String?                          // the pinned target that produced it ("voyage/voyage-3")
  embeddedAt      DateTime?
}
```

Raw SQL in the migration (`RAW_SQL.md`): `CREATE EXTENSION IF NOT EXISTS vector;` and `CREATE INDEX "Section_embedding_hnsw" ON "Section" USING hnsw (embedding vector_cosine_ops);`. The three columns are outside the content hash (the hash covers what the book says, not what a model computed from it) and outside `contentHash`'s inputs by construction (the pipeline never sees them).

### 4.2 The embedding job (`workers/embed.ts`, `npm run embed:release`)

Runs in the workers container after every ingestion and whenever `hb-embed`'s pin changes. For the current release (or `--release <id>`): every `Section` whose `embedding` is null or whose `embeddingModel` differs from the pin, in chapter order, in batches the operator names (`--batch`), each batch one `hb-embed` call with the section's `textEn` (the chapter title and the layer's prose, 06 D1; a layer-9 section embeds its rows' claims and citations joined, since its `textEn` is the table's prose only). Writes the three columns in one update per batch.

**How much of a section is embedded (2026-09-25).** `--max-chars <n>` is required beside `--batch`, and the run reports `truncated`, the number of sections whose text was longer. Neither is invented in code: what a long section's vector *should* represent is a product decision nobody has made and is on the record under Open Questions, while what the machine can serve is measurable — the self-hosted embedder returns a 16,000-character section in 26 s and is killed by the OOM killer at 24,000, because attention cost grows with the square of the length. The release was re-indexed at 16,000, which cut 20 of its 362 sections. A cut tail is not lost: `Section.tsv` indexes the whole text and retrieval is hybrid (§ 7), so those passages stay findable by word and only lose the vector half. A service that accepts long inputs removes the bound without any other change.

The write is a content-table update, which invariant 3 reserves for the pipeline under `PIPELINE=1`. The job runs under `EMBED=1`, and the client extension (`lib/db/client.ts`) admits, under that flag alone, updates to `Section` that touch only `embedding`, `embeddingModel` and `embeddedAt` (D3). Every other content write stays refused. `RAW_SQL.md` lists the `vector` cast the update needs (`$executeRaw` with `::vector`).

Idempotent and resumable: a re-run embeds only what is missing or stale; a batch failure (`GatewayUnavailableError`, `BudgetExceededError`) stops the job with the count done and the count left, and the next run continues. The job's principal is the platform's own key (`metadata.kind: "platform"`, spec 11 § 3.4; D4), so a reader's budget never pays for indexing.

`embedReleaseStatus(releaseId)` (in `lib/db/search.ts`) reports `{ sections, embedded, model }`; the search instrument and the Phase 2 gate read it. A release is "vector-ready" when `embedded === sections` at the current pin.

### 4.3 The query embedding

`POST /embed/query` on the workers' surface (spec 11 § 7.2 gains the route): `{ text, principal }` → `{ embedding: number[1024], modelId, ms }`, one `hb-embed` call of kind `EMBED` on the principal's ledger. The assistant (workers-side) calls the function directly; the search page (web-side) calls the route through `lib/workers/client.ts` with a 150 ms timeout (§ 6, D6).

## 5. The fused rank (26b, `lib/search/hybrid.ts`)

The statement gains an optional `$embedding` parameter. When present, the seam of 06 § 5.2 becomes real:

```sql
vec AS (
  SELECT s.id AS pk, row_number() OVER (ORDER BY s.embedding <=> $embedding) AS vpos
  FROM "Section" s JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId"
  WHERE cv."releaseId" = $release AND s.embedding IS NOT NULL
  ORDER BY s.embedding <=> $embedding LIMIT 50
),
lex AS (SELECT pk, row_number() OVER (ORDER BY lexical DESC) AS lpos FROM base WHERE lexical > 0)
…
rank = COALESCE(1.0 / (60 + lpos), 0) + COALESCE(1.0 / (60 + vpos), 0)   -- reciprocal-rank fusion, k = 60 (06 § 5.2)
```

Amended review round 2, 2026-09-24: `vec` runs only for a query whose tsquery carries a lexeme (`q.tsq IS NOT NULL AND numnode(q.tsq) > 0`). `websearch_to_tsquery('english','the of and')` is an EMPTY but NOT NULL tsquery, so without that gate a stop-word-only query matched nothing lexically and still took the 50 nearest sections: 06 § 5.2's "an empty or stop-word-only query yields zero hits" was false and `search.empty.stop` was unreachable. With the gate the rule is enforced by the statement rather than asserted by the spec, and no number had to be chosen.

The 50 that do enter have no distance floor, so every lexeme-bearing query's set is widened by up to 50 sections that matched nothing the reader typed, and the page's count is a fused count (06 § 5.2, § 7). Whether a floor belongs there is a measurement, not a patch: a single global cosine floor inverts the intent on this machine's stub embedder (a stop-word query's vector sits near the corpus centroid at distance 0.25-0.34 while `idempotency` sits at 0.91-0.98), and no real embedder exists here to measure against. It is an Open Question attached to the provider decision (the tracker), together with § 12.6's recall number; if anything is wanted sooner, a query-relative floor (vector-only candidates within a factor of the query's own nearest distance) survives both a stub and a real embedder, but it is still a number and is Andre's to give.

Sections come from both halves; labs and source rows have no embedding in Phase 2 and keep their lexical rank alone (their `vpos` is null). A section in the vector top 50 that the lexical half did not match (`tsv @@ tsq` false) still enters `base` when `$embedding` is given (the base's `WHERE` becomes `tsq IS NULL OR tsv @@ tsq OR s.id IN (SELECT pk FROM vec)`), which is how the reader's vocabulary reaches the book's. Filters stay WHERE clauses on the fused set; facets count the fused set; `sort = relevance` orders by `rank`. Without `$embedding` the statement is exactly today's.

`RawSearchResult` gains `vectorMs` (the embedding call's time, measured by the caller) and each hit `lexicalPos`, `vectorPos` (null when absent). `SearchData.timings.vectorMs` stops being null when the vector half ran; the Query instrument's row reads `vector · N ms` (06 § 6.5), or `vector — · unavailable` when the workers or the gateway did not answer in time (§ 6), or `vector — · indexing` when the release is not vector-ready.

## 6. The search page (26b, web side)

`getSearchData` asks the workers for the query embedding before the statement, in parallel with nothing (the statement needs it), with a 150 ms timeout: on a timeout or an error it runs the lexical statement and reports the reason in the instrument. Search never fails because the vector half did: it is a read of the book (D6). The 500 ms page budget holds: embedding under 150 ms, the statement about 30 ms today, the fused statement measured in § 12. The `search.query.vector*` strings of 06 § 8 gain `unavailable` and `indexing` (EN `unavailable` / `indexing`, PT `indisponível` / `indexando`, candidates).

A stop-word-only query still costs one `/embed/query` call and one `EMBED` ledger row, because whether the reader's words survive `websearch_to_tsquery` is only known inside the statement and § 5's gate is applied there; avoiding it would be a second round trip to PostgreSQL before the one the page already makes, which is not worth a quarter of the page budget (review round 2, 2026-09-24). The vector row still reads `vector · N ms`: nothing failed, the half simply found no lexeme to fuse with.

The half runs **for everyone**, signed out included (Andre's answer of 2026-09-24, reversing this section's earlier reading that it is for signed-in readers by design). The call still needs a principal to charge, and an anonymous reader has none, so one is named in the environment: `GATEWAY_ANONYMOUS_PRINCIPAL=org:<organisationId>` or `user:<userId>`, the form `GATEWAY_CHECK_PRINCIPAL` already uses, read through `lib/env.ts` and parsed by `principalOfId` (unit 37c, 2026-09-24). Set, a signed-out reader's query is embedded on that principal's key and the Query instrument shows its milliseconds; unset, `vectorPlan` returns `unavailable` and the page is the lexical one, exactly as before. Two consequences, recorded in architecture § 12: an anonymous visitor spends that principal's budget, with the public read rate limit (120/min/IP in the handler, the edge's per-IP limit on the page) as the only guard; and D4's platform principal *kind* — the two `CHECK` constraints, the `Principal` union, the tenant guard's principal column and `workers/keys.ts` — stays deferred until billing, because this configured principal is an ordinary organisation or user and needs none of it.

No re-rank on the search page (architecture § 3.1): the fused rank is the page's rank.

## 7. The re-ranker and the assistant's retrieval (26c)

### 7.1 `lib/gateway/rerank.ts`

`rerank({ principal, query, documents: [{ id, text }], topN })` → `[{ id, score }]` ordered by score, one `hb-rerank` call of kind `RERANK`. The document text is the section's `textEn`; when the provider's document limit is below a section's length the first part is sent and the hit carries `truncated: true` (Phase 2's sections are 1,500 to 33,000 characters; the limit is the pinned model's own window, which since 2026-09-25 we serve ourselves and can therefore read: `BAAI/bge-reranker-base` takes 512 tokens for the query and the document together, so `RERANK_DOCUMENT_CHARACTERS` is 1,000 — the window less the composer's 800-character question, at a conservative 3.5 characters a token for mixed EN and PT. It also bounds the latency the measurement in § 3.1 records).

Built 2026-09-23 (unit 26c) as `rerank(call, { query, documents, topN })` → `{ hits: [{ id, score, truncated }], modelId, usage, ms }`, the call being the same `GatewayCall` minus its alias and purpose that `embedTexts` takes. Nothing reads LiteLLM's model info yet, so the limit is the module constant `RERANK_DOCUMENT_CHARACTERS`, null: a document is sent whole, no hit is truncated, and the cut (`documentsFor`) is tested with a limit given, so the number is a one-line change when it arrives (architecture § 12).

### 7.2 `lib/search/retrieve.ts` (workers side)

```ts
interface RetrieveRequest {
  readonly releaseId: ReleaseId;
  readonly question: string;                   // the user's text, ≤ 800 characters (the composer's cap)
  readonly mode: "explain" | "compare" | "walk" | "lab" | "brief";
  readonly context: { readonly chapter: number; readonly section: SectionId | null; readonly chapters?: readonly [number, number]; readonly labId?: string };
  readonly principal: Principal;
  readonly traceId: string;
}

interface RetrievedSection {
  readonly sectionId: SectionId; readonly chapter: number; readonly layer: number; readonly title: string;
  readonly version: string; readonly verify: VerifyStatus; readonly editionLang: "EN" | "PT";
  readonly text: string;                       // plain text the model reads; html is never sent to a model
  readonly figureIds: readonly FigureId[];     // for the citation sensor (spec 13)
  readonly rank: { readonly lexicalPos: number | null; readonly vectorPos: number | null; readonly rerankScore: number; readonly final: number };
  readonly truncated: boolean;
}

interface Retrieved {
  readonly sections: readonly RetrievedSection[];          // ≤ 8, in rerank order
  readonly candidates: number;                             // fused set size before re-rank (≤ 40)
  readonly timings: { embedMs: number; sqlMs: number; rerankMs: number; totalMs: number };
  readonly overBudget: boolean;                            // totalMs > 600
  readonly vectorReady: boolean;
}
```

Steps: embed the question (§ 4.3) → the fused statement restricted to `kind = 'section'` and the mode's scope, `limit 40` → `rerank` the 40 against the question → the top 8 → load their `figureIds` and edition fields. Scoping by mode:

Built 2026-09-23 (unit 26c), with three readings the code fixes (architecture § 12): the always-included sections are appended after the re-ranked eight in the table's order and without duplicates, so `sections` is at most eight plus them and D7's ninth is one case of that rule; `rank.rerankScore` is nullable (an appended section, and every section when the re-ranker was refused, D8) and `rank.final` is the place in the set handed over, from 1; `editionLang` is `EN` while only `textEn` is plain text and embedded (§ 10). The lab README as a pseudo-section is not built here — `sectionId` is a branded section anchor and a README is not a `Section` row — and belongs to spec 19 (unit 33), which owns a lab's README, files and last run; lab mode scopes to the lab's chapter and always includes its `NN.4`. Part III is read from the release's own `Chapter.part`, not written as 34–40.

| Mode | Candidate sections | Always included |
|---|---|---|
| explain | the release | the context section, ranked first when it is among the eight, else appended as the ninth so the current section is always readable (D7) |
| compare | chapters `context.chapters` only | the two chapters' `NN.1` sections |
| walk | the aid's chapter | the aid's section (`NN.8`) and the derive results the caller adds (spec 18) |
| lab | the lab's chapter | the lab's README as a pseudo-section (`labId`, layer null) plus the chapter's `NN.4` |
| brief | Part III chapters (34–40) | the chapter's `NN.8` when the context is a Part III chapter |

Unverified chapters are excluded from every candidate set (the scope sensor refuses questions about them before retrieval; a verified chapter's answer must not cite an unverified one either, architecture § 6.1's unverified-chapter check). The edition is the one at parity for the reader's locale (PT when parity, else EN, 03 D6), and the answer says which (spec 13).

The 600 ms budget: `overBudget` is recorded on the message (spec 15) and in the answer's span; it never refuses an answer. When the release is not vector-ready the lexical half alone feeds the re-ranker and `vectorReady` is false. When a half is refused by the gateway the other one carries the answer: a spent budget (`BudgetExceededError`), an unreachable gateway (`GatewayUnavailableError`) and a refused request (`GatewayRefusedError`: a 400 that is not a budget message, 401, 403, 404, 413 — an alias the key may not reach, a payload the provider will not take, which is the expected trigger while § 7.1's document limit is owed and a 40-document batch goes whole) are the three typed refusals of spec 11 § 5.2, and for the re-ranker the fused order stands with the top 8 by `rank` and `rerankScore` null; the span says so (amended review round 2, 2026-09-24: `GatewayRefusedError` used to abort retrieval, against D8 and the sentence that follows). An untyped failure is a defect in retrieval's own call (`GATEWAY_EMBED_DIMENSIONS`, `GATEWAY_RERANK_EMPTY`) and still raises. Only when both halves fail is the answer refused (spec 15: 503).

Retrieval shares the statement, so it inherits § 5's lexeme gate (review round 2, 2026-09-24): a question whose words all fall out of `websearch_to_tsquery` has **no** candidates, not 50 semantic ones, and `retrieve` hands over the mode's always-included sections alone. That is the right shape here — spec 13's scope sensor refuses such a question before retrieval is asked — and it is written down rather than left for the next reader to find in the SQL.

## 8. Environment and the development database

- The compose `db` service becomes the development database: `pg_dump` from the local PostgreSQL 17 cluster into the container once (the tracker's Session Notes record the command), `DATABASE_URL` unchanged (`localhost:5432`, so the local `pg_ctl` cluster must be stopped or moved to another port). The local cluster is left on the machine as the way back to the data, not as a lexical-only fallback (amended review round 2, 2026-09-24, D5): migration `20260923210000_embeddings` raises before `CREATE EXTENSION vector` on a server that has no `vector` extension, naming this section and D5, so `prisma migrate deploy` stops there and the schema cannot be applied at all. From that migration on, the pgvector container is the only supported development database; a machine without Docker needs a pgvector build first (D5 option B), and `12.1` below is the check that the guard says so.
- The image is `pgvector/pgvector:pg17`, not the `pg16` this spec was written against (amended 2026-09-23, unit 26a; architecture § 12): a `pg_dump` 17 file opens with `SET transaction_timeout = 0`, a parameter a 16 server does not know, so the restore stopped at the first statement. The container now matches the major version of the cluster the data came from. A 17 server cannot read a 16 data directory, so the service names a new volume (`hb-pgdata-17`) and the old one is left on the machine as the way back.
- `EMBED=1` for the embedding job only; `PIPELINE=1` unchanged.
- `GATEWAY_ANONYMOUS_PRINCIPAL` (app, optional; unit 37c): the principal a signed-out reader's query embedding is charged to (§ 6). `.env.example` documents it with no value; unset leaves an anonymous search lexical.
- Voyage's key joins `infra/gateway/.env`; the stub needs none.

## 9. The stub gateway (extends spec 11 § 4)

- `POST /v1/embeddings`: a deterministic 1,024-dimension unit vector per text from a bag-of-words hash (each lower-cased token hashed to a dimension, then normalised), so identical texts embed identically and texts sharing words are close: enough for plumbing tests and for the search page's vector row to move in development.
- `POST /rerank`: scores by token overlap between the query and each document, normalised to 0–1; `top_n` respected. Built 2026-09-23 (unit 26c) as the share of the query's distinct words each document holds, in the Cohere shape LiteLLM's route normalises to (`{ id, model, results: [{ index, relevance_score }], meta.tokens }`), ties by position.
- Both accept and count against the stub's key and budget table.

## 10. Out of scope

- Embedding labs, source rows or figures (lexical only in Phase 2; a later unit when the golden set shows a gap).
- Re-ranking on the search page (architecture § 3.1 forbids it).
- Embedding the PT editions (none at parity yet; when they exist, one embedding per edition and the query embedded in the reader's locale).
- Query rewriting, multi-query, hypothetical documents: not in the TRD; the golden set decides whether they are needed.

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Embedding and re-rank provider | A Voyage AI (`voyage-3`, `rerank-2`) / B Cohere (`embed-v4`, `rerank-v3.5`) | **A**: Anthropic's named partner, 1,024 dimensions match the column, both routes exist in LiteLLM; B is the drop-in if Voyage's terms or region fail the residency review |
| D2 | Fusion constant | `k = 60` as 06 § 5.2 wrote it | **keep**: the standard reciprocal-rank constant; the golden set measures, not the spec |
| D3 | How the embedding job writes a content table | A `EMBED=1` admitting only the three embedding columns / B run under `PIPELINE=1` | **A**: invariant 3 stays exact (the pipeline is the only writer of content) with one narrow, listed exemption; B would let the job write anything |
| D4 | Whose budget pays for indexing | A a platform principal with its own key and budget / B the organisation's | **A**: indexing is per release, not per reader; a reader's cap must not move with the book's size. Amended 2026-09-24 (Andre, unit 37c): the platform principal *kind* is deferred until billing; indexing names its payer with `npm run embed:release -- --org|--user`, and a signed-out reader's query embedding is charged to `GATEWAY_ANONYMOUS_PRINCIPAL` (§ 6), both ordinary principals |
| D5 | The development database | A the compose `db` container with pgvector, data migrated / B a pgvector Windows build for the local PostgreSQL 17 | **A**: Docker is here now; B needs Visual Studio build tools and diverges from CI |
| D6 | The search page's dependence on the workers | A ask the workers for the query embedding with a 150 ms timeout and fall back to lexical / B search stays lexical-only forever | **A**: invariant 6 keeps the web tier off the gateway, and the fallback keeps search a read of the book that never fails because a model service is down; the 150 ms is a quarter of the page budget and Andre may move it |
| D7 | The current section's place in explain mode | A always readable (ranked or appended ninth) / B only when retrieved | **A**: "ask about 21.3" must be able to cite 21.3 |
| D8 | Re-ranker unavailable | A answer from the fused order without scores / B refuse | **A**: the fused order is already a rank; the span records the missing re-rank and the gate's citation rate will show whether it matters |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Migration on the compose database: the `vector` extension, the three columns and the HNSW index exist; `prisma migrate deploy` is a no-op the second time. On the local PostgreSQL 17 the migration fails on the extension with a message naming D5.
2. `npm run embed:release` against the stub: 362 sections embedded, `embeddingModel` set, `embeddedAt` set, one `EMBED` ledger row per batch on the platform principal; a second run embeds nothing; deleting ten embeddings and re-running embeds ten; `x-hb-stub-fail: 500` on the third batch stops the job with the counts and the next run completes it; the job is refused without `EMBED=1` (`CONTENT_READ_ONLY`) and `EMBED=1` cannot update `titleEn`.
3. Unit: reciprocal-rank fusion (a section first in both halves outranks one first in one; a vector-only hit enters the set; labs keep lexical rank); each of the three typed refusals of spec 11 § 5.2 on either half leaves retrieval to the other one and an untyped failure still raises (§ 7.2; `lib/search/retrieve.test.ts`, extended review round 2, 2026-09-24); mode scoping (compare restricts to two chapters and includes both `NN.1`; explain appends the context section when it is not in the top 8 and does not duplicate it when it is; brief restricts to Part III; unverified chapters never appear); the rerank document truncation flag.
4. Integration (stub embeddings; the file refuses in a `beforeAll` when the release is not vector-ready rather than letting a case return early, review round 2, 2026-09-24): the fused statement with an embedding of a section's own text ranks that section first; a query with no lexeme returns `total` 0 with the vector given, beside the vector-only `kryptonite` case's 50, so § 5's two rules are asserted together; `timings.vectorMs` is a number; the search page's Query instrument shows `vector · N ms` on `/en/search?q=idempotency`, `vector — · unavailable` with the workers stopped, `vector — · indexing` on a release with no embeddings; the page stays under 500 ms in both cases; the facets and totals with the vector half on are supersets of the lexical ones; the 20 varied queries of the search integration test still answer under the budget.
5. Retrieval: for 50 figure questions of `golden/assistant/2026.09.jsonl` (stub embeddings and stub re-rank), the expected section is among the candidates in every case where its section holds the question's label, and among the eight for the deterministic stub's overlap rule; `overBudget` false on the development machine; with the re-ranker failing the eight come back in fused order with null scores. Measured 2026-09-23 (unit 26c, `tests/integration/retrieve.test.ts`): of the first 50 figure questions of verified chapters, 37 sections hold their question's label and the expected section reaches the forty candidates in 30 of the 50, so the "every case" reading is not met by the stub's bag-of-words vectors — the generated labels are phrases like `"at eight"`, which the lexical half spreads over the whole book — while every expected section that reached the candidates also survived the re-rank into the eight, and every question's set holds the section it was asked from (D7). Both counts are asserted as floors (37 and 30), not as "more than none": the stub and the release are deterministic, so a fall in recall fails the case (review pass, 2026-09-23). Recall of the real embedder is § 12.6's measurement.
6. With a real key (Voyage in `infra/gateway/.env`): `npm run embed:release` on the current release; recall@8 of the expected section over the 150 figure questions reported in the tracker (no threshold is fixed here; the Phase 2 gate's citation rate is the criterion); the 600 ms budget measured over the same questions, p95 reported.
7. Invariant check: 1 (embeddings are outside the hash; the render hash is unchanged after the job), 3 (`EMBED=1` writes only the three columns; a `titleEn` update under it is refused; `PIPELINE=1` never writes embeddings), 6 (the web tier reaches the workers, never the gateway: `grep` for `lib/gateway/client` under `app/` and `lib/db/search.ts` returns nothing).
