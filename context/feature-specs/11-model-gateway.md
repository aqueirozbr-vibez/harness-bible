# 11 · Model gateway and workers — feature spec (LiteLLM, virtual keys, budgets, the workers container)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `context/architecture.md` § 1 (LiteLLM, self-hosted in region: per-organisation virtual keys with hard budgets enforced before the call, provider routing, version pinning, OTel export; the only path to a model), § 2 (agent workers are the only container that calls the gateway; the gateway is the only container that reaches a provider), § 3.1 (`lib/gateway/` `client.ts` and `budget.ts`; `workers/` with `workflows/`, `activities/`, `agents/`), § 3.3 (Phase 2 owns the gateway; no Temporal until Phase 4), § 4 (`BudgetLedger` keyed by organisation and month), § 5.5 (one virtual key per organisation with `max_budget` and `tpm`; `BudgetLedger` per response; the 402 "Model budget reached for this organisation; resets 01 Oct"), § 5.7 (provider keys only in the gateway vault; virtual keys only in the workers' environment), § 7 (OTel GenAI attributes per model call), § 9 (gateway unreachable refuses the model call), § 11 invariants 6, 7, 10; `context/code-standards.md` § Workers, workflows and agents (`lib/gateway/client.ts` with the organisation's virtual key, logs guide version, pinned model id and prompt hash, `BudgetExceededError` on 402; handlers never call the gateway); `context/project-overview.md` § Platform and harness. Model ids and prices come from the Claude API reference loaded for this spec (cached 2026-06-24), not from memory.

Prerequisite specs: `09-keycloak-oauth.md` (the handler pipeline, `Organisation` and `User` rows, the env schema), the Phase 2 prerequisites of 2026-09-23 (guides in `guides/`, Docker on the development machine, no Temporal in Phase 2).

Scope: tracker unit 25 (the first of Phase 2). The gateway as a configured container, the stub gateway for development and CI, the virtual keys and the budget rows, the client library every worker call goes through, and the workers container with the private channel the web tier reaches it by. No user-visible screen: the first user of this spec is spec 13 (the assistant agent) and the first endpoint is spec 15's. What this spec does not decide is the retrieval and re-ranking models (spec 12) and any prompt (spec 13).

## 1. Purpose

Every model call in the product goes through one door. The door enforces the organisation's budget before a provider sees the request, pins the model id, records what every call cost, and holds the only copy of a provider key. Application code never counts tokens to decide whether a call may proceed, never holds a provider key, and never reaches a provider from the web tier. This spec builds the door, the key that opens it, the ledger behind it, and the room on the other side (the workers) where the agents will live.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Docker on the development machine (done 2026-09-23) | the gateway is a container; the workers run as one in CI and staging |
| `Organisation`, `User` (migration `0002_accounts`), `Session` (done) | a key belongs to an organisation or, for an individual account, to a user |
| The handler pipeline (`lib/api/handler.ts`, done) | the web tier's side of the workers channel reuses its trace id and error catalogue |
| An Anthropic API key, in the gateway container only | the provider behind the gateway; absent locally, the stub gateway stands in |

Build order: 25a the gateway as code (`infra/gateway/`, compose service, the key script) → 25b the stub gateway (in-repo, deterministic) and the CI job → 25c `lib/gateway/` (client, prices, budget, errors) with the `GatewayKey` and `BudgetLedger` migration and tests against the stub → 25d the workers container (`workers/`), its private HTTP surface, health, and the web tier's client (`lib/workers/client.ts`) → verification.

## 3. The gateway (25a)

### 3.1 What runs

