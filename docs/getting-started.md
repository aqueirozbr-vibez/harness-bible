# Getting started

Two repositories, cloned side by side:

- **The app** (this repository, MIT): `https://github.com/aqueirozbr-vibez/harness-bible`
- **The book** (chapters under CC BY 4.0, lab code under MIT): `https://github.com/aqueirozbr-vibez/harness-bible-book`

The app never edits the book's files. It ingests a pinned release of them into PostgreSQL and renders that.

This guide takes you from a clean machine to the app on `http://localhost:3000` with seeded demo data. The whole of it
runs **without any model key** on the stub gateway. A real Anthropic key is a later, optional step, and the only
part of this guide that costs money.

- [What runs where](#what-runs-where)
- [1. Prerequisites](#1-prerequisites)
- [2. Clone both repositories](#2-clone-both-repositories)
- [3. Configure](#3-configure)
- [4. Start the services](#4-start-the-services)
- [5. Install, migrate, ingest the book](#5-install-migrate-ingest-the-book)
- [6. Run the app and the workers](#6-run-the-app-and-the-workers)
- [7. Seed the demo data](#7-seed-the-demo-data)
- [8. Fully offline on the stub gateway](#8-fully-offline-on-the-stub-gateway)
- [9. With a real Anthropic key](#9-with-a-real-anthropic-key)
- [10. Tests and gates](#10-tests-and-gates)
- [Troubleshooting](#troubleshooting)

## What runs where

| Process | Started by | Port | Needed for |
| --- | --- | --- | --- |
| Next.js app (web tier) | `npm run dev` | 3000 | everything |
| OPA policy sidecar | `npm run dev` (or `npm run policy:serve`) | 8181 | every write. Unreachable means deny |
| Stub gateway | `npm run dev` (or `npm run gateway:stub`) | 4001 | model calls without a key |
| Workers | `npm run workers` | 4002 | the Assistant, research, grading, adjudication |
| PostgreSQL 17 + pgvector | `docker compose up -d db` | 5432 | everything |
| Temporal (server, schema, namespace) | `docker compose up -d temporal-namespace` | 7233 | Improve and research workflows |
| LiteLLM gateway | `docker compose up -d gateway` | 4000 | real model calls (optional) |
| Embeddings (`BAAI/bge-m3`) | `docker compose up -d embeddings` | internal | semantic search with the real gateway (optional) |
| Keycloak | `docker compose up keycloak` | 8081 | Google/GitHub sign-in (optional; development uses a dev provider) |
| Collector, Tempo, Loki, Grafana | `docker compose --profile observe up -d` | 4318, 3001 | traces and dashboards (optional) |
| Temporal UI | `docker compose --profile workflows-ui up -d` | 8233 | looking at workflow histories (optional) |

## 1. Prerequisites

- **Node.js 24** with npm. CI runs on Node 24.
- **Docker** with Compose v2.
- **OPA 1.x**, the [Open Policy Agent](https://www.openpolicyagent.org/docs/latest/#running-opa) binary, on your
  `PATH` as `opa`. `npm run dev` starts it as a sidecar. Without it every policy decision denies, so every write
  fails with a 403.
- **Git**.
- *Optional:* **Microsoft Edge** for rendering the book's Mermaid figures at ingestion. The pipeline drives it
  through Playwright (`npx playwright install msedge`). Without it, ingest with `--no-mermaid`.
- *Optional:* **Python 3.12** for the Assistant's decision-aid walks when `AID_RUNNER=python`. The default runner
  uses the `python:3.12-slim` image through Docker.
- *Optional:* an **Anthropic API key** for real answers, real research and real grading. See [§ 9](#9-with-a-real-anthropic-key).

## 2. Clone both repositories

The app finds the book through `BOOK_DIR`, which defaults to `../bible`, a folder beside the app. Clone the book
into that name:

```bash
mkdir harness-bible-workspace && cd harness-bible-workspace
git clone https://github.com/aqueirozbr-vibez/harness-bible.git app
git clone https://github.com/aqueirozbr-vibez/harness-bible-book.git bible
cd app
```

```text
harness-bible-workspace/
├── app/     ← this repository
└── bible/   ← the book: book/ (chapters, registries) and labs/
```

If you keep the book anywhere else, set `BOOK_DIR` in `.env` to its path. A relative path is resolved from the app's
folder.

## 3. Configure

```bash
cp .env.example .env
```

`.env.example` documents every variable in place. The groups are below. **Fill the generated secrets before the
first `docker compose` command.** Compose reads `.env` to start the gateway and the workers, and it refuses to start
*any* service while one of them is empty.

Generate each secret locally, never commit it, and use the generator command that `.env.example` gives beside the
variable:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`LITELLM_MASTER_KEY` and `INFINITY_API_KEY` take a prefix. The example shows the exact command for each.

| Group | Variables | What they do |
| --- | --- | --- |
| Database | `DATABASE_URL` | The compose database. The example already points at it. |
| The book | `BOOK_DIR`, `RELEASE_ID`, `RENDER_HASH_EXPECTED` | Where the book is, the release id it is ingested as, and an optional render hash from CI. Ingestion aborts if its own hash differs. |
| Origin and sign-in | `APP_URL`, `AUTH_DEV_PROVIDER`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `AUTH_ALLOWED_EMAILS`, `IP_HASH_SALT` | `AUTH_DEV_PROVIDER=1` turns on the development sign-in (it is refused in production). Comment out the three `KEYCLOAK_*` lines unless you run Keycloak: with all three unset, the sign-in page offers only the dev provider. |
| Policy | `OPA_URL` | The OPA sidecar. When it is unset, every decision denies. |
| Decision aids | `AID_RUNNER`, `DOCKER_BIN`, `AID_IMAGE`, `PYTHON_BIN` | How a decision-aid walk runs the chapter's own `derive.py`: in a networkless container, or as a local Python subprocess. |
| Ledger export | `LEDGER_EXPORT_KEY` | The Ed25519 key that signs audit-export trailers. `npm run ledger:keygen` writes the pair. Without the key, exports refuse and appends still work. |
| Model gateway | `LITELLM_MASTER_KEY`, `GATEWAY_URL`, `GATEWAY_KEY_SECRET`, `INFINITY_API_KEY`, `INDIVIDUAL_TOKEN_CAP`, `INDIVIDUAL_TOKENS_PER_MINUTE`, `GATEWAY_CHECK_PRINCIPAL`, `GATEWAY_ANONYMOUS_PRINCIPAL`, `LITELLM_DATABASE_URL` | The master key mints per-principal virtual keys. `GATEWAY_URL` selects the stub (`:4001`) or LiteLLM (`:4000`). The key secret encrypts virtual keys at rest and only the workers hold it. The two individual caps are an individual account's monthly tokens and tokens per minute: while either is unset, no individual account gets a key, so its Assistant cannot answer. |
| Research | `RESEARCH_PRINCIPAL` | The platform organisation (`org:<id>`) that pays for Improve's vetting of findings a person sends. A person's own research is charged to that person. |
| Workers | `WORKERS_URL`, `WORKERS_TOKEN` | Where the workers listen, and the bearer the web tier sends them. |
| Workflow engine | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` | Temporal. Unset, Improve and research do not run. The reader and the Assistant are unaffected. |
| Object storage | `OBJECT_STORE_DIR`, `OBJECT_STORE_SECRET` | Uploaded and fetched evidence, in a local directory behind signed URLs. |
| Book repository for merges | `BOOK_REPO_DIR` | A Git copy of the book that accepted changes are merged into. Unset, accepted suggestions wait in `MERGING`. |
| Curator calibration | `CURATOR_SEED_SHARE`, `CURATOR_SAMPLE_PER_MONTH` | Known-answer seeds in the queue and the monthly sample of tier-B merges. Both are off by default. |
| Telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT`, `HB_METRICS_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, `HB_LOG_DIR` | Unset, nothing is exported. Set the endpoint to a collector to get spans from the web tier, the workers and the jobs. |

The provider key never goes in `.env`. It lives in `infra/gateway/.env`, which only the gateway container reads.
Langfuse's keys, if you use it, live in `infra/observability/.env`, which only the collector reads. See
[§ 9](#9-with-a-real-anthropic-key).

## 4. Start the services

```bash
docker compose up -d db temporal-namespace
```

This starts PostgreSQL, then Temporal's schema step, server and namespace step, in that order. The two steps run once
and exit. Nothing else is needed for the offline setup.

## 5. Install, migrate, ingest the book

```bash
npm ci
npm run db:deploy                     # forward-only Prisma migrations
npm run ingest                        # the whole book from BOOK_DIR, as release RELEASE_ID
npm run db:seed                       # the development reader, dev@harness-bible.local
npm run rubric:publish -- v1.2        # the evidence rubric the Improve flow scores with
```

- `npm run ingest` parses chapters, labs and registries into rows that are immutable per release, builds the
  full-text index, and computes the release's render hash. Add `-- --no-mermaid` if Edge is not installed, or
  `-- --only 21,28,37` for a small fixture release. The demo seeds below anchor to sections across the book, so
  ingest the whole book if you want them.
- `npm run db:seed` ingests the three fixture chapters only when the database holds no release yet.

## 6. Run the app and the workers

Two terminals:

```bash
npm run dev        # Next.js on :3000, OPA on :8181, the stub gateway on :4001
```

```bash
npm run workers    # the workers on :4002, polling Temporal's two task queues
```

Then sign in through the development provider by opening this address in the browser:

```text
http://localhost:3000/api/v1/auth/dev?email=you@harness-bible.local&next=/en
```

Add `&role=CONTRIBUTOR&verified=true` or `&role=CURATOR&verified=true` to try the other roles. The roles are
`READER`, `BUILDER`, `CONTRIBUTOR`, `CURATOR` and `ORG_ADMIN`. A development curator curates every part. With the
dev provider on, the account page also has a role switch.

## 7. Seed the demo data

Neither seed asks a model. Each runs its workflows on Temporal's test server, against a stub gateway it starts for
itself.

```bash
npm run workflows:test-server   # downloads Temporal's test server once (into node_modules/.cache)
npm run improve:seed            # the rubric's four worked examples, as improve-seed@harness-bible.local
```

```bash
# sign in once as demo@harness-bible.local (the URL in § 6), then:
npm run research:seed           # researches in every state, an answer to research from, a refusal
```

`npm run research:seed -- --account you@harness-bible.local` seeds an account you have already signed in with.
`-- --page` seeds only the Research page's states. Each seed prints the addresses to open. The
[walkthrough](walkthrough.md) is a tour of what they show.

## 8. Fully offline on the stub gateway

With `GATEWAY_URL=http://localhost:4001`, every model call goes to the stub gateway. The stub exposes the same four
aliases as LiteLLM (`hb-frontier`, `hb-small`, `hb-embed`, `hb-rerank`), mints virtual keys under the same master
key, and refuses at the same budget cap. Its answers are deterministic, it calls no provider, and it needs no key.

What to expect:

- **Reader, search, paths, marks, rubric, Improve's pages, the curator queue, the ledger, Book management** behave as
  they do with a real model. None of them calls a model when you read it.
- **The Assistant** answers once `INDIVIDUAL_TOKEN_CAP` and `INDIVIDUAL_TOKENS_PER_MINUTE` are set. The answers are
  stitched together from retrieved text. That is enough to exercise the sensors, the citations, the SSE stream and
  the ledger, but the prose is not real prose.
- **Research** runs against the stub's fixture pages and fixture report, so you can see the steps, the report and
  the findings in motion. No real web page is read.
- **Search** is lexical until you embed the release. `npm run embed:release -- --user <your user id> --batch 8`
  embeds on the stub's bag-of-words vectors: enough to see the hybrid rank work, not semantic.

## 9. With a real Anthropic key

The Assistant's drafting, the researcher's reader and writer, and the adjudicator call `hb-frontier`
(`claude-opus-5`). Scope classification, the research planner and the evidence grader call `hb-small`
(`claude-haiku-4-5`). Both aliases resolve in `infra/gateway/litellm.yaml`. Every call goes through LiteLLM, which
enforces each principal's hard budget before the call. This step spends money.

```bash
cp infra/gateway/.env.example infra/gateway/.env
# put ANTHROPIC_API_KEY in infra/gateway/.env: the only file that holds a provider key
docker compose up -d gateway embeddings
```

1. In `.env`, set `GATEWAY_URL=http://localhost:4000`. Set the two individual caps to a budget you are willing to
   spend. Restart `npm run dev` and `npm run workers`. The stub may keep running on 4001 unused.
2. `npm run gateway:check -- --user <your user id>` makes one small `hb-small` call and records its cost. It is the
   smoke test.
3. For semantic search, run `npm run embed:release -- --user <your user id> --batch 8`. The embedder is self-hosted
   (`BAAI/bge-m3` in the `embeddings` container), so this costs no provider tokens. It takes a while on a CPU.
4. To let people send research findings to Improve: `npm run research:org -- --create`, then
   `npm run gateway:key -- --org <the id it prints>`, then set `RESEARCH_PRINCIPAL=org:<id>`.

To trace the agents in **Langfuse** (spec 49, being built), copy `infra/observability/.env.example` to
`infra/observability/.env`, fill in the Langfuse project's keys, its OTLP endpoint and an environment label, and
start the observability profile (`docker compose --profile observe up -d`). The OpenTelemetry collector is the only
road to Langfuse: the app, the workers and the gateway hold no Langfuse key, and without that file nothing is sent.

Rough costs from the project's own measurements: an Assistant turn is cents; a research run is about US$ 0.60
(three model calls, with up to ten web searches and ten page fetches at the provider). The `reranker` container is
optional. On a CPU it is slower than the fused order it would refine, and retrieval works without it.

## 10. Tests and gates

What CI runs on every push, in order (`.github/workflows/ci.yml`):

```bash
npm run secrets:scan                       # prompt templates and model-visible data: zero findings
npm run audit:check                        # no high or critical advisory; development exceptions named and dated
opa check policies && opa test policies -v # every deny case
npx prisma migrate deploy && npx prisma generate # first: the type check reads the generated client
npx tsc --noEmit && npx eslint .
npm run workflows:test-server              # Temporal's time-skipping test server
npm test                                   # Vitest: unit, contract, integration, workflow suites
npm run test:ledger                        # the hash chain at 100 % branch coverage
npm run test:rubric                        # the rubric at 100 % branch coverage, the four worked examples to the number
npm run api:openapi && git diff --exit-code -- openapi.json
npm run build
```

Vitest does not read `.env`. The database-backed suites skip unless their variables are on the command line, as CI
sets them (`DATABASE_URL`, `OPA_URL`, `APP_URL`, `AUTH_DEV_PROVIDER`, `BOOK_DIR`, and for the engine suites
`TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`). One stream suite purges message text across the development database,
so run it on a database you do not mind losing conversations from.

Browser suites, with the dev server running:

```bash
npm run test:e2e      # Playwright + axe, EN and PT, the primary flows and the keyboard map
npm run test:layout   # PT strings at least 30 % longer than EN, and nothing truncates
```

Each capability has a gate that measures its success criteria and reports `pass`, `fail` or `blocked` with the
reason:

```bash
npm run gate:phase1      # Reader
npm run gate:golden -- --stub && npm run gate:phase2   # Assistant, on the stub
npm run gate:phase4      # Improve
npm run gate:research    # the researcher
```

Paid runs are never implicit. `npm run gate:golden -- --real --user <e-mail>` prints what a real golden run would
cost and stops. Only `--yes` spends.

## Troubleshooting

- **Every write answers 403.** OPA is not running on 8181, or `OPA_URL` is unset. Check
  `curl http://127.0.0.1:8181/health`.
- **`docker compose` complains that a variable is unset.** Fill the generated secrets in `.env` first
  ([§ 3](#3-configure)).
- **The Assistant says the budget is not set.** Set `INDIVIDUAL_TOKEN_CAP` and `INDIVIDUAL_TOKENS_PER_MINUTE`, then
  restart the workers.
- **Improve or research does nothing.** Temporal is not up (`docker compose up -d temporal-namespace`), or
  `TEMPORAL_ADDRESS` is unset, or the workers are not running.
- **The workflow suites fail with "The workflow test environment did not start".** Run
  `npm run workflows:test-server`. It needs network access the first time.
- **Figures show "diagram could not be rendered at ingestion".** Install Edge for Playwright, or accept the
  fallback and ingest with `--no-mermaid`.