LiteLLM proxy (`ghcr.io/berriai/litellm:main-stable`, pinned to a tag in compose) as the service `gateway` in `docker-compose.yml`, with its configuration as code in `infra/gateway/litellm.yaml` and its own database `litellm` on the same PostgreSQL server (keys, spend, budgets; created by `infra/gateway/init.sql`). The proxy exposes the Anthropic Messages API at `/v1/messages` (LiteLLM's native Anthropic-format route), so the workers use the official Anthropic TypeScript SDK with `baseURL` pointed at the gateway and the virtual key as `apiKey`; no OpenAI-format shim.

### 3.2 Model aliases (pinned)

The application never names a provider model; it names an alias the gateway maps to a pinned id. A pin change is a configuration release, reviewed like a guide.

| Alias | Pinned target | Used by | Notes |
|---|---|---|---|
| `hb-frontier` | `anthropic/claude-opus-5` | assistant drafting, grounding grader (spec 13); adjudicator (Phase 4) | adaptive thinking is on by default on Opus 5; effort per purpose is set by the caller (§ 5.3) |
| `hb-small` | `anthropic/claude-haiku-4-5` | scope classification before retrieval (spec 13); evidence grader (Phase 4) | 200K context; no adaptive thinking on this model |
| `hb-embed` | `voyage/voyage-3` (spec 12 § 3, D1) | section and query embeddings (spec 12) | Anthropic has no embeddings endpoint; Voyage AI is its named partner; 1,024 dimensions match the column |
| `hb-rerank` | `voyage/rerank-2` (spec 12 § 3, D1) | the re-ranker (spec 12) | LiteLLM's `/rerank` route |

Prices at the pins (USD per million tokens, first-party rates, cached 2026-06-24): `claude-opus-5` $5.00 in / $25.00 out; `claude-haiku-4-5` $1.00 in / $5.00 out; cache reads at the provider's cached-input rate and cache writes at 1.25× input. These live once in `lib/gateway/prices.ts` with their date, for the ledger's cost column and the budget conversion (§ 3.4). Enforcement never uses them: the gateway tracks spend itself.

### 3.3 Provider keys and the vault

`ANTHROPIC_API_KEY` (and any later provider key) exists only in the gateway container's environment (`infra/gateway/.env`, git-ignored; a vault mount in staging and production). It never appears in the application's `lib/env.ts`, in CI's `checks` job, in a log line or in a prompt. `LITELLM_MASTER_KEY` (the key that mints virtual keys) exists in the gateway container and in the workers' environment only. The gitleaks step of CI covers `infra/gateway/`.

### 3.4 Virtual keys and budgets

One virtual key per organisation, minted through the gateway's `/key/generate` by the workers (never by the web tier) when an organisation is created or first needs one, with:

- `max_budget`: the organisation's `tokenCap` converted to USD at the pinned frontier prices (D3 below fixes the conversion), `budget_duration: "1mo"` so the gateway resets it on the first of the month;
- `tpm_limit` from `Organisation.tokensPerMinute` (a new column, § 6; D4 fixes its default);
- `metadata.organisationId`, `metadata.kind: "organisation"`;
- `models: ["hb-frontier", "hb-small", "hb-embed", "hb-rerank"]`.

Individual accounts (`User.organisationId` null, the only kind in Phase 1) get one key per user with the fixed small cap (`INDIVIDUAL_TOKEN_CAP`, D5) and `metadata.userId`. A key is rotated by minting a new one and deleting the old; `GatewayKey.rotatedAt` records it.

The key's secret is stored in `GatewayKey.keyCiphertext`, encrypted with `GATEWAY_KEY_SECRET` (AES-256-GCM, `lib/gateway/keys.ts`), a secret the workers hold and the web container does not. The web tier can therefore see that a key exists and when it was rotated, never the key.

At the cap the gateway refuses with its budget error before any provider call; the client maps it to `BudgetExceededError` carrying the reset date (the first of next month, from the key's `budget_reset_at`), and the caller renders architecture § 5.5's message. No application code counts tokens to make that decision (invariant 7).

### 3.5 Observability at the gateway

LiteLLM's callbacks are configured for Langfuse (`success_callback` and `failure_callback`), with the Langfuse keys in the gateway container only, and its OTel exporter left off until the collector exists (spec 21). Since unit 64 they carry no message body: `turn_off_message_logging` redacts the messages, the prompt and the response before Langfuse, which keeps spans, timings and costs (feature-specs/45 D6). Every response carries LiteLLM's `x-litellm-call-id` and the usage block; the client records both (§ 5.4).

Since unit 79 (feature-specs/49 § 4, § 5.2) the Langfuse keys are not the gateway's: the OTel collector is the one road to Langfuse and holds them, and compose blanks `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` and `LANGFUSE_OTEL_HOST` in the gateway's environment, which overrides its `env_file`, and the `langfuse` callback's upstream client's `UPSTREAM_LANGFUSE_PUBLIC_KEY`, `UPSTREAM_LANGFUSE_SECRET_KEY` and `UPSTREAM_LANGFUSE_HOST`. LiteLLM's Langfuse loggers read an empty value as unset, so the configured callback is disabled and sends nothing (read in the pinned image, and run there with the four blanks and no network). Unit 80 replaced it with `langfuse_otel` (`callbacks: ["langfuse_otel"]`, no `success_callback` or `failure_callback`): one OpenTelemetry span a call, typed `generation`, exported to the collector by compose's `OTEL_EXPORTER: otlp_http`, `OTEL_ENDPOINT: http://otel-collector:4318` and `OTEL_SERVICE_NAME: hb-gateway`, whose allow-lists decide what reaches Langfuse (feature-specs/49 § 5.2, § 5.5). Its parent is the call's `traceparent`, whose span id is now the model-call span's own (`GatewaySpan.span_id`; 49 § 5.3), so the generation nests under the span the product sends. `turn_off_message_logging` stays on; a failed call's text, which LiteLLM logs unredacted, the collector removes (49 § 9.2).

### 3.6 Compose and the key script

`docker compose up db gateway` brings both up; `db` is already `pgvector/pgvector:pg16`. `npm run gateway:key -- --org <organisationId>` (or `--user <userId>`) mints or rotates a key through the workers' code path (`workers/keys.ts`), so the rule "only the workers mint keys" holds on the development machine too. `npm run gateway:check` calls `hb-small` once through the client with the development key and prints the usage block; it is the smoke test for a fresh environment.

## 4. The stub gateway (25b)

Development and CI must run without a provider key (architecture § 10: `dev` uses a stub gateway). `infra/gateway/stub/` is a small Node HTTP server (`npm run gateway:stub`, port `4001`) that implements the surface the client uses and nothing more:

- `POST /v1/messages`, streaming and non-streaming, accepting the Anthropic request shape. It answers deterministically from the request: it reads the fenced retrieved sections the assembler puts in the prompt (spec 13 fixes the fence) and returns a structured answer whose claims cite those sections, so spec 13's sensors and spec 15's contract tests have something true to check; for a scope-classification request it answers with the cause named in an `x-hb-stub-cause` header or `none`; for any other request it echoes a fixed JSON object. `usage` is computed from character counts; `cache_read_input_tokens` is non-zero on the second request with the same prefix, so the caching check can run against the stub.
- `POST /v1/messages/count_tokens` by the same rule.
- `POST /key/generate`, `POST /key/delete`, `GET /key/info` with an in-memory table, so the key script and the migration tests run.
- Budget behaviour: a key minted with `max_budget` runs the stub's own spend counter and answers the budget error once it is exceeded, so `BudgetExceededError` is testable without a provider.
- A failure switch: `x-hb-stub-fail: 500 | timeout | 400` for the fail-closed tests (`400` since unit 49f, 2026-10-06: the provider refusing a well-formed request it cannot read, such as a PDF's pages or its encryption).
- An uncited-claim switch (unit 36c-2, 2026-10-04; feature-specs/22 § 3, P2.3): `x-hb-stub-claim: uncited` adds one claim to the answer, citing the first fenced section and sharing no word with any section, so the citation sensor's substitution can be watched end to end.
- The evidence grader's answer (unit 49d, 2026-10-06; feature-specs/32 § 7): an `hb-small` request with an `<evidence ` fence gets the lowest tier, or the tier `x-hb-stub-grade` names (B to G), or one of four outputs the grader's parser must refuse (`unknown-key`, `tier-a`, `long-reason`, `not-json`).
- The provider's `document` and `image` blocks (unit 49f, 2026-10-06; feature-specs/32 § 9, § 19): validated as the provider documents them — base64 with no newline, the media types, an image within 10 MB of base64 — and from a base64 source only, which is stricter than the provider because a `url` source would have it open a stranger's URL (invariant 34); text blocks only in `system`; a media block's tokens by the stub's own stated rule; and 413 `request_too_large` past 32 MB on both model routes.

The stub is not a mock library inside tests: it is a process, started by `npm run dev` beside OPA (the `dev` script gains it) and by the CI `checks` job, so the same client code and the same HTTP path are exercised. Unit tests of the client may still use an injected `fetch`.

## 5. The client (`lib/gateway/`, 25c)

### 5.1 `client.ts`

```ts
interface GatewayCall {
  readonly purpose: "assistant" | "grading" | "adjudication" | "lab" | "embed" | "rerank";
  readonly alias: "hb-frontier" | "hb-small" | "hb-embed" | "hb-rerank";
  readonly agent: AgentName;                                                                  // who calls (since unit 81; feature-specs/49 § 6.2): the generation's name, `hb.agent`
  readonly guide: { readonly agent: Agent; readonly version: string; readonly sha256: string } | null;
  readonly principal: { readonly organisationId: string } | { readonly userId: string };   // whose key, whose ledger row
  readonly traceId: string;
  readonly ref: string | null;                                                                // message id, suggestion id, run id
  readonly row?: RequestRow;                                                                  // the request row by name, where a purpose and alias have two (unit 49f)
}

export function gatewayClient(principal: GatewayCall["principal"]): Anthropic;              // SDK client on the gateway with that key
export async function callModel(call: GatewayCall, request: MessageCreateParamsStreaming): Promise<MessageStream>;
export async function callModel(call: GatewayCall, request: MessageCreateParamsNonStreaming): Promise<Message>;
```

`gatewayClient` builds an Anthropic SDK client with `baseURL: env.GATEWAY_URL`, `apiKey` decrypted from the principal's `GatewayKey` (workers only: the module throws `GATEWAY_KEYS_UNAVAILABLE` when `GATEWAY_KEY_SECRET` is absent, which is the web container's case), `maxRetries: 2` (the SDK's default: 408, 409, 429, 5xx and connection errors; never a budget error), overridden per request by the purpose's own row, `timeout` per purpose in milliseconds (§ 5.3), and `defaultHeaders` carrying `traceparent`.

`callModel` wraps every request: it stamps `metadata.user_id` with the principal (LiteLLM's per-key spend attribution), sets `model` to the alias, computes the prompt hash (§ 5.4), makes the call, and on completion writes the ledger row and the span line. Streaming calls are wrapped so the final `usage` (from `finalMessage()`) still reaches the ledger. Nothing in this module reads a model's text: it moves bytes and records numbers.

### 5.2 Errors (`errors.ts`)

| Class | When | The caller's job |
|---|---|---|
| `BudgetExceededError { resetsAt }` | the gateway's budget refusal (LiteLLM answers HTTP 400 with `ExceededBudget` in the body, or 429 with a budget message; both mapped by `isBudgetError`) | 402 with the reset date (spec 15) |
| `GatewayUnavailableError { cause }` | connection error, timeout, or 5xx after the SDK's retries | refuse the model call (architecture § 9: fail closed); 503 |
| `GatewayRefusedError { status, message }` | 400 (other than budget), 401, 403, 404, 413 from the gateway | a defect: logged with the trace id, never retried, surfaced as 500 |
| `ProviderRefusalError { category }` | HTTP 200 with `stop_reason: "refusal"` (the provider's safety stop) | the agent treats it as its one failure (spec 13: refusal cause `R-SCOPE`, no repair) |

`Anthropic.RateLimitError` (a 429 that is not a budget message) is left to the SDK's retries, then surfaces as `GatewayUnavailableError` with `cause: "rate_limit"`.

### 5.3 Request policy per purpose (`policy.ts`)

| Purpose | Alias | `max_tokens` | Thinking / effort | Timeout | Retries | Streaming |
|---|---|---|---|---|---|---|
| assistant draft | `hb-frontier` | 64,000 | adaptive (the model's default); `output_config.effort: "medium"` | 60 s | 2 | yes |
| assistant repair pass | `hb-frontier` | 16,000 | `output_config.effort: "medium"`, for its own reason (below) | 60 s (= the draft's) | 2 (= the draft's) | no |
| grounding grader | `hb-frontier` | 16,000 | `output_config.effort: "medium"` | 30 s | 2 | no |
| scope classifier | `hb-small` | 256 | none (`hb-small` refuses `output_config.effort` with a 400) | 5 s | 1 | no |
| evidence grader (unit 49d, 2026-10-06; feature-specs/32 § 7.5) | `hb-small` | 512 | none | 20 s | 2 | no |
| evidence grader, a PDF or an image (unit 49f, 2026-10-06; feature-specs/32 § 9, § 19) | `hb-small` | 512 | none | 90 s | 0 | no |
| embed, rerank | spec 12 | — | — | spec 12 | — | no |

Since unit 49f a purpose and alias may have two rows — the evidence grader's for a text and for a PDF or an image, which goes whole as the provider's block in a request of up to 32 MB, so it is tried once (a retry would send it all again) for 90 s — and the call names the one it means (`GatewayCall.row`; `limitsOfRow`, which refuses a row of another alias). A call that names none is given `limitsFor(purpose, alias)`'s row, as before.

All rows are constants in one file (`lib/gateway/policy.ts`) with the reason beside each. The numbers were Andre's to confirm under D6; on 2026-09-24 he delegated them to the implementer ("think if the numbers make sense, change if necessary"), and unit 37b checked every row against the Claude API guidance (the `claude-api` skill, cached 2026-06-24) and the installed SDK's own `RequestOptions`. Four rules the table now follows, and what each one changed:

- **`max_tokens` is a ceiling, not a target.** On `claude-opus-5` adaptive thinking is on by default and its tokens count against `max_tokens`, so the old 4,096 and 1,024 could be consumed by a long think and cut the answer itself short with `stop_reason: "max_tokens"`. The three frontier rows carry the guidance's own headroom instead — 64,000 for the streamed draft, 16,000 for the two unstreamed calls — while the answer stays the guide's 220 words, six claims and JSON envelope, and the grader's stays a small score object. Spend is bounded by the gateway's `max_budget` (invariant 7), never by this number, and the model is not told it. The SDK's own non-streaming guard (`calculateNonstreamingTimeout`, which refuses work that could outlast ten minutes) does not apply, because every row passes an explicit timeout.
- **Effort is the first-token budget's lever, and it steps down one level at a time.** `claude-opus-5` defaults to `high`, and visible text begins only after thinking ends, so the draft — a short answer grounded in retrieved sections, measured against architecture § 8's 2 s first token — runs at `medium`. Unit 37b took it to `low`; the review of unit 37 (2026-09-24) put it back one step, because the budget is the reason to step down and the only measurement that would say what a step costs the answer is the Phase 2 gate's own citation rate on the 300-question golden set and its grounding score (project-overview § Success criteria) — which needs a provider key this machine does not have. `low` is the next step down when that gate shows headroom. The grader keeps `medium`: judging is the part that benefits. **The repair has its own derivation, not the draft's**: it rewrites named uncited claims out of a draft the sensors have already judged, unstreamed, so the first-token budget is not its reason — `medium` is, because the reader is waiting on the same answer and a corrective rewrite is not the part that benefits from a longer think. Its timeout and retry count, however, must equal the draft's: `limitsFor` keys on `(purpose, alias)` and cannot tell the two apart, so the draft's row answers for both, and `policy.test.ts` asserts the equality. `Effort` keeps `high` in its union although no row holds it: it is the model's default, the level these rows came from and the one they return to if the gate affords it; `xhigh` and `max` stay out, being above the default.
- **The retry count is per row, because a timeout is retried.** The SDK's default is two retries (§ 5.2), so a row's worst-case wall clock is its timeout times its attempts: the draft and the repair 180 s, the grader 90 s. The classifier ran in parallel with retrieval under the same 2 s target and would have cost 15 s, so it allows one retry: 10 s worst case, and a 5xx costs it two attempts rather than three. Each row's reason states its own worst case, and `limitsFor(purpose, alias)` hands the pair to `client.ts`, which passes `timeout` and `maxRetries` per request — `timeout` in **milliseconds**, the unit the TypeScript SDK takes (the Python SDK takes seconds).
- **`hb-small` takes no effort setting.** `claude-haiku-4-5` answers 400 to `output_config.effort`, so the classifier's row keeps `effort: null` and `requestFor("scopeClassifier")` emits no `output_config` at all — asserted by its own test so nobody adds one later.

Prompt caching: the caller marks the guide prefix block with `cache_control: {type: "ephemeral"}` (spec 13's assembler does it; this spec's client passes it through untouched). The ledger records `cache_read_input_tokens`, and the Phase 2 gate reads it.

### 5.4 The ledger row and the span (`budget.ts`, `span.ts`)

Every completed or refused call writes one `BudgetLedger` row (§ 6) and one JSON span line (the same shape as the handler's spans until the OTel exporter): `gen_ai.system: "anthropic"`, `gen_ai.request.model` (the pinned id LiteLLM reports in the response, `hb-frontier` as the alias), `hb.guide.version`, `hb.guide.sha256`, `hb.prompt.sha256` (sha256 of the canonical request body without `metadata` and without the conversation's volatile fields: the same prefix hashes the same), `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_creation_input_tokens`, `hb.cost_usd` (from `prices.ts`), `hb.purpose`, `hb.principal`, `trace_id`, `x-litellm-call-id`, latency and first-token latency for streams. No prompt text, no answer text, no key (code-standards § Workers: nothing a model reads is serialised into a log line, and nothing the log holds could rebuild the prompt).

`monthSpend(principal)` sums the month's rows for the account meter (Phase 4's Account-Admin reads it; spec 21's dashboard rows read it).

### 5.5 What the web tier may import

`lib/gateway/errors.ts`, `prices.ts` and the `BudgetLedger` queries in `lib/db/budget.ts` are importable by the web container (it renders 402 messages and meters). `client.ts` and `keys.ts` are not: an ESLint `no-restricted-imports` rule forbids them outside `workers/` and their tests, so invariant 6 is enforced at lint time, not by discipline.

## 6. Data contract and schema (migration `0008_gateway`)

```prisma
model GatewayKey {
  id              String        @id @default(uuid())
  organisationId  String?       @unique
  organisation    Organisation? @relation(fields: [organisationId], references: [id])
  userId          String?       @unique                       // individual accounts (Phase 1's only kind)
  user            User?         @relation(fields: [userId], references: [id])
  litellmKeyId    String        @unique                       // the gateway's id for the key
  keyCiphertext   String                                      // AES-256-GCM under GATEWAY_KEY_SECRET; workers only
  maxBudgetUsd    Decimal
  tokensPerMinute Int
  createdAt       DateTime      @default(now())
  rotatedAt       DateTime?
}

model BudgetLedger {
  id               String     @id @default(uuid())
  organisationId   String?                                   // one of the two is set
  userId           String?
  month            String                                    // "2026-09"
  kind             BudgetKind                                // ASSISTANT | GRADING | ADJUDICATION | LAB | EMBED | RERANK
  alias            String
  modelId          String                                    // the pinned id the gateway reported
  inputTokens      Int
  outputTokens     Int
  cacheReadTokens  Int        @default(0)
  cacheWriteTokens Int        @default(0)
  costUsd          Decimal
  outcome          String                                    // ok | budget | unavailable | refused | provider_refusal
  ref              String?                                   // message id, suggestion id, run id
  traceId          String
  gatewayCallId    String?
  createdAt        DateTime   @default(now())

  @@index([organisationId, month])
  @@index([userId, month])
}
```

`Organisation` gains `tokensPerMinute Int` (D4). `GatewayKey` and `BudgetLedger` join the tenant guard (`organisationId`, or `userId` for individuals) and `BudgetLedger` is append-only (no update or delete path; a `CONTENT_READ_ONLY`-style guard on the client extension). `AuditExport` (architecture § 4) waits for Phase 4.

## 7. The workers container (25d)

### 7.1 What it is

`workers/` is a separate Node process (`npm run workers`, `tsx workers/main.ts`; a container in compose and CI) that holds `GATEWAY_KEY_SECRET` and `LITELLM_MASTER_KEY`, runs the agents (spec 13 onwards) and answers the web tier over a private HTTP surface. It shares `lib/schemas/`, `lib/db/` and the Prisma client with the app, and imports nothing from `app/` or `components/`. It has no public port: in compose it is on the internal network only; in staging and production it is reachable from the web container alone (network policy), and every request carries the shared bearer `WORKERS_TOKEN` (D7: a shared secret in Phase 2; mTLS with the service mesh later).

### 7.2 Surface (Phase 2; spec 15 adds the answer route)

| Route | Body | Answer |
|---|---|---|
| `GET /health` | — | `{ ok, gateway: "up" \| "down", keys: n }`; `gateway` is a cached probe of the gateway's `/health/liveliness`, refreshed every 30 s, deadlined at 3 s (`workers/health.ts` `PROBE_DEADLINE_MS`, strictly inside the route's own 5 s: see § 7.2), never a model call |
| `POST /keys/ensure` | `{ principal }` | mints a key when the principal has none; `{ litellmKeyId, createdAt }` |
| `POST /keys/rotate` | `{ principal }` | `{ litellmKeyId, rotatedAt }` |
| `POST /gateway/check` | `{ principal }` | one `hb-small` call with a fixed prompt; the usage block (the smoke test of § 3.6) |
| `POST /answer` | spec 15 | an SSE stream the web tier pipes to the browser |

`lib/workers/client.ts` is the web tier's side: `workersFetch(path, body, { traceId })` adds the bearer and the `traceparent`, times out per route, and maps a connection failure to `WorkersUnavailableError` (503 for the caller). It never sees a key.

Every route has a deadline (`ROUTE_TIMEOUT_MS`), because without one a hung workers process holds a web request until undici's 300 s header timeout and § 12.5's "within its timeout" cannot hold. The four values are Andre's, 2026-09-24, with the derivation he approved beside each:

| Route | Deadline | Derivation |
|---|---|---|
| `/health` | 5 s | a liveness check, refreshed every 30 s. The workers' own gateway probe must stay **strictly inside** this row, because the handler awaits the probe: at the same 5 s the client's signal fires first and a hung gateway reads as unavailable workers instead of `gateway: "down"`, the one thing the route exists to report. `workers/health.ts` `PROBE_DEADLINE_MS` is therefore 3 s — this row less a margin for the abort's delivery, the key count, the JSON and the hop back. The 3 s is the implementer's, not a second number of Andre's (review of unit 37, 2026-09-24); the relation, not the literal, is what `workers/server.test.ts` asserts, because the workers cannot import the web tier's route table |
| `/keys/ensure` | 10 s | one or two gateway management calls, no model call |
| `/keys/rotate` | 10 s | the same two calls, mint then delete |
| `/gateway/check` | 20 s | the scope classifier's own 5 s timeout (§ 5.3) across its attempts, plus a margin: three when Andre gave the number, two since unit 37b gave that row one retry, so the 20 s keeps a wider margin over its 10 s worst case |
| `/embed/query` | 150 ms | spec 12 § 6, D6: a quarter of the search page's 500 ms budget, after which the page runs the lexical statement alone |

### 7.3 Failure branches

Gateway unreachable: `/health` says `down`, every model call raises `GatewayUnavailableError`, the web tier answers 503 and nothing is retried against the provider (fail closed). Workers unreachable: 503 from the web tier; the reader and every Phase 1 screen keep working because none of them import the workers' client. A key missing for a principal: `/keys/ensure` mints it on first use; a mint failure (master key wrong, gateway down) is `GatewayUnavailableError`, never a silent unbudgeted call.

## 8. Environment (`lib/env.ts` and the containers)

| Variable | Where | Meaning |
|---|---|---|
| `GATEWAY_URL` | app, workers | the gateway's base URL (`http://localhost:4000` for LiteLLM in compose, `http://localhost:4001` for the stub); unset = every model call is `GatewayUnavailableError` |
| `LITELLM_MASTER_KEY` | gateway, workers | mints and deletes virtual keys |
| `GATEWAY_KEY_SECRET` | workers | decrypts `GatewayKey.keyCiphertext`; absent in the web container by design |
| `GATEWAY_ANONYMOUS_PRINCIPAL` | app | the principal a signed-out reader's query embedding is charged to, `org:<id>` or `user:<id>` as `GATEWAY_CHECK_PRINCIPAL` (feature-specs/12 § 6; Andre 2026-09-24, unit 37c); unset = an anonymous search stays lexical |
| `WORKERS_URL`, `WORKERS_TOKEN` | app (URL, token), workers (token) | the private channel |
| `INDIVIDUAL_TOKEN_CAP` | workers; web, read only | the fixed small cap for individual accounts (D5); the web tier reads it through `lib/env.ts` only to print the cap on the budget meter (21 § 4.1) |
| `ANTHROPIC_API_KEY` | gateway only | never in the application's schema |
| `OTEL_EXPORTER`, `OTEL_ENDPOINT`, `OTEL_SERVICE_NAME` (since unit 80; feature-specs/49 § 5.2) | the gateway, from compose's `environment`: `otlp_http`, `http://otel-collector:4318`, `hb-gateway`. Required wherever `litellm.yaml` is deployed: without them `langfuse_otel` prints every span to the gateway's stdout. With the collector off, the export fails and logs a traceback a batch, which is expected (49 § 5.2) | never a secret; no other `OTEL_*` or `LITELLM_OTEL_*` name in `infra/gateway/.env`: the image reads them first or beside these (49 § 4) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_OTLP_ENDPOINT`, `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_MESSAGE_TEXT` (its collector half) | the OTel collector only, from `infra/observability/.env` (since unit 79; feature-specs/49 § 4) | never in the application's schema; compose blanks the gateway's `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `LANGFUSE_OTEL_HOST` and the three `UPSTREAM_LANGFUSE_*`, which hides any value `infra/gateway/.env` still holds from the container; the file holds them until they are deleted from it |

Production boot refuses a missing `GATEWAY_URL` or `WORKERS_URL` in the app and a missing `GATEWAY_KEY_SECRET` or `LITELLM_MASTER_KEY` in the workers (the pattern of 09 § 10); `next build` is exempt as today.

## 9. Security controls

- Provider keys never leave the gateway container (architecture § 5.7); the application's env schema has no field for one, so a misplaced `ANTHROPIC_API_KEY` in `.env` is ignored, not used.
- Virtual keys are readable by the workers only (`GATEWAY_KEY_SECRET`), stored encrypted, rotated by replacement, and never logged; the ESLint rule of § 5.5 keeps `client.ts` out of the web tier.
- The workers' surface is private and bearer-protected; the web tier forwards only validated, typed bodies (zod at both ends), never headers or env.
- Fail closed at every hop: no gateway, no workers, no key, no budget → no model call.
- The gitleaks CI step covers `infra/gateway/` and `workers/`; the secret scanner of code-standards runs on `guides/` (prompt templates) with a required count of zero.
- Every call is attributable: principal, purpose, ref, trace id, gateway call id, cost. The ledger is append-only.

## 10. Out of scope

- Retrieval, embeddings and the re-ranker (spec 12); prompt assembly and sensors (spec 13); the conversation models and the SSE endpoint (spec 15); the account budget meter screen (Phase 4); lab sub-keys (Phase 3); Temporal (Phase 4).
- Provider routing across vendors and fallbacks: one provider in Phase 2; the alias table is where a second one would appear.
- Priority or fast-mode tiers and the batch API: none of the product's calls are batch-shaped in Phase 2.

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | The wire format between workers and gateway | A the Anthropic Messages format on LiteLLM's `/v1/messages` with the official SDK / B the OpenAI-compatible format | **A**: one SDK, the provider's own features (adaptive thinking, effort, cache control, refusal stop reason) pass through unchanged; B loses them behind a translation |
| D2 | Pinned models | A `hb-frontier = claude-opus-5`, `hb-small = claude-haiku-4-5` / B a Fable-tier frontier | **A**: Opus 5 is the current frontier at $5 / $25; the Fable tier costs twice as much and has API differences (thinking always on, no forced tool use) the guides were not written for; revisit when the golden set measures a gap |
| D3 | Converting `Organisation.tokenCap` to `max_budget` USD | A `tokenCap × frontier input price` (every capped token priced as frontier input) / B a blended price from last month's ledger | **A** for Phase 2: one formula, stated on the meter; B needs history the product does not have yet |
| D4 | `tokensPerMinute` default for a new organisation | needs a number the spec does not give | **BLOCKED** (rules § 4.5): Andre names the value; until then the column is required at creation with no default |
| D5 | The individual account's "fixed small cap" | needs a number | **BLOCKED**: `INDIVIDUAL_TOKEN_CAP` read from the environment, set by Andre; no default in code |
| D6 | The per-purpose `max_tokens`, effort and timeouts of § 5.3 | as tabled / other values | **Delegated by Andre, 2026-09-24** ("think if the numbers make sense, change if necessary"), decided in unit 37b against the Claude API guidance cached 2026-06-24: three of the four rows changed. `max_tokens` is now a ceiling that thinking cannot eat (4,096 → 64,000 streamed draft, 4,096 → 16,000 repair, 1,024 → 16,000 grader), because adaptive thinking is on by default on `claude-opus-5` and counts against it; the draft's and repair's effort drop one level, `high` → `medium`, for architecture § 8's 2 s first token (37b took them two levels, to `low`; the review of unit 37 stepped them back, because the gate that would measure what a step costs needs a provider key — § 5.3), and the grader keeps `medium`; a retry count joins the table (`maxRetries`, the classifier 1 and the rest the SDK's 2) so each row's worst-case wall clock is bounded and stated; the classifier's `effort: null` stays because `claude-haiku-4-5` refuses the field. The timeouts are unchanged. § 5.3 carries the reasons |
| D7 | Web-to-workers authentication | A a shared bearer in the environment / B mTLS now | **A** in Phase 2 on a private network; B when the service mesh exists |
| D8 | The stub gateway | A an in-repo process with deterministic answers / B LiteLLM's own `mock_response` | **A**: `mock_response` returns one fixed string and cannot cite the sections the sensors check; the stub also exercises keys and budgets |
| D9 | Where virtual keys are stored | A encrypted in `GatewayKey` under a workers-only secret / B in the workers' environment as a map | **A**: keys are minted per organisation at runtime; an environment map cannot grow; the web tier still cannot read them |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Unit: `prices.ts` (cost of a usage block at each alias, cache rates), `keys.ts` (round trip, wrong secret fails, ciphertext differs per call), `errors.ts` (`isBudgetError` on LiteLLM's 400 and 429 shapes), the prompt hash (same prefix, same hash; a changed conversation or different `metadata`, same hash), the request policy table (every purpose has all six fields; every row's reason states the worst-case wall clock its timeout and retry count imply; `requestFor("scopeClassifier")` emits no `output_config` at all, because `hb-small` refuses one).
2. Against the stub (contract): mint a key, call `hb-small`, a `BudgetLedger` row with the usage and a cost; the second call with the same prefix reports `cache_read_input_tokens > 0` and a lower cost; a key with a tiny `max_budget` raises `BudgetExceededError` with `resetsAt` on the first of next month and writes a row with `outcome: "budget"`; `x-hb-stub-fail: 500` and `timeout` raise `GatewayUnavailableError` after the row's own attempts — two for the classifier, counted at the fetch — and write `outcome: "unavailable"`; a streaming call reaches `finalMessage()` and the ledger; the web container's build has no import of `client.ts` (the lint rule) and `gatewayClient` throws without `GATEWAY_KEY_SECRET`.
3. Workers: `GET /health` without the bearer is 401; with it `{ ok: true, gateway: "up" }` against the stub and `"down"` with the stub stopped; `/keys/ensure` twice returns the same id; `/keys/rotate` changes it and sets `rotatedAt`; `/gateway/check` returns a usage block.
4. LiteLLM, on the development machine with Docker: `docker compose up db gateway`, `npm run gateway:key -- --user <dev user id>`, `npm run gateway:check` prints the usage block from the real gateway (with an Anthropic key in `infra/gateway/.env`; without one, the same command against the stub); the LiteLLM UI shows the key with its budget and the spend after the call; `x-litellm-call-id` lands in the ledger row.
5. Fail closed: with `GATEWAY_URL` unset every call raises `GatewayUnavailableError` and the ledger records it; with the workers stopped the web tier's `workersFetch` raises `WorkersUnavailableError` within its timeout, and against a workers process that accepts the connection and never answers it raises the same error with a `timeout` cause inside the route's own deadline of § 7.2, never after undici's 300 s. The other half of the same deadline, against a **healthy** workers process behind a gateway that accepts the connection and never answers: `workersFetch("/health", …)` returns `{ ok: true, gateway: "down", keys }` inside that row, on a cold cache as well as a warm one, which holds only while the probe's deadline is strictly shorter than the row's.
6. Secrets: `grep -r ANTHROPIC_API_KEY lib app components` returns nothing; gitleaks passes over `infra/gateway/` with the example env only.
7. Invariant check: 6 (only workers import `client.ts`; the lint rule), 7 (no token counting decides a call; the budget error comes from the gateway), 10 (every span line carries guide version, pinned id and prompt hash), 23 (unreachable gateway or workers denies, never degrades to a direct call).
