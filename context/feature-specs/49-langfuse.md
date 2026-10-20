# 49 · The agents in Langfuse — feature spec (every model call named for its agent; a turn, a research run and a suggestion each one trace; the product's own steps beside the model's; the collector the one road out; prompt and answer text in development only, and never from a call that failed)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-14, "i want to use langfuse to monitor the agents in the app", and his three answers of the same day, L1 to L3, each binding (§ 2). Where they change a rule another document states, this spec says which rule, and which unit amends it (§ 17). Two of those changes need flagging. One is to architecture invariant 29, by Andre's L1. The other reverses spec 45's D6 for development only, by his L2. Rules § 1.5 says such changes are reported, not settled quietly, so both are reported here.

The draft was revised the same day after two read-only reviews, one for privacy and one for integration. § 22 lists what each review found, what was fixed and what was rejected.

Prerequisite specs:

- `21-assistant-retention-observability.md` § 5: the product's spans are built from finished lines, by a tracer the product owns that is never the process's global one; the collector, Tempo, Loki, D3 and D4. Also § 6, the guard on every line and span.
- `11-model-gateway.md` § 3.5 (Langfuse as the gateway's callback), § 5.1 and § 5.4 (`callModel` with its `traceparent`, its ledger row and its span), and § 8 (where each variable lives).
- `45-deleting-and-withdrawing.md` D6 and § 29 (unit 64: `turn_off_message_logging`).
- `48-research-agent.md` § 5.8 (the research lines) and § 15 (the `RESEARCH` record).
- `33-suggestion-workflow.md` § 12 (the attempt's trace id).

Scope: tracker units 79 to 86, in Andre's lean shape, with one review per unit (§ 21). Unit 78 stays reserved for spec 48's legacy removal. Andre builds this after the spec, as he did with spec 48.

Before this spec was written, the code it depends on was read: `lib/telemetry/`, `lib/gateway/`, `lib/env.ts`, `lib/api/handler.ts`, the workers' server and turn, the research run's steps, the activities, the workflows, `workers/keys.ts`, the two check scripts, the collector's configuration, the compose file, the workers' Dockerfile and `tests/gateway-config.test.ts`. The source of the pinned gateway image was read too, read-only in the running container: LiteLLM 1.102.1, with the Langfuse Python SDK 2.59.7 and OpenTelemetry 1.28.0. For the reviews, its failure path's logging was read again: `litellm_core_utils/litellm_logging.py`, `redact_messages.py`, `utils.py`, `router.py` and the pass-through stream handlers. So were the OpenTelemetry logger's configuration, resource, span name and exception recording. Langfuse's public documentation was read for its OTLP endpoint, its regions, its attribute mapping, its root-span rule, its retention and its deletion API. Nothing was run against Langfuse, and no model was called. File and line references are to the code and the image as of 2026-10-14. Where this spec states something the image's source says but nobody has yet seen happen, it says so, and names the unit that first sees it (§ 16).

## 1. Purpose

Andre's request, as he wrote it:

> i want to use langfuse to monitor the agents in the app

**Today.**

- **A model call.** It writes one JSON line. When a collector runs, it also writes one `gen_ai.*` span to Tempo, with ids, counts, hashes and timings (spec 21 § 5.1).
- **The gateway's Langfuse callback.** It is configured, but spec 45 § 29 records that no keys were ever written for it, so it has never sent anything.
- **No call is named for the agent that made it.** The draft and the repair are both `assistant` on `hb-frontier`, and `limitsFor` cannot tell them apart (`lib/gateway/policy.ts:29`).
- **An evidence grade** is a trace of its own, under a random id (`workers/activities/evidence.ts:329`).
- **A workflow activity** is not a span at all.

**After this spec,** Andre opens Langfuse and sees each piece of agent work as one trace:

- a reader's turn;
- a person's research run;
- a suggestion, from its first evidence grade to its merge.

Each model call in a trace is a generation named for its agent, with its model, tokens, cost and latency. In development it also shows its prompt and its answer. Beside the generations are the product's own steps: retrieval, the sensors and the workflow activities. Langfuse's own dashboards show cost, latency and failures by agent.

The words a reader typed reach Langfuse only under four conditions:

- from this machine;
- with test accounts;
- while two settings say so;
- and never from a call that failed.

## 2. Andre's answers (2026-10-14) and what follows

| # | Question | His answer |
|---|---|---|
| L1 | Which Langfuse | **Langfuse Cloud now**: he has an account. **Self-hosted in Brazil later**, before real customers' data flows, as the architecture's residency rule requires ("Observability · OTel Collector + Langfuse + Grafana … all self-hosted in region", architecture § 1). |
| L2 | Prompt and answer text in Langfuse | **In development only.** On while the app runs on this machine with test accounts; off by a setting before any real reader uses it. This reverses spec 45 D6 (unit 64's `turn_off_message_logging`) for development only. |
| L3 | How much to trace | **Full app tracing.** Every model call named for its agent: assistant draft, repair, grounding grader, scope classifier, evidence grader, adjudicator, researcher planner, reader, writer, embed, rerank. A turn's, a research run's and a suggestion's calls grouped into one trace with tags. **Plus the app's own steps** (retrieval, sensors, workflow activities), sent to Langfuse through OpenTelemetry. |

Standing rules, from Andre's earlier instructions:

- Langfuse keys are secrets that Andre writes into env files himself. They never appear in a prompt, a transcript, a log or a committed file.
- Provider keys stay only in `infra/gateway/.env`.
- The app and the workers should not need Langfuse keys if the local collector (`infra/observability/`) can hold them and export to Langfuse's OTLP endpoint.

What follows from them, as this spec reads them:

- **L1 changes invariant 29 for development.** The invariant says: "All data, backups, observability data and the gateway stay in the São Paulo region." Langfuse Cloud has no region in Brazil; its regions are EU, US, Japan and HIPAA (§ 5.4). Until the self-hosted Langfuse exists, development telemetry of test accounts leaves the region, by Andre's word. Production never does: the invariant gains an exception for development, and the move to self-hosting closes it (§ 14). Two things enforce "production never":
  - the collector sends to Langfuse Cloud only spans labelled `development`, and only when that label is set explicitly (§ 5.5);
  - the readiness list stops the export before any real reader arrives (§ 10).
- **L1 makes the collector the one road out.** The collector holds the Langfuse keys and is the only container that talks to Langfuse. The web tier, the workers and the gateway export to the collector and hold no Langfuse key (§ 4). Compose also blanks the gateway's own Langfuse variables, so its logger cannot open a second road. The move to a self-hosted Langfuse then changes one host and two keys, in one file.
- **L2 is a per-request switch behind a positive development check, not a new global.**
  - The committed `infra/gateway/litellm.yaml` keeps `turn_off_message_logging: true` in every environment.
  - The workers ask the gateway not to redact a request only when the switch is on and the process proves it is a development machine (§ 9.1). The gateway honours the request only for a virtual key that carries the opt-out flag.
  - On a streamed call that fails, a router's rejection or a refusal at the gateway's gate, the gateway does not redact at all (§ 9.2). There the collector's lock holds alone, and it removes the text whatever the switch says.
- **L3's "one trace" holds for a suggestion too.** All of a suggestion's work goes into one trace, across days and attempts. The trace id is derived from the suggestion's own id (§ 6.1). The attempt's own trace id keeps its job in the rows and the records (spec 33 § 12).
- **No person in Langfuse.** L3 groups by the work, not by the reader. No attribute names a user, an organisation, a principal, a session or a conversation (§ 6.5; D1). Allow-lists in the collector enforce this. They name what may leave, not what to remove (§ 5.5).

## 3. The road, in one picture

```
 web tier (Next, host :3000)        workers (host :4002)                    gateway (compose :4000, LiteLLM)
 ─ product spans (spec 21) ─┐       ─ product spans ─────────────────┐      ─ one generation a call ─────────┐
   http.request …           │         turn · retrieve · sensors ·    │        (callback langfuse_otel; its     │
                            │         activity.* · model-call spans  │         Langfuse variables blanked by   │
                            │         traceparent ──────────────────────────▶  compose; the incoming          │
                            │                                         │         traceparent is its parent)     │
                            ▼                                         ▼                                       ▼
                 ┌──────────────────── otel-collector (compose profile observe, :4318) ────────────────────┐
                 │  traces:          filter/tempo (no hb-gateway span) ─────────────▶ Tempo                 │
                 │  traces/langfuse: filter (nothing while unconfigured, no environment named, or Cloud    │
                 │                   for anything but development; no http.request, no job; no span event) │
                 │                   shape (app spans: an allow-list, request children made roots;         │
                 │                          gateway spans: an allow-list, the agent's name, the cost key,  │
                 │                          no text on a failure, on the bytes row, or with the switch off)│
                 │                   ─▶ otlp_http + basic auth (infra/observability/.env)                  │
                 └─────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                               ▼
                                        Langfuse Cloud, /api/public/otel (development, L1)
                                        self-hosted in São Paulo (later: the same pipeline, another host)
```

One trace has three producers:

- The product's spans carry the trace id the product already uses.
- The gateway's span is a child of the `traceparent` the workers already send.
- Langfuse files an OpenTelemetry span under the trace it belongs to (§ 5.3).

## 4. Keys: where each lives, who reads it

| Secret or setting | Lives in | Read by | Never in |
|---|---|---|---|
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | `infra/observability/.env`. The existing `.env*` rule keeps it out of git. Andre writes it; a deployment mounts it from a vault. | the collector container alone (its `basicauth/langfuse` extension) | the project `.env`, `lib/env.ts`, the gateway (compose blanks the names there), the workers, the web tier, a log line, a prompt, a transcript, a committed file |
| `LANGFUSE_OTLP_ENDPOINT` (the region's `…/api/public/otel`, § 5.4) | the same file | the collector | as above. It is not a secret; it sits beside its keys so the move is one file. |
| `LANGFUSE_TRACING_ENVIRONMENT` (`development` now) | the same file | the collector | compose (not hard-coded there). Unset, nothing goes to Langfuse (§ 5.5). |
| `LANGFUSE_MESSAGE_TEXT`, the collector's half (`on` or `off`, default `off`) | the same file | the collector | the project `.env`. It is a separate act from the workers' half (§ 9.1). |
| `LANGFUSE_MESSAGE_TEXT`, the workers' half (`on` or `off`, default `off`) | the project `.env` | the workers, through `lib/env.ts` | production: `lib/env.ts` refuses `on` there. It takes effect only behind the development check (§ 9.1). |
| `ANTHROPIC_API_KEY` | `infra/gateway/.env` | the gateway | unchanged (spec 11 § 3.3) |
| Virtual keys | `GatewayKey.keyCiphertext` | the workers | unchanged, except that a key minted while the switch is in effect also carries the gateway's opt-out flag (§ 9.2) |

**What changes from spec 11 § 8.**

- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_HOST` leave `infra/gateway/.env.example`. A line there says where they live now.
- The compose `gateway` service gains `environment` entries that blank `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` and `LANGFUSE_OTEL_HOST` (§ 5.2). Nobody may read Andre's real `infra/gateway/.env`, and today's example asks him for both keys. If he has filled them in, the configured `langfuse` callback sends to Langfuse directly now. After unit 80, `langfuse_otel` would do the same: with no host set it defaults to the US cloud endpoint (`langfuse_otel.py:276-287`, `:331-332`). Either way, nothing would pass through the collector. Compose's `environment` overrides `env_file`, and the logger treats an empty value as unset, so the blanks close this road whatever the file holds. The `langfuse` callback also builds a second, "upstream" client whenever `UPSTREAM_LANGFUSE_SECRET_KEY` is set at all (`litellm/integrations/langfuse/langfuse.py:264-279`), so compose blanks `UPSTREAM_LANGFUSE_PUBLIC_KEY`, `UPSTREAM_LANGFUSE_SECRET_KEY` and `UPSTREAM_LANGFUSE_HOST` too; with its public key empty that client is disabled as well (unit 79's review). Unit 79 also asks Andre to delete every line containing `LANGFUSE` from his file.
- `infra/observability/.env.example` names the five collector variables, with no values.

**What the builder never does.**

- It never opens, prints or greps `infra/observability/.env` or `infra/gateway/.env`.
- It never runs a command that prints a container's environment or the interpolated compose file:
  - `docker compose config` unfiltered, or `docker compose config --environment`;
  - `docker inspect` of the collector or the gateway (its `Config.Env`);
  - `docker exec` or `docker compose exec` of `env` or `printenv`, or anything that echoes a variable's value.
- It never asks Andre for a key.

**What the builder may do instead.**

- **To see whether keys are present,** without printing them, it looks for two things only: export statuses in the collector's log (a 401, or a 4xx or 5xx with its status, which name no key), and data arriving in Langfuse, which Andre looks at.
- **To check that the gateway has no Langfuse variable,** it may run one test that prints one of two fixed lines and never a value:

```
docker compose exec gateway sh -c 'if [ -n "$LANGFUSE_PUBLIC_KEY$LANGFUSE_SECRET_KEY$LANGFUSE_HOST$LANGFUSE_OTEL_HOST$UPSTREAM_LANGFUSE_PUBLIC_KEY$UPSTREAM_LANGFUSE_SECRET_KEY$UPSTREAM_LANGFUSE_HOST" ]; then echo "a Langfuse variable is set"; else echo "no Langfuse variable"; fi'
```

## 5. The data path

### 5.1 The product's spans (exists; spec 21 § 5.1)

The web tier, the workers and the scheduled jobs export their spans to `OTEL_EXPORTER_OTLP_ENDPOINT` when it is set. By convention that is `http://localhost:4318`, the collector's loopback port. Their tracer has three properties, and nothing in that seam changes:

- it exports only spans built from the product's own lines, never a framework's automatic span;
- it never waits on the collector;
- the scopes it opens are the same as before (spec 21 § 5.1).

This spec does four things to it:

- **New spans.** It adds spans (§ 6.3, § 7, § 8).
- **Scopes for nesting.** It opens a scope around some of them so that the spans inside nest (§ 6.3).
- **The request mark.** It marks the spans whose parent is a request's span with `hb.parent: request` (§ 5.6).
- **Telemetry for the checks.** The two operator checks start telemetry, which they do not do today (§ 5.6).

### 5.2 The gateway's generations: `langfuse_otel`, to the collector

`infra/gateway/litellm.yaml` replaces its two Langfuse callbacks with LiteLLM's OpenTelemetry Langfuse logger, and the gateway exports to the collector:

```yaml
litellm_settings:
  callbacks: ["langfuse_otel"]       # was success_callback / failure_callback: ["langfuse"]
  turn_off_message_logging: true     # unchanged, every environment (§ 9). It redacts a call that succeeded;
                                     # a call that failed reaches the logger unredacted (§ 9.2), so the
                                     # collector removes its text.
```

`redact_user_api_key_info` is not set. In the pinned image, only four places read it: the `langfuse` logger, the LangSmith logger, the Logfire logger and the router (`grep` of the package). The OpenTelemetry road never calls it. Set, it would protect nothing here, and a test asserting it would give false assurance. Only the collector's keep-list keeps identity out of Langfuse (§ 5.5).

The compose `gateway` service gains variables:

- `OTEL_EXPORTER: otlp_http`, `OTEL_ENDPOINT: http://otel-collector:4318` and `OTEL_SERVICE_NAME: hb-gateway` (unit 80);
- `LANGFUSE_PUBLIC_KEY: ""`, `LANGFUSE_SECRET_KEY: ""`, `LANGFUSE_HOST: ""` and `LANGFUSE_OTEL_HOST: ""`, and the upstream client's `UPSTREAM_LANGFUSE_PUBLIC_KEY`, `UPSTREAM_LANGFUSE_SECRET_KEY` and `UPSTREAM_LANGFUSE_HOST`, each `""` (unit 79, § 4).

None of them is a secret.

**What the pinned image does with that, read in its source.**

- **No key, so it exports where it is told.** The logger finds no Langfuse key, since an empty value counts as none. It then builds its exporter from `OTEL_EXPORTER` and `OTEL_ENDPOINT` (`integrations/langfuse/langfuse_otel.py:276-281`, `OpenTelemetryConfig.from_env`, `integrations/opentelemetry.py:326-360`). The endpoint is completed to `…/v1/traces`.
- **The exporter must be named wherever the yaml is deployed.** With neither `OTEL_EXPORTER` nor an endpoint, the exporter falls back to `console` (`opentelemetry.py:338`, `:3054-3059`). Every span would then be printed to the gateway's stdout, where no keep-list, purge or delete reaches it. Two things follow:
  - Compose sets both variables, even while the collector is off (§ 11).
  - Spec 11 § 8 and the README's pin checklist make both required wherever `litellm.yaml` is deployed, and `tests/gateway-config.test.ts` asserts that every gateway definition in the repository sets them.
  - With `OTEL_EXPORTER: otlp_http` set and no endpoint, the image's OpenTelemetry exporter dials its own default, `localhost:4318` inside the gateway's container, and fails without printing. That is read in the SDK's default, not seen.
- **The incoming `traceparent` is its parent.** The proxy creates no request span of its own for this logger: `create_litellm_proxy_request_started_span` returns `None` (`langfuse_otel.py:423-437`). So the span's parent is the request's `traceparent` header (`opentelemetry.py:2980-2987`, priority 2), and the generation is a child of the span the workers name there (§ 5.3).
- **One span a call, typed `generation`.**
  - No proxy-internal span is created for auth, the database or the router (`async_service_success_hook` does nothing, `langfuse_otel.py:439-447`).
  - The raw-request child span is written only when content capture is on. The global `turn_off_message_logging: true` forces capture off (`opentelemetry.py:603`), so no raw span is written here.
  - The span is named `litellm_request` unless the body's metadata names a generation (`opentelemetry.py:2924-2936`). A `langfuse_generation_name` header reaches the attribute `langfuse.generation.name`, not the span's name (§ 6.2), so the collector renames the span (§ 5.5).
- **Its own provider.** The logger never sets the process's global tracer provider (`_skip_set_global`, `opentelemetry.py:565-567`).
- **What its span carries besides the generation.** These are why the collector keeps a list rather than removing names (§ 5.5):
  - `metadata`: the whole `StandardLoggingMetadata` as JSON (`arize/_utils.py:436-437`, `:495-497`). That includes the key's hash and alias (`org:<id>` or `user:<id>`, `workers/keys.ts` `key_alias`), the key's own metadata with the organisation or user id, `requester_ip_address` and `requester_metadata` (`types/utils.py:2727-2748`, `:3018-3060`).
  - `user.id`, `litellm.key_alias` and `litellm.team_id` (`arize/_utils.py:836-883`).
  - `llm.invocation_parameters`, which holds `system` and the request's `metadata.user_id`, the principal (`arize/_utils.py:553-557`; `lib/gateway/client.ts:145`).
  - The arize-style duplicates of the input and the output (`input.value`, `llm.input_messages.*`, `output.value`, `llm.output_messages.*`).
  - On a failure, an OpenTelemetry `exception` event with the error's type, message and stack trace (`opentelemetry.py:2181-2199`).
  - Resource attributes: `service.name`, `model_id`, and `deployment.environment`, which defaults to `production` (`opentelemetry.py:309-310`, `:432-437`).

**Why not the `langfuse` callback that is configured today.** Andre's standing rule settles this: keys live with the collector, not in the gateway (§ 2). The image gives four further reasons:

1. **Keys in two places.** Its keys would live in the gateway as well as the collector. The one container that holds provider keys would also need an egress route to Langfuse.
2. **It races the product's trace name.** It upserts the trace on every call, with a name of its own (`litellm-…`) and that call's input and output (`integrations/langfuse/langfuse.py:690-732`). Only sending `langfuse_existing_trace_id` on every request would avoid that.
3. **It sends `system` and `metadata` whatever the redaction.** It logs the request's optional parameters as the generation's model parameters, redaction or not (`langfuse.py:367`, `:862`). On `/v1/messages` those hold `system` and `metadata`.
   - `system` carries the guides, the rubric and the mode line. Every assembler puts the reader's words in `messages`.
   - `metadata.user_id` carries the principal.
   - A direct export passes nothing the product could filter.
   - Spec 45 § 29's "Langfuse then keeps spans, timings and costs and no text" missed this. No key was written, so nothing was sent (§ 9.4).
4. **The move would touch two places.** Moving to a self-hosted Langfuse would change the gateway and the collector instead of one file.

The fallback, if unit 80's look shows the generation cannot be made usable, is the `langfuse` callback with keys in the gateway. That puts keys in the gateway, against the standing rule. It is therefore not this spec's to take: the unit stops and asks Andre (rules § 4.4).

### 5.3 How one trace is made

- **The trace id.** Every model call already sends `traceparent: 00-<call.traceId>-<span id>-01` (`lib/gateway/client.ts:149`; `embed.ts:102`; `rerank.ts:160`).
  - The proxy reads it and sets the call's `litellm_trace_id` to the same id (`proxy/litellm_pre_call_utils.py:1541-1546`). It does so when no LiteLLM session header is sent, and the product sends none. LiteLLM's spend log therefore carries the product's trace id too.
  - The gateway's span is created under that context, so its OpenTelemetry trace id is the product's.
  - Langfuse uses W3C ids: 32 lowercase hex characters for a trace, 16 for an observation. A span arrives with the trace it belongs to, so the product's spans and the gateway's span form one Langfuse trace.
- **The parent.** Today the span id in `traceparent` is a fresh one that no span carries (`newSpanId()`), so the generation would hang from a parent that was never sent. From unit 80, the model call's own span takes that id: `GatewaySpan` gains `span_id`, and `genAiSpanOf` sets it as the span's id. The generation then nests under the product's span for the same call, which nests under whatever step made the call (§ 6.3).
- **What each side carries.**
  - The product's span holds what the product asked and recorded: the agent, the guide version and hash, the prompt hash, the purpose, the outcome, the first-token time, and calls that never reached the gateway.
  - The generation holds what the model did: model, tokens, cost, latency and, in development, the text.
  - On the Langfuse road only, the collector removes usage and model from the product's span, so no call is counted twice (§ 5.5).
  - Tempo keeps the product's span as spec 21 defined it. It receives no gateway span (§ 5.5).

### 5.4 Langfuse's endpoint

| Region | `LANGFUSE_OTLP_ENDPOINT` |
|---|---|
| EU | `https://cloud.langfuse.com/api/public/otel` |
| US | `https://us.cloud.langfuse.com/api/public/otel` |
| Japan | `https://jp.cloud.langfuse.com/api/public/otel` |
| HIPAA | `https://hipaa.cloud.langfuse.com/api/public/otel` |
| Self-hosted (Langfuse ≥ 3.22) | `https://<host>/api/public/otel` |

- **Andre's region.** Accounts and projects are per region. D4 asks which one he wants (§ 20).
- **Protocol.** OTLP over HTTP, protobuf or JSON. gRPC is not supported. The collector's `otlp_http` exporter appends `/v1/traces`.
- **Auth.** HTTP Basic, with the project's public key as the user and the secret key as the password.
- **Ingestion header.** `x-langfuse-ingestion-version: 4`. Langfuse documents it as the header that shows data at once on its current data model. Without it, data sent straight to the endpoint can take up to ten minutes to appear. The image's own Langfuse logger sends the same header (`langfuse_otel.py:29-30`).

### 5.5 The collector's pipelines (`infra/observability/otel-collector.yaml`)

The `otlp` receiver feeds two traces pipelines. A receiver shared by two pipelines hands each its own copy wherever a processor changes data, so what the Langfuse pipeline does never reaches Tempo.

- **The Tempo pipeline** gains one processor. It drops every span whose resource `service.name` is `hb-gateway`. Without it, from unit 80 the gateway's raw span would reach Tempo unfiltered: its `metadata` with the principal, `llm.invocation_parameters` with `system`, and the messages of a failed call. That contradicts spec 21 § 5.1 ("No span carries prompt text, answer text, a question, an e-mail or a key"). The product's own `gen_ai.*` span already gives Tempo the call's model, tokens, cost and timing, so Tempo loses nothing it had.
- **The Langfuse pipeline** is new.

The outline below is not the final text. The unit writes it in the collector's current path syntax, then checks it two ways: with the image's own `validate` command, and by running the pinned image against recorded fixture spans (§ 9.5).

```yaml
extensions:
  basicauth/langfuse:                    # the name the pinned image gives this extension, checked by `validate`
    client_auth:
      username: ${env:LANGFUSE_PUBLIC_KEY:-unset}
      password: ${env:LANGFUSE_SECRET_KEY:-unset}

processors:
  filter/tempo:                          # Tempo receives no gateway span
    error_mode: ignore
    traces:
      span:
        - 'resource.attributes["service.name"] == "hb-gateway"'
  filter/langfuse:                       # a span or event that matches is dropped
    error_mode: ignore
    traces:
      span:
        - '"${env:LANGFUSE_OTLP_ENDPOINT:-}" == ""'                       # not configured: nothing goes, the exporter never dials
        - '"${env:LANGFUSE_TRACING_ENVIRONMENT:-}" == ""'                 # no environment named: nothing goes
        - 'IsMatch("${env:LANGFUSE_OTLP_ENDPOINT:-}", "(?i)cloud\\.langfuse\\.com") and "${env:LANGFUSE_TRACING_ENVIRONMENT:-}" != "development"'
                                                                          # Langfuse Cloud receives development only (L1); a host name ignores case
        - 'not IsMatch(resource.attributes["service.name"], "^hb-(web|workers|jobs|gateway)$$")'
                                                                          # only the product's three services and the gateway: any other
                                                                          # program speaking OTLP to 4318 stays in Tempo (unit 79's review)
        - 'name == "http.request"'                                        # requests are not agents' work; the Research page polls every 2 s
        - 'name == "job"'                                                 # the scheduled jobs
        - 'attributes["hb.agent"] == "embed.release"'                     # the release's embedding job (D3)
        - 'attributes["langfuse.generation.name"] == "embed.release"'
        - 'resource.attributes["service.name"] == "hb-gateway" and attributes["langfuse.observation.type"] != "generation"'
      spanevent:
        - 'true'                                                          # every span event: an exception's message and stack trace never leave
  transform/langfuse-resource:           # resource context
    # every resource: keep only service.name (drops the gateway's deployment.environment: production and model_id,
    # the product's service.namespace, and whatever a later SDK adds)
  transform/langfuse-app:                # span context, where resource service.name != "hb-gateway"
    # set parent_span_id to the empty span id where attributes["hb.parent"] == "request" (§ 5.6)
    # set the span's name to hb.agent where hb.agent is set (a model call's span reads as its agent)
    # keep_keys: exactly PRODUCT_LANGFUSE_KEYS of lib/telemetry/langfuse.ts (a test compares the two lists)
  transform/langfuse-gateway:            # span context, where resource service.name == "hb-gateway"
    # set the span's name to langfuse.generation.name where set (the agent, § 6.2)
    # set gen_ai.usage.cost from llm.cost.total where set (Langfuse reads gen_ai.usage.cost as the total)
    # set langfuse.observation.type to "embedding" where the name begins "embed."
    # delete langfuse.observation.input and langfuse.observation.output:
    #   where status.code is ERROR, always (§ 9.2: a failure is logged unredacted)
    #   where the name is "evidence.grade.bytes", always (§ 9.3)
    #   where "${env:LANGFUSE_MESSAGE_TEXT:-off}" != "on"
    # keep_matching_keys, one anchored pattern of exactly these:
    #   langfuse.observation.(type|input|output), langfuse.version, llm.model_name, llm.token_count.<any>,
    #   gen_ai.usage.<any>, gen_ai.(request|response).model
  transform/langfuse-all:
    # set langfuse.environment to "${env:LANGFUSE_TRACING_ENVIRONMENT}"

exporters:
  otlp_http/langfuse:                    # `otlp_http`, the 0.161 name; `otlphttp` is deprecated (tracker, unit 35c)
    endpoint: ${env:LANGFUSE_OTLP_ENDPOINT:-http://127.0.0.1:9}   # never dialled while unset: the filter dropped everything
    auth: { authenticator: basicauth/langfuse }
    headers: { x-langfuse-ingestion-version: "4" }
    # sending_queue and retry_on_failure at the exporter's own defaults (§ 11)

service:
  extensions: [file_storage, basicauth/langfuse]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [filter/tempo, batch]
      exporters: [otlp_grpc/tempo]
    traces/langfuse:
      receivers: [otlp]
      processors: [filter/langfuse, transform/langfuse-resource, transform/langfuse-app,
                   transform/langfuse-gateway, transform/langfuse-all, batch]
      exporters: [otlp_http/langfuse]
```

**Allow-lists, not deny-lists.** Both shapes name what may leave. What a later image or a later span builder adds stays on the machine unless the list names it.

- **The gateway's list.** It leaves out every item § 5.2 names: the key's metadata, the requester's `metadata` and the principal in it, `user.id`, `litellm.key_alias`, `litellm.team_id`, `llm.invocation_parameters`, the arize-style duplicates and a `trace_id` echo. OTTL's `keep_keys` takes exact names, so the gateway's list is one anchored `keep_matching_keys` pattern; its prefixes are written out above.
- **The product's list.** It is `PRODUCT_LANGFUSE_KEYS` in `lib/telemetry/langfuse.ts`. It holds every attribute key a span builder emits, minus the ones excluded on purpose, plus the `langfuse.*` keys that module sets. A test fails when a builder emits a key that is on neither list (§ 9.5). So a new attribute is a decision, not an accident.

  The keys excluded on purpose are:

  - `hb.principal`, `hb.subject`, `url.path` and every `http.*` key;
  - `gen_ai.usage.*`, `gen_ai.request.model`, `gen_ai.response.model` and `gen_ai.system`, which the generation beneath carries;
  - `hb.parent`, once it has been used (§ 5.6).
- **What the processors cannot remove.** They remove attributes, span events and the gateway's resource attributes. They do not touch span links, which neither producer writes, or the span's status message. The product's status message is a code (spec 21 § 5.1). The gateway sets an `ERROR` status with no message (`opentelemetry.py:2102-2165`).

**Compose (`docker-compose.yml`, service `otel-collector`).**

- `env_file: [{ path: ./infra/observability/.env, required: false }]`. The five variables live there. Compose sets none of them, so each half of the switch and the environment label is a separate act (§ 9.1).
- `networks: [default, hb-internal]`. `default` is its road off the machine, and it is where the gateway reaches it. `hb-internal` lets the compose `workers` container reach it, as it reaches the gateway.

### 5.6 Roots

Langfuse's OpenTelemetry page says: "Langfuse also requires that a root span is sent to our backend to ensure that a trace is created correctly". It also warns that span-level filtering may leave traces incomplete. This road drops every `http.request` span, and two parents would otherwise be missing:

- **A request's children.** In a turn, `assistant.answer` is a child of the workers' request span. A search query's embedding is a child of the workers' `/embed/query` request span (`workers/server.ts:190`, `:204`). On the web tier, a span recorded inside `lib/api/handler.ts:297` is a child of the web request.
- **The operator's checks.** `npm run gateway:check` and `npm run research:check` never start telemetry. Only `instrumentation.ts`, `workers/main.ts`, `scripts/assistant-purge.ts` and `scripts/auth-sweep.ts` call `startTelemetry`. So the parent named in their `traceparent` is never sent, before unit 81 and after it.

What this spec does about each:

- **Request children become roots on the Langfuse road.**
  - `withSpanScope` takes an optional `request: true`. The two request scopes pass it: the web tier's handler and the workers' server.
  - `recordSpan` adds `hb.parent: request` to a span whose parent it inherits from such a scope. It does not add it to a span whose parent is given explicitly, or to one recorded outside a scope.
  - On the Langfuse road, the collector clears the parent of a marked span, then drops the mark (§ 5.5).
  - Tempo keeps the real parent and the mark, an enumeration.
  - Before unit 83, a turn's spans therefore reach Langfuse as roots side by side. From unit 83, only `assistant.answer` and `search.query` carry the mark, and everything else nests under them.
- **The checks start telemetry.** Both scripts call `startTelemetry("hb-jobs")` before the call and `stopTelemetry()` before they exit, as the purge does (unit 80). Their model call's own span then has no parent, so it is the root, and the generation nests under it.
- **Activities are roots by construction** (§ 7.1). A suggestion's or a research run's trace therefore has several roots, one for each activity execution. Langfuse's rule asks that a root be sent, and one is. How Langfuse draws a trace with several roots is unverified: unit 84 is the first to see it (§ 18).

## 6. Traces, names and grouping

### 6.1 Subjects and their trace ids

| Subject | Trace id | Exists today? | Trace name (`langfuse.trace.name`) |
|---|---|---|---|
| A reader's turn | the turn's request trace (`Message.traceId`; the workers continue it) | yes | `assistant.turn` |
| A person's research run | `ResearchRun.traceId`, the start request's trace (`lib/db/research.ts:178`) | yes | `research.run` |
| A finding sent as an improvement (`SendFindingWorkflow`) | its run's trace | resolved (§ 7.2) | `research.run` |
| A suggestion: its evidence grades, every attempt, its adjudications, its curator's actions, its merge | `suggestionTraceId(id)`: the first 32 hex of sha256(`"suggestion:" + id`) | **new** | `suggestion` |
| An audit export, the engine's proving run, any other workflow | `workflowTraceId(workflowId)`: the first 32 hex of sha256(`"workflow:" + workflowId`) | new | `export`, `engine.check` |
| A search query's embedding (the search page) | the page loader's trace (exists) | yes | `search.query` |
| An operator's check (`npm run gateway:check`, `research:check`) | its own new trace; the call's span is its root (§ 5.6) | yes | none set; Langfuse shows the root's name, the agent (§ 6.2) |

Langfuse's own SDKs derive a trace id from a seed in the same way, so a suggestion's trace can be found again from its id alone. The two pure functions live in `lib/telemetry/subjects.ts` and use `sha256Hex` from `lib/ledger/hash.ts`.

**A suggestion's trace, and what changes for its calls.**

- **Evidence grades.** The grader's call takes `suggestionTraceId(suggestion.id)` in place of the random id it takes today (`workers/activities/evidence.ts:329`).
- **The adjudicator.** Its call takes the same trace in place of the attempt's (`workers/activities/suggestion.ts:438`).
- **The attempt's own trace id is unchanged.**
  - The workflow makes it with `uuid4()` (`workers/workflows/suggestion.ts:148`).
  - It is kept on `Adjudication.traceId` and in the `GRADED` and `DECIDED` payloads.
  - `outcomeOf` still uses it to tell which attempt an adjudication belongs to (`suggestion.ts:255`).
  - It stops naming the trace of the attempt's calls. Spec 33 § 12 says "its graded and decided records', and its calls'", and loses the last two words (§ 17).
- **No workflow code changes, so nothing replays differently.**
- **The ledger rows.** A grading or adjudication row's `BudgetLedger.traceId` becomes the suggestion's trace. No query reads those rows by trace: `gradingUsage` reads by principal, `ref` and time. The only query by trace is the assistant's (`lib/db/budget.ts:180`), which these rows do not reach.
- **What it looks like in Langfuse.** The trace spans the suggestion's whole life. Langfuse lists it on the day it began, and its latency is its age. Each generation keeps its own latency. Find a suggestion by `metadata.suggestion_id` (§ 6.4).

### 6.2 The agents

Every model call names its agent. `GatewayCall` gains a required field `agent` (`AgentNameSchema`, `lib/schemas/gateway.ts`), set at every call site, because the purpose and the alias cannot tell a draft from a repair. The request row stays optional, as today (`GatewayCall.row`).

| Agent (generation name) | Request row (`lib/gateway/policy.ts`) | Purpose · alias | Call site |
|---|---|---|---|
| `assistant.classify` | `scopeClassifier` | assistant · `hb-small` | `workers/answer/run.ts` `classify` |
| `assistant.draft` | `assistantDraft` | assistant · `hb-frontier`, streamed | `run.ts` `draft`, no extra |
| `assistant.repair` | `assistantRepair` | assistant · `hb-frontier`, not streamed (`run.ts:229-233`) | `run.ts` `draft` with the repair's instruction |
| `assistant.grade` | `groundingGrader` | grading · `hb-frontier` | `run.ts` `grade` |
| `evidence.grade` | `evidenceGrader` | grading · `hb-small` | `workers/agents/grader/evidence.ts` |
| `evidence.grade.bytes` | `evidenceGraderBytes` | the same, a PDF or an image | the same |
| `adjudicator.decide` | `adjudicator` | adjudication · `hb-frontier` | `workers/agents/adjudicator/adjudicate.ts` |
| `researcher.plan` | `researchPlanner` | research · `hb-small` | `workers/agents/researcher/v2/planner.ts` (and the legacy `planner.ts` until unit 78) |
| `researcher.read` | `researchReader` | research · `hb-frontier` with web search and fetch, streamed (`lib/gateway/turn.ts:88-91`) | `v2/reader.ts` (and the legacy `reader.ts`) |
| `researcher.write` | `researchWriter` | research · `hb-frontier` | `v2/writer.ts` |
| `embed.query` | — | embed · `hb-embed` | `workers/embed.ts` `embedQuery` (retrieval; the search page's query) |
| `embed.release` | — | embed · `hb-embed` | the release's embedding job (`workers/embed.ts`); dropped on the Langfuse road (D3) |
| `rerank` | — | rerank · `hb-rerank` | `lib/gateway/rerank.ts`, through retrieval |
| `gateway.check` | — | assistant · `hb-small` | `workers/check.ts` |
| `research.check` | — | research · `hb-frontier`, streamed | `workers/research/check.ts` |

**What every call sends.** `callModel`, `embedTexts` and `rerank` send two headers beside `traceparent`. They go through the SDK's request options and never in the body, so `promptSha256` is unchanged:

- `langfuse_generation_name: <agent>`;
- `langfuse_version: <guide version>`, where the call has a guide.

The OTel logger copies `langfuse_*` headers into the metadata it reads (`langfuse_otel.py:57-83`, through `langfuse.py:304-332`). They arrive as the span attributes `langfuse.generation.name` and `langfuse.version` (`langfuse_otel.py:86-126`). The collector makes the first the span's name (§ 5.5). Langfuse reads the second as the observation's version, so a guide's versions can be compared in its dashboards.

**What the headers carry.** An enumeration member, and a version that matches the guide manifest's pattern. Never text. The proxy does not forward client headers to the provider: that needs `forward_client_headers_to_llm_api`, which is not set here.

### 6.3 Span names and observation types

| Span (Tempo name; Langfuse name where different) | Langfuse type | Parent | Emitted by | New? |
|---|---|---|---|---|
| `assistant.answer` | `agent` | the workers' request span; on the Langfuse road a root (`hb.parent`, § 5.6) | the turn (`workers/answer/turn.ts`), **now opened at the turn's start** with a span id of its own, so everything the turn does nests under it | scope new |
| `assistant.retrieve` | `retriever` | the turn, or the research plan's activity | `retrieveForAnswer` and `workers/research/run/plan.ts`. It is **now a scope**, so the query's embedding and the re-rank nest under it. | scope new |
| `gen_ai.chat`, `gen_ai.embeddings`, `gen_ai.rerank` (Langfuse: the agent's name) | `span` | the step that made the call | `logGatewaySpan`, with `hb.agent` and the `traceparent`'s span id | attribute new |
| the gateway's generation (Langfuse: the agent's name; `litellm_request` before unit 81) | `generation`, or `embedding` | the call's span above | the gateway | new |
| `aid.run` | `span` | the turn | `runAidForTurn` | — |
| `sensor.<name>` | `guardrail`, level `WARNING` where it did not pass (§ 8) | the step that ran it | § 8 | new |
| `activity.<ActivityType>` | `span` | none: each is a root of its subject's trace | the activity interceptor (§ 7) | new |
| `research.plan`, `research.read`, `research.write`, `research.run` | `span` | the activity that printed them | the research lines (48 § 5.8) | nest new |
| `search.query` | `span` | the workers' request span; on the Langfuse road a root (§ 5.6) | the workers' `/embed/query` route: a scope around the search page's query embedding. Its line is a `search` line (`LINE_KINDS` gains it). | new |
| `http.request`, `job` | — | — | dropped on the Langfuse road; unchanged in Tempo | — |

**The scope helper.** `lib/telemetry/spans.ts` gains `inSpan(record, fn, trace?)`, which does four things:

1. it takes a new span id;
2. it runs `fn` inside `withSpanScope({ traceId, spanId, trace })`, where `trace` holds the subject's trace attributes of § 6.4;
3. it records the finished line with that id once `fn` settles, whether it resolved or threw;
4. `recordSpan` adds the scope's trace attributes to every span recorded inside it.

It is the existing pattern of the workers' server (`workers/server.ts:190`), made reusable. A span is still built from a finished line, and nothing in spec 21 § 5.1's seam changes.

**Types.**

- `SpanName` gains the template members `` `sensor.${string}` `` and `` `activity.${string}` ``.
- `SpanAttribute` gains `ReadonlyArray<string>`, for tags.
- Observation types and levels are set by one pure function, `langfuseAttributesOf(name, attributes)`, in `lib/telemetry/langfuse.ts`. That is the only module of the product that names a `langfuse.*` attribute, and a test greps for the prefix everywhere else (§ 16).

### 6.4 Trace name, tags, release and metadata

Langfuse's OpenTelemetry page says trace-level attributes "need to be present on each span in the trace, not only on the root span" for filtering and aggregation to work. So this spec sets them as follows:

- **Name, tags, release and record ids** are known when the subject's scope opens. They are carried in the scope and set on every product span recorded inside it (§ 6.3).
- **The outcome** is known only at the end. It is set on the subject's own span, which is recorded last.
- **The gateway's generations carry none of them.** Their span is LiteLLM's, and the keep-list drops whatever `langfuse.trace.*` it might set.

Two consequences follow:

- **Every widget of § 13 still works.** They break down by observation name, model, version, type and level, which every generation carries.
- **One thing is not offered: aggregating generations by trace name, tag or outcome** (for example, "the cost of generations in `mode:compare` turns"). The agent names already partition the work by kind (`assistant.*`, `researcher.*`, `evidence.*`, `adjudicator.*`). A trace's own total cost, which Langfuse sums from its observations, can be filtered by any trace attribute.

| Subject | `langfuse.trace.name` | `langfuse.trace.tags` | `langfuse.release` | `langfuse.trace.metadata.*` |
|---|---|---|---|---|
| A turn (scope `assistant.answer`) | `assistant.turn` | `turn`, `mode:<mode>`, `locale:<en\|pt>` | the release id (`2026.09`) | `message_id` (the assistant row), on every span; `outcome` (`answer`, `refusal`, `failed`) and `refusal_cause` or `code` where there is one, on `assistant.answer` |
| A research run (each activity's scope) | `research.run` | `research` | — | `run_id`, on every span; `outcome` (the run's state, with its skip or failure code), on `research.run` |
| A suggestion (each activity's scope of its family) | `suggestion` | `suggestion` | — | `suggestion_id` (`S-21-0016`), on every span |
| An export, the engine's proving run | `export`, `engine.check` | `export`, `check` | — | `workflow_id`, on every span |
| A search query (scope `search.query`) | `search.query` | `search` | the release id | — |

**Tags are enumerations.** Tags carry no whitespace and never a count, so spec 21's test of every exported span ("no whitespace in a string attribute") still holds.

**The outcome is metadata, not a tag.** Langfuse filters on top-level trace metadata. An outcome known only at the end would otherwise depend on how Langfuse merges tags.

**The workflow is an observation's attribute.** A suggestion's trace holds several workflows (`evidence:<item>`, `suggestion:<id>`, `merge:<id>`). So `hb.workflow.type` and `hb.workflow.id` go on each activity span, and Langfuse files them under the observation's metadata.

**The legacy research workflow sets no trace attribute.** Its runs carry a turn's trace (§ 7.2), so its spans add only observation metadata: `run_id` and the tag `legacy` as `hb.legacy: true`. They leave the turn's name and tags alone. No production path starts it any more: `RESEARCH_WORKFLOW` is only registered (`lib/schemas/workflows.ts:203`), and only the test seed `scripts/research-seed.ts:161` starts it. So this affects only runs already in flight.

### 6.5 What never goes into an attribute

A span on the Langfuse road may hold:

- trace and span ids;
- the agent, the guide version and hash, the prompt hash;
- the model, tokens, cost and timings;
- counts, enumerations and codes;
- record ids: a message id, a run id, a suggestion id, an evidence item's id, a workflow id, the gateway's call id;
- the environment;
- in development only, on the gateway's generation of a call that succeeded, the request's messages and the answer (§ 9).

It never holds:

- **Words.** A question, an answer, a brief, a report, a page's text, address or title, a proposal, a rationale, a curator's note, an evidence document, an error's message or stack trace. Spec 21 § 5.1 already says this, and the guard (`lib/security/guard.ts`) still runs on every span.
- **A person or an account.** No user id, no `user.id` or `langfuse.user.id`, no principal (`hb.principal` is not on the product's list), no subject (`hb.subject`), no organisation id, no e-mail, no display name, no key hash or alias.
- **A session.** No `session.id` or `langfuse.session.id`, and no conversation id or research conversation id.

Only the collector's two allow-lists keep these out (§ 5.5). Neither LiteLLM's settings nor the product's own spans are relied on.

**Why (D1):**

- **Invariant 26.** It forbids any screen that counts messages per session or ranks contributors. Langfuse's Sessions page counts traces per session and their duration. Its Users page ranks users by traces, tokens and cost. Both stay empty.
- **Architecture § 7.** It lists time on page and messages per session as "not collected, by design".
- **Cost per account has a home.** It is `BudgetLedger`'s, the one set of numbers the gates and the meter read (spec 21 D4).
- **Record ids are allowed.** A record id names a record that the product's own tenant filter and policy still guard, and spans and lines already carry them. A pseudonymous user id is not a record of the work: it is the person.

**Not even pseudonyms.** The ledger's actor is a pseudonymous user id, kept for audit. Langfuse is not an audit store, and it needs no actor.

## 7. The workflows' activities

### 7.1 The interceptor (`workers/telemetry/activities.ts`)

The workers' engine registers one activity inbound interceptor: `Worker.create({ …, interceptors: { activity: [activitySpans(deps)] } })` in `workers/temporal.ts`. For each execution it does four things:

1. **Reads the execution.** From `Context.current().info` it takes the activity type, the workflow type, the workflow id and the attempt.
2. **Resolves the subject's trace** and its trace attributes (§ 7.2, § 6.4).
3. **Runs the activity inside `inSpan`,** with no parent, so the activity's model calls, sensors and lines nest under it.
4. **Prints an `activity` line and records the span `activity.<ActivityType>` from it,** since every span is built from a finished line (spec 21 § 5.1).
   - The span carries `hb.workflow.type`, `hb.workflow.id`, `hb.activity.attempt` and `hb.outcome` (`ok`, `failed`, `cancelled`). On a failure it also carries `hb.code`.
   - The code is the `ApplicationFailure`'s type where that matches `CODE_PATTERN`. Otherwise it is `TIMEOUT` or `CANCELLED`, and failing those, the error's name. Never its message.

`LINE_KINDS` gains `activity`, and the collector's file receiver allow-list gains it in the same unit.

**What it leaves alone.**

- It changes no workflow code, no activity argument and no workflow history.
- It runs in the worker's Node context, outside the workflow sandbox. Invariant 35 is untouched, and nothing waiting in the development engine replays differently.

**How it fails.**

- It rethrows whatever the activity threw, unchanged.
- Its own failure (a lookup, a line) is caught and logged by code. A span is lost, never an activity (spec 21 § 8).

The workflow suites (`tests/workflows/`) build their own workers and do not need the interceptor. Its tests run it against a fake context (§ 16).

### 7.2 Resolving the trace

`workers/telemetry/traceOf.ts` maps the workflow id. The pure part lives in `lib/telemetry/subjects.ts`.

| Workflow id | Trace | How |
|---|---|---|
| `suggestion:<S>`, `merge:<S>` | `suggestionTraceId(S)` | pure |
| `evidence:<itemId>` | `suggestionTraceId` of the item's suggestion | One read. `lib/db/improve.ts` gains `suggestionOfEvidenceItem(caller, itemId)`, read as the grader's service caller. It returns the suggestion's id or `null`. |
| `research:<id>` | the run's `traceId`; a legacy `ResearchWorkflow` run is keyed by its message's id | One read. `lib/db/research.ts` gains `researchTraceOf(id)`, under `withSystem`, by run id, then by message id. It returns the trace id or `null`. |
| `finding:<findingId>` | its run's `traceId` | one read: `researchTraceOfFinding(findingId)` |
| `export:<id>`, `proving:<token>`, anything else | `workflowTraceId(workflowId)` | pure |

- **A failed or empty read falls back.** A read that fails or finds nothing (a run deleted, a finding detached) gives `workflowTraceId(workflowId)`. The fallback prints one warning line naming the workflow type and the error's name.
- **One primary-key read per execution, and no cache.** A cache would need a size, which no source gives. An activity already makes several reads of its own.
- **The legacy research workflow.** Its runs carry a turn's trace, so its spans land in that turn's trace, as its lines always did. It sets no trace attribute (§ 6.4).

The trace name and the tags of § 6.4 follow the workflow type:

- `ResearchRunWorkflow` and `SendFindingWorkflow` → `research.run`;
- `ResearchWorkflow` (legacy) → none;
- `SuggestionWorkflow`, `GradeEvidenceWorkflow` and `MergeWorkflow` → `suggestion`;
- `ExportWorkflow` → `export`;
- `ProvingWorkflow` → `engine.check`.

## 8. Sensors as guardrails

A sensor's run is a `sensor` line. `LINE_KINDS` gains `sensor`, and so does the collector's file receiver allow-list; the test that compares the two lists keeps them equal. When a tracer is running, the line is also a `sensor.<name>` span with:

- `hb.sensor.result`: `PASS`, `FAIL`, `WARN` or `NA`;
- `hb.sensor.check` or `hb.code`: the named check or rule that decided it, an enumeration;
- the counts the sensor already reports (claims substituted, findings valid and invalid, paragraphs kept and dropped);
- the measured time of the pure call;
- never its detail string.

Langfuse shows it as a `guardrail`. Langfuse takes an observation's level from `langfuse.observation.level`; if that is absent it infers the level from the span's status, so a sensor span would show `DEFAULT`. So `langfuseAttributesOf` sets `langfuse.observation.level: WARNING` where the result is `FAIL` or `WARN`, and a test checks it (§ 16). A failing sensor is the product working, not an error, so it is never `ERROR` and its span has no error status.

Each sensor is recorded where it runs, timed around the pure call:

- **The turn.** The scope rules, and the citation, mode and edition sensors of each sensor pass. `AnswerDeps` gains an optional `onSensor(verdict, ms)`. `workers/answer/flow.ts` calls it, and `turn.ts` prints the line. The grounding grader is a model call (`assistant.grade`), not a sensor span.
- **A research run.**
  - The brief sensor, in the plan step (`lib/sensors/brief.ts`).
  - The findings' and the notes' validation, in the check step (`lib/research/validate.ts`): counts only.
  - The report sensor, in the write step (`lib/sensors/report.ts`).
- **A suggestion.** The intake sensors (`runIntake`) and the consistency sensors (`runConsistency`), one span per verdict, in their activities.

## 9. The development-only text switch

### 9.1 Two halves, and a development check

**The workers' half: `LANGFUSE_MESSAGE_TEXT` in the project `.env`.**

- **Values.** `on` or `off`, default `off`. `lib/env.ts` takes it as `z.enum(["on", "off"]).default("off")`, so `true`, `1` or `yes` is refused at boot instead of being read as anything.
- **Never in production.** The production check in `lib/env.ts` refuses `on`, as it refuses `AUTH_DEV_PROVIDER`: "LANGFUSE_MESSAGE_TEXT must be off in production (feature-specs/49 § 9)". The web tier and the workers share that schema, so neither boots with it.
- **On takes effect only behind a positive development check.** `NODE_ENV` defaults to `development` in `lib/env.ts:13`, and nothing that runs the workers sets it: not `tsx`, not the workers' image, not compose's `workers` service. A deployment that forgets `NODE_ENV=production` would therefore pass a test of "not production". So `lib/env.ts` exports `messageTextGate: { on: boolean; why: string | null }`. Its `on` is true only when all four of these hold:
  1. `LANGFUSE_MESSAGE_TEXT` is `on`;
  2. `NODE_ENV`, as the process received it (`read("NODE_ENV")`, before the default), is exactly `development`;
  3. `APP_URL`'s host is a loopback host (`localhost`, `127.0.0.1` or `::1`);
  4. `AUTH_DEV_PROVIDER` is `1`, which production refuses already.

  `why` names the first condition that failed.
- **On, but the check fails: ignored, and said so.** The setting is not refused at boot, because a test process or a scheduled job that reads the same `.env` must not stop booting. It is ignored, which fails closed, and the workers print one line at boot: "langfuse: LANGFUSE_MESSAGE_TEXT=on is ignored: <why> (feature-specs/49 § 9.1)".
- **The workers say so when it is in effect.** Their boot line reads: "langfuse: prompts and answers go to Langfuse (LANGFUSE_MESSAGE_TEXT=on, development, test accounts only)".
- **Andre's development `.env` passes the check as `.env.example` writes it** (`APP_URL=http://localhost:3000`, `AUTH_DEV_PROVIDER=1`), plus one line he adds with the switch: `NODE_ENV=development`. Next sets `NODE_ENV` itself before it reads `.env`, so the line changes nothing for `next build` or `next start`.
- **Compose's `workers` service never receives the setting.** Its container has neither a raw `NODE_ENV=development` nor `AUTH_DEV_PROVIDER`, so the gate would be off there anyway.

**The collector's half: `LANGFUSE_MESSAGE_TEXT` in `infra/observability/.env`.** Same values, default `off`. It is read only by the collector's condition (§ 5.5), and Andre sets it in a different file from the workers' half. If the two halves disagree, no text goes.

### 9.2 The locks, and the one that holds alone

On a call that **succeeded**, three locks stand, and each fails closed:

1. **The workers send the opt-out only behind the gate.** `lib/gateway/messageText.ts` `messageTextHeaders(agent, gate)` returns `{ "litellm-disable-message-redaction": "true" }` only when the gate is on and the agent is not `evidence.grade.bytes`. Otherwise it returns `{}`. `callModel`, `embedTexts` and `rerank` spread it into their request options. It is the only file of the product that names the header.
2. **The gateway honours the opt-out only for a key that may.**
   - The global `turn_off_message_logging: true` stays in the committed yaml, which is the same file every environment deploys.
   - At the pinned image, the proxy strips a client's opt-out (the header, or a false `turn_off_message_logging` parameter) while that global is on (`proxy/litellm_pre_call_utils.py:2145`). The exception is a virtual key, or its team, whose metadata carries `allow_client_message_redaction_opt_out: true` (`:318`, `:1938`).
   - `workers/keys.ts` mints a key with that flag only while the gate is on, in the minting process (D2). It never does otherwise.
   - A key minted while the gate was off has no flag. Its requests stay redacted, which is the safe way to be wrong, and Andre rotates it (§ 16, unit 82).
3. **The collector passes text only when its own half says so.** On the Langfuse road, it deletes the gateway's `langfuse.observation.input` and `langfuse.observation.output` unless the collector's `LANGFUSE_MESSAGE_TEXT` is `on`. The product's own spans pass only their allow-list, which names no text-bearing key.

On many calls that **failed**, LiteLLM redacts nothing, and only the collector's lock holds. Read in the image:

- **The failure path skips redaction when its asynchronous handler runs first.** The asynchronous failure handler (`litellm_core_utils/litellm_logging.py:3571-3640`) hands every logger `model_call_details` without redacting it. Only the synchronous handler redacts (`:3423`).
- **`dispatch_failure_handlers` runs the asynchronous one first** on any call through the proxy (`:1979-2004`). The other runs afterwards.
- **Three kinds of failure take that route:**
  - **A streamed call that fails after it started.** The `/v1/messages` stream's upstream error goes to `PassThroughStreamingHandler.schedule_stream_failure_logging` (`llms/anthropic/experimental_pass_through/messages/streaming_iterator.py:664-686`), which dispatches with `prefer_async_handlers=True` (`proxy/pass_through_endpoints/streaming_handler.py:63-84`). The streamed calls are `assistant.draft`, `researcher.read` and `research.check`. The repair is not streamed (`workers/answer/run.ts:229-233`).
  - **A call the router rejects** (`router.py:8625`, `:13117`).
  - **A call the proxy's gate refuses**: an auth, rate-limit or budget refusal, the product's `budget` outcome among them. `proxy/utils.py:3020-3109` builds a logging object, puts the request's `messages` in it and runs the asynchronous handler first. It marks the call `LITELLM_LOGGING_NO_UPSTREAM_LLM_CALL` (`:3084`), and the image's newer `integrations/otel/` honours that marker and writes no span. The `opentelemetry.py` logger that `langfuse_otel` extends never reads it. So a refusal may write an `ERROR` generation that carries the request's messages. Unit 80's checks do not exercise it, and the fixture test covers it as an `ERROR` span.
- **The OpenTelemetry logger emits one failure span per call** (`_emit_once`, `opentelemetry.py:2118`). The first handler wins, so the unredacted span is the one written. `langfuse_otel` puts the raw `messages` into `langfuse.observation.input` (`langfuse_otel.py:248-254`). It does so whatever the global says and whether or not the key has the flag.
- **LiteLLM's own source says so.** `redacted_standard_logging_payload`'s docstring reads: "The success path redacts through `perform_redaction` before a callback ever sees the payload, but the failure path does not" (`redact_messages.py:166-174`).
- **A call that was not streamed and failed is redacted.** The SDK wrapper runs the synchronous handler first and redacts in place (`utils.py:2076-2083`).

So, unconditionally:

- the collector deletes the input and the output of every gateway span whose status is `ERROR`, and of every `evidence.grade.bytes` span, whatever either half of the switch says (§ 5.5);
- span events are dropped, so an exception's message and stack trace never leave (§ 5.5);
- Tempo receives no gateway span at all (§ 5.5).

This is decided here, not asked: a failed call's prompt does not reach Langfuse even in development. The product's own span and line still give the failure's code. A test runs the pinned collector over a recorded failed span carrying raw input (§ 9.5).

In production every lock fails closed, and the failure path is closed by the collector:

- the boot refuses `on`;
- the gate needs a raw `NODE_ENV=development`, a loopback `APP_URL` and the development sign-in;
- no key minted there carries the flag;
- the proxy strips the header without the flag;
- the collector's half is `off`;
- the collector deletes every failure's text and sends nothing to Langfuse Cloud unless the environment is labelled `development` (§ 5.5).

### 9.3 What text reaches Langfuse with both halves on

- **The input of a generation that succeeded, except the evidence grader's PDF or image row.** The input is the request's `messages`, serialised whole (`langfuse_otel.py:248-254`):
  - the retrieved sections, the conversation, and the reader's question (already redacted of secrets before it was stored or sent, spec 21 D5);
  - a research question, a brief, the pages' notes;
  - a fetched evidence text.
- **The output.** The logger writes the first choice's role and content of the response as LiteLLM logs it, or that choice's tool calls when it has some (`langfuse_otel.py:129-175`). Two things are unverified until unit 82's live look:
  - whether a thinking block, or a web tool's result in the researcher's reader, reaches it;
  - what a `/v1/messages` response looks like by the time it reaches this function.
- **Not `system`.** It travels as a parameter (`llm.invocation_parameters`), which the keep-list drops. It holds the guides, the rubric and the mode line, which are in the repository, and the generation's version names them. That `system` is not inside the logged `messages` on `/v1/messages` is read, not seen. Unit 82's look confirms it.
- **Not the evidence bytes.** A PDF or an image is base64 of up to 32 MB a request (`lib/improve/media.ts`). It would make spans the collector and Langfuse may refuse, and it is a file a contributor uploaded, not a turn of conversation. This is decided here, and enforced twice:
  - that row sends no opt-out, so LiteLLM redacts it on success;
  - the collector deletes its input and output by name in every case.

  This closes the tracker's "Base64 to Langfuse through the gateway" risk (§ 17).
- **Not a failed call's text** (§ 9.2).
- **Nothing of the product's own spans,** whatever the switch says.

With the switch off, LiteLLM replaces a successful call's messages and response with `redacted-by-litellm` before its logger runs, and the collector deletes even that.

### 9.4 The reversal of D6, limited to development

Spec 45 D6 is amended to read: "Switch message bodies off at the gateway (Andre, 2026-10-11) … Since 2026-10-14 (feature-specs/49, Andre's L2), in development only, a request of a key minted under the development gate may opt out per request while `LANGFUSE_MESSAGE_TEXT=on` passes that gate. The global stays on, production refuses the setting, and a failed call's text never leaves the collector."

Reading the image again gives three corrections to spec 45 § 29. The yaml's comment, which repeats § 29, is corrected in unit 80.

- **The opt-out needs the key's flag.** § 29 says "A request can still turn redaction off". At the pinned image, it can only for a key or team whose metadata allows it. Otherwise the proxy strips the header and the parameter.
- **The old callback was not text-free.** § 29 says "Langfuse then keeps spans, timings and costs and no text". With the `langfuse` callback, `system` and `metadata` would have reached Langfuse as model parameters (§ 5.2).
- **Redaction does not cover every failure.** § 29 says LiteLLM replaces the messages "on success and on failure". A failure whose asynchronous handler runs first reaches every logger with the request's messages (§ 9.2). That covers a streamed call that fails after it started, a router's rejection, and a refusal at the proxy's gate, the budget's among them.

None of the three ever mattered in practice: no Langfuse key was written, and no other logger runs, so nothing was sent.

### 9.5 How tests prove it

- **`lib/env.test.ts`:**
  - unset reads `off`, and the gate is off;
  - `on` with a raw `NODE_ENV=development`, a loopback `APP_URL` and `AUTH_DEV_PROVIDER=1` turns the gate on;
  - each of the four conditions missing on its own turns the gate off, with `why` naming it. That includes `NODE_ENV` unset, which the schema defaults to `development`;
  - `on` under `NODE_ENV=production` is refused, naming the variable;
  - `true`, `1` and `yes` are refused in any environment.
- **`lib/gateway/messageText.test.ts`:**
  - the header only when the gate is on and the agent is not `evidence.grade.bytes`;
  - an empty object for every other combination, over every member of `AgentNameSchema`.
- **`lib/gateway/client.test.ts`, `embed.test.ts`, `rerank.test.ts`:**
  - the request carries the header exactly where `messageTextHeaders` says;
  - it always carries `langfuse_generation_name`, and carries `langfuse_version` where the call has a guide;
  - the `traceparent`'s span id is the model-call span's id;
  - neither changes the body or `promptSha256`.
- **`workers/keys.test.ts`:** a key minted while the gate is on has `allow_client_message_redaction_opt_out: true`. One minted while it is off, in any environment, has no such key.
- **`tests/gateway-config.test.ts`:**
  - `turn_off_message_logging` is `true`;
  - the callbacks are `["langfuse_otel"]` alone, with no `success_callback` or `failure_callback`;
  - no `allow_client_message_redaction_opt_out` appears in the yaml;
  - every definition of the gateway service in the repository sets `OTEL_EXPORTER: otlp_http`, `OTEL_ENDPOINT` and `OTEL_SERVICE_NAME: hb-gateway`. It also sets `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `LANGFUSE_OTEL_HOST` and the three `UPSTREAM_LANGFUSE_*` to `""`;
  - no `LANGFUSE_*` key appears in `infra/gateway/.env.example`;
  - unit 64's case "nothing of the application sends the header or the parameter" becomes "only `lib/gateway/messageText.ts` names the header, and no file names the parameter".
- **`tests/observability.test.ts`** (reads the files):
  - the Tempo pipeline holds `filter/tempo`, and its condition is on `hb-gateway`;
  - the Langfuse pipeline exists, and its processors come in the order of § 5.5;
  - the filter drops everything while the endpoint or the environment is empty, and Cloud for any environment but `development`;
  - the product's keep statement lists exactly `PRODUCT_LANGFUSE_KEYS`;
  - the gateway's keep pattern is exactly the one in § 5.5;
  - the gateway's text deletions cover `ERROR`, `evidence.grade.bytes`, and the switch with its default of `off`;
  - the exporter is `otlp_http/langfuse`, carries the ingestion header and authenticates with `basicauth/langfuse`;
  - compose sets no `LANGFUSE_*` value for the collector, and the collector's `env_file` is `infra/observability/.env`;
  - nothing in the file is a key.
- **`lib/telemetry/langfuse.test.ts`:**
  - each span builder is run with a fixture (`httpSpanOf`, `genAiSpanOf`, `retrieveSpanOf`, `answerSpanOf`, `aidRunSpanOf`, `researchSpanOf`, `jobSpanOf`, and from their units the sensor, activity and search builders);
  - every attribute key they emit is in `PRODUCT_LANGFUSE_KEYS` or in the deliberate exclusions of § 5.5;
  - `langfuseAttributesOf` sets `WARNING` for a `FAIL` or `WARN` sensor and no level otherwise.
- **`tests/observability-collector.test.ts`** (new). It runs only with `HB_COLLECTOR_TEST=1` and Docker present. The builder runs it in each unit that touches the collector.
  - It starts the pinned collector image with `--network none`. The configuration is the committed file with its receivers and exporters swapped: OTLP JSON fixture files in, `file` exporters out, one per pipeline. The processors are the committed ones, unchanged.
  - The fixtures are written from the image's attribute names, with file and line beside each:
    - a redacted success of the gateway;
    - a gateway success with text and the opt-out;
    - a gateway `ERROR` span with raw `langfuse.observation.input` and an `exception` event;
    - an `evidence.grade.bytes` success with text;
    - a gateway span whose `metadata` holds `user_api_key_alias` and `requester_metadata`, with `user.id`, `litellm.key_alias`, `llm.invocation_parameters` and `deployment.environment: production`;
    - product spans carrying `hb.principal`, `hb.subject`, `url.path`, `gen_ai.usage.*` and `hb.parent: request`;
    - `http.request`, `job` and `embed.release` spans;
    - two senders that are not the product's, one named and one not, whose resources carry a host, a user and a command line, and whose span names and status messages carry a question.
  - It asserts the two outputs in five configurations:
    - **The collector's half off.** No input or output on any gateway span, no event, no identity key, every resource cut to its name, every product span reduced to its list, and nothing of either foreign sender.
    - **The half on.** Text on the successes only: never on the `ERROR` span or the bytes row.
    - **The endpoint empty,** with the two keys set and empty too, as a copied example leaves them. The Langfuse output is empty.
    - **The environment unset,** with a self-hosted endpoint, so that only the environment's own condition can stop it. The same.
    - **A `cloud.langfuse.com` endpoint written in mixed case, with the environment `production`.** The same.

    In every configuration, the Tempo output holds no `hb-gateway` span and both foreign senders' spans (Tempo stays on this machine), and a marked product span has no parent in the Langfuse output and its own parent in Tempo's.
  - It never mounts `infra/observability/.env`, and its variables are test values.
- **Live, Andre's (§ 16, unit 82):** one call with the switch off shows no text in Langfuse; the same call with it on shows the prompt and the answer.

## 10. Retention, deletion and LGPD

**With the switch off (every environment).**

- **Langfuse holds no words, and less than Tempo does.** It holds record ids, counts, codes, hashes, timings, tokens and costs. It holds no principal or subject. So a reader's delete, the 30-day purge and an account's deletion have nothing there to reach, as spec 45 § 3.1 already says of "ids in log lines and spans". The delete dialog's list of what stays already names Langfuse.
- **In development, it holds those ids outside Brazil.** That is L1's exception to invariant 29, for test accounts only (§ 17).

**With the switch on (development, test accounts only).**

- **Nothing reaches the copy.** These do not reach Langfuse:
  - a reader's delete of a conversation or a research;
  - the 30-day purge of message text and research text;
  - an account's hard delete (spec 46).
- **The copy stays until Andre deletes it.** Langfuse's data-retention page says: "Without a retention policy, Langfuse does not automatically delete event data". Retention policies are not available on the Hobby and Core plans. Those plans' 30 and 90 days are windows of access, not deletion. So on those plans the test accounts' text, and every id sent while the switch was off, stay in Langfuse Cloud outside Brazil until the project or its traces are deleted.
  - Pro and Enterprise have a retention setting, per project, of three days at the least.
  - Langfuse's API deletes traces by id (`DELETE /api/public/traces/{traceId}`, or in bulk), asynchronously, usually within 15 minutes.
  - Deleting the project in Langfuse's settings deletes all of it.
- **No deletion integration is built.** It would put Langfuse keys in the workers, against the standing rule. It would also serve only test accounts, whose words L2 accepts in Langfuse.
- **LGPD.** While the switch is on with test accounts only, no real person's words or identity reach Langfuse. Andre's own development account is his, and so are his questions. No identity of any account reaches Langfuse in any case (§ 6.5).

**Before any real reader uses the app**, in this order. Unit 86 adds this to the tracker's "before real readers" list.

1. Set `LANGFUSE_MESSAGE_TEXT=off` in the project `.env` and in `infra/observability/.env`. Restart the workers and recreate the collector.
2. Rotate every key that carries the opt-out flag. `npm run gateway:key -- --flagged` lists their principals (§ 16, unit 82). Rotate with the gate off until the list is empty.
3. Stop the export to Langfuse Cloud. Either empty `LANGFUSE_OTLP_ENDPOINT`, or point it at the in-region host once the move is done and set `LANGFUSE_TRACING_ENVIRONMENT` to the deployment's name. Then recreate the collector. The collector refuses Cloud for anything but `development` (§ 5.5), so the second form cannot keep sending to Cloud by mistake.
4. Delete the development project in Langfuse Cloud. This is Andre's act, in Langfuse's project settings. It covers the record ids as well as the text, and on Hobby and Core it is the only way they ever leave.
5. Decide, for the self-hosted Langfuse, how long telemetry is kept (§ 14).

## 11. Failure behaviour

If Langfuse is down, slow or misconfigured, that never slows or fails a turn, a run or a suggestion. Each hop is asynchronous. A hop's failure is logged once and its spans are dropped.

| Hop | Mechanism | When it fails |
|---|---|---|
| product → collector | the product's tracer: a batch processor. It prints one warning when exports start failing and one when they succeed again. `recordSpan` cannot throw (spec 21 § 5.1). | spans dropped; the lines are still printed |
| gateway → collector | LiteLLM's logger runs after the response is returned, in its own batch processor thread | the gateway logs the exporter's error; the call was already answered |
| collector → Tempo | its own pipeline and exporter | as before |
| collector → Langfuse | `otlp_http/langfuse`, with its in-memory sending queue and retry at the exporter's own defaults (no number is set here) | Retried, then dropped. A full queue drops for that exporter alone, never Tempo's. A 401 or another 4xx is not retried, and is logged with its status. |

The collector answers the product as soon as its receiver has a batch. It never waits on Langfuse. A collector restart loses its queue.

## 12. Cost and sampling

- **Langfuse's units.** Langfuse Cloud bills in units: every trace, observation and score is one. Andre's account is on whichever plan he chose.

  | Plan | Price | Units included | Data access |
  |---|---|---|---|
  | Hobby | free | 50,000 a month | 30 days; 2 users |
  | Core | US$ 29 a month | 100,000 | 90 days |
  | Pro | US$ 199 a month | — | three years, with retention settings |

  Overage is US$ 8 per 100,000 units, falling at volume.
- **What a subject costs in units, counted from § 6.3:**
  - a turn: about 18 (the turn, retrieval, two spans for each of the embedding, re-rank, classifier, draft and grader, and three sensors), or about 23 with a repair;
  - a research run: about 27 (six activities, retrieval, three agents' spans and generations, four research lines, three sensors);
  - a suggestion attempt with two evidence items: about 26.

  So Hobby's month is roughly 2,000 subjects.
- **The release's embedding job.** One release is about a thousand calls, each a generation, which is why it is dropped (D3).
- **No sampling.** Every trace in development. A sampling rule needs a rate, which no source gives. It belongs to the self-hosted move, where the volume will be a customer's, not one machine's (§ 14).
- **When the month runs out.** If the units run out, Langfuse refuses or bills, as the plan says. Nothing in the product depends on Langfuse. Andre can empty `LANGFUSE_OTLP_ENDPOINT` and recreate the collector, and the filter then drops everything (§ 5.5).
- **The model calls' own cost** is unchanged. Langfuse shows the gateway's `response_cost`, and `BudgetLedger` remains the cost every gate and meter reads (spec 21 D4).

## 13. The dashboards, and what Andre will see

**Tracing → Traces.**

- **The rows.** Each row is a turn (`assistant.turn`), a research run (`research.run`), a suggestion (`suggestion`), a search (`search.query`) or a check, with its tags, environment `development`, latency, total cost and tokens.
- **Filters.** Filter by name, tag (`mode:compare`, `research`), metadata (`outcome`, `suggestion_id`, `run_id`, `message_id`), release, or level.
- **Sessions and Users are empty, by design (§ 6.5).**

**A trace.** A turn reads, for example:

```
assistant.turn                                      tags turn · mode:explain · locale:en · release 2026.09
└ assistant.answer (agent)                          outcome answer · message_id …
  ├ assistant.retrieve (retriever)
  │ ├ embed.query (span) └ embed.query (embedding)  bge-m3 · tokens · cost 0
  │ └ rerank (span) └ rerank (generation)           ERROR where the re-ranker is not started (its documented degradation)
  ├ assistant.classify (span) └ assistant.classify (generation)   claude-haiku-4-5 · guide version · tokens · cost
  ├ assistant.draft (span) └ assistant.draft (generation)         claude-opus-5 · first token · tokens · cost
  ├ sensor.citation (guardrail) · sensor.mode · sensor.edition   WARNING where one did not pass
  └ assistant.grade (span) └ assistant.grade (generation)         claude-opus-5 · tokens · cost
```

With the switch on, opening a successful generation shows its messages and its answer. With it off, or on a failed generation, it shows neither.

**A research run.** Each activity is a root of the run's trace, in order:

1. `activity.loadRun`;
2. `activity.planRun`: retrieval, `researcher.plan`, `sensor.brief`, `research.plan`;
3. `activity.readRun`: `researcher.read`, `research.read`;
4. `activity.validateRun`: `sensor.findings`;
5. `activity.writeReport`: `researcher.write`, `sensor.report`, `research.write`;
6. `activity.concludeRun`: `research.run`.

**A suggestion.** It holds each `evidence.grade` under its `activity.gradeItem`. Then, for each attempt, its intake and consistency sensors, `adjudicator.decide` and the decision, across days.

**The dashboard.** Andre builds it in Langfuse's dashboard editor, and Langfuse holds it; no code does (unit 86). `infra/observability/README.md` lists the widgets:

| Widget | Measure | Breakdown | Filter |
|---|---|---|---|
| Cost by agent | sum of cost | observation name | type generation or embedding |
| Calls by agent | count | observation name | type generation or embedding |
| Latency by agent | p50 and p95 of latency | observation name | type generation |
| Tokens by model | input, output, cache read, cache write | model | — |
| Work by kind | count of traces | trace name, by day | — |
| Failures | count | observation name | level ERROR |
| Sensors that did not pass | count | observation name | type guardrail, level WARNING |
| Guide versions | cost and count | observation version | type generation |

No widget filters generations by a trace attribute (§ 6.4). These are for looking. Every gate and every product metric still reads the rows (spec 21 D4). The Grafana dashboards are unchanged.

## 14. The move to self-hosted (later, its own spec)

What changes:

- In `infra/observability/.env`, `LANGFUSE_OTLP_ENDPOINT` becomes the São Paulo host's `…/api/public/otel`, and the two keys become that project's.
- `LANGFUSE_TRACING_ENVIRONMENT` becomes the deployment's name. The collector's Cloud rule no longer applies, because the host is not Cloud.
- The invariant 29 exception is closed.

What does not change: the collector's pipelines, the gateway, the workers, the web tier and every attribute name. The ingestion header is harmless to a self-hosted Langfuse that does not read it.

What that spec must decide, and this one does not:

- **How long telemetry is kept.** Self-hosted, Langfuse "stores data indefinitely by default", and its retention setting is an Enterprise Edition feature. So the move must choose a mechanism: the Enterprise licence, a scheduled deletion through the API, or the store's own time limit.
- **The self-hosted stack itself.** Langfuse web and worker, ClickHouse, Redis, an S3-compatible store and PostgreSQL, and their place in architecture § 2.
- **A sampling rate,** if the volume needs one.
- **The development project in Langfuse Cloud,** which is deleted before real readers (§ 10, step 4).

## 15. States and errors

| Situation | What happens | Where it shows |
|---|---|---|
| The `observe` profile is not running (the default) | The product's tracer drops its spans with one warning. The gateway's exporter logs a connection error per batch. No call waits. | the workers' and the gateway's logs; nothing in Langfuse |
| `infra/observability/.env` absent, or the endpoint or the environment empty | `filter/langfuse` drops every span before the exporter; Tempo and Loki as before | nothing in Langfuse |
| A Langfuse Cloud endpoint with an environment other than `development` | `filter/langfuse` drops every span | nothing in Langfuse |
| Another program on the machine sends OTLP to 4318 | `filter/langfuse` drops every span whose `service.name` is not the product's or the gateway's; Tempo keeps them | nothing of it in Langfuse |
| `infra/gateway/.env` still holds Langfuse keys | compose blanks them; the logger exports to the collector | the presence check prints "no Langfuse variable" |
| A deployment of `litellm.yaml` without `OTEL_EXPORTER` and `OTEL_ENDPOINT` | the console exporter prints every span to the gateway's stdout | refused by spec 11 § 8 and the README's checklist; compose is tested |
| Wrong keys | the exporter's 401, not retried | the collector's log, with the status and no key |
| Langfuse unreachable, 5xx or 429 | retried from the queue at the exporter's defaults, then dropped | the collector's log; a gap in Langfuse |
| The collector restarts | its queue is lost | a gap |
| `LANGFUSE_MESSAGE_TEXT=on` under `NODE_ENV=production` | the boot is refused | the boot error names the variable |
| `LANGFUSE_MESSAGE_TEXT` neither `on` nor `off` | the boot is refused | as above |
| `on`, but the development check fails (`NODE_ENV` not set to `development`, `APP_URL` not loopback, no `AUTH_DEV_PROVIDER`) | ignored: no header, no flag | the workers' boot line names the condition |
| Switch on, a key without the flag | the proxy strips the opt-out; the call is redacted | the generation shows `redacted-by-litellm`; rotate the key |
| The workers' half on, the collector's off (or the reverse) | no text | — |
| Switch on, an evidence PDF or image | no opt-out, redacted, and deleted by name | no text on `evidence.grade.bytes` |
| A streamed call fails after it started, the router rejects a call, or the proxy's gate refuses one | LiteLLM logs it unredacted (§ 9.2). The collector deletes its input and output and its exception event. Tempo receives no gateway span. | the generation at level ERROR, with no text, in every environment |
| A failed span carrying a 32 MB evidence body | the collector's receiver may refuse it for its size; either way nothing leaves | the gateway's log |
| A trace read in the interceptor fails or finds nothing | the workflow's derived trace; one warning line | the activity's spans in a trace of their own |
| A call refused before the gateway (no key, no `GATEWAY_URL`, an individual account while spec 11 D5's caps are unset) | the product's span with its outcome; no generation | the span alone |
| The gateway refuses (the budget) | the product's span with outcome `budget`; the gateway may write an `ERROR` generation with the request's messages, whose text the collector deletes (§ 9.2) | the span, and the generation at level ERROR with no text |
| Langfuse refuses a large span (text on, a long prompt) | the batch is refused | the collector's log |
| The month's units are spent | Langfuse refuses or bills | Andre's account |
| A reader deletes a conversation while the switch is on | Langfuse keeps the text (§ 10) | test accounts only |
| A later LiteLLM image, or a new span builder, adds an attribute | It does not leave: the keep-lists. A new product key fails `lib/telemetry/langfuse.test.ts` until it is listed or excluded. | — |

## 16. Verification (in addition to rules § 7)

What is Andre's in every unit:

- writing `infra/observability/.env` and the switch's lines;
- rotating his test accounts' keys;
- any paid call, given to him as a command with its estimate;
- looking at Langfuse.

The builder may restart the workers, the collector and the gateway, as unit 64 did. It does so only after checking that no real research run is mid-call, and it stops the orphaned node process on 4002 when it stops the workers' task (memory). It never runs the commands § 4 forbids.

**Every live search check below** runs signed in to an organisation test account, or signed out with `GATEWAY_ANONYMOUS_PRINCIPAL` set. An individual account gets no key while spec 11 D5's caps are unset (`workers/keys.ts:95-96`, `GATEWAY_INDIVIDUAL_CAP_UNSET`), so its embedding is refused before the gateway.

**Unit 79 — the collector's road, and the gateway's Langfuse variables closed.**

1. `tests/observability.test.ts` (§ 9.5). For the gateway, the transform is inert until unit 80.
2. `tests/observability-collector.test.ts` (§ 9.5), run by the builder with `HB_COLLECTOR_TEST=1`.
3. `lib/telemetry/spans.test.ts`: a span recorded inside a request scope carries `hb.parent: request`. A span with an explicit parent, or recorded outside a scope, does not.
4. `lib/telemetry/langfuse.test.ts`: every key of today's builders is listed or excluded.
5. The image's own check exits 0, with and without the variables: `docker run --rm -v <config>:/c.yaml otel/opentelemetry-collector-contrib@<pinned digest> validate --config /c.yaml`. It also confirms the auth extension's and the exporter's names.
6. **Andre:** deletes every line containing `LANGFUSE` from his `infra/gateway/.env`, the `UPSTREAM_LANGFUSE_*` ones included. Then the builder recreates the gateway with compose's blanks, after the mid-call check. The presence check of § 4 prints "no Langfuse variable", and `/health/liveliness` answers 200.
7. With `infra/observability/.env` absent: `docker compose --profile observe up -d grafana otel-collector`, then a stub turn. The project `.env` does not name `OTEL_EXPORTER_OTLP_ENDPOINT` until step 9, so for this check the builder starts the workers with it on their command line (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run workers`; the file's values never override a variable already set). Tempo shows the turn's trace, and the collector's log shows no export to Langfuse.
8. **Andre:** creates the project and its keys (D4's region) and writes `infra/observability/.env` from its example. The builder recreates the collector.
9. **Andre:** adds `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to the project `.env`, and the builder restarts the workers. A search query, which is free because the embedder is self-hosted, shows its trace in Langfuse:
   - its root is `gen_ai.embeddings`;
   - the environment is `development`;
   - there is no `http.request` anywhere;
   - there is no `hb.principal` in the metadata.

**Unit 80 — the gateway's generations.**

1. `tests/gateway-config.test.ts`'s new cases (§ 9.5).
2. The client's, `embed`'s and `rerank`'s tests: the `traceparent`'s span id is the model-call span's id.
3. A test that `scripts/gateway-check.ts` and `scripts/research-check.ts` call `startTelemetry("hb-jobs")` and `stopTelemetry()`.
4. The builder recreates the gateway with its new environment. `/health/liveliness` answers 200, and its start logs no callback error.
5. A search query: Langfuse shows the root `gen_ai.embeddings` with a generation named `litellm_request` beneath it. The name and the `embedding` type come with unit 81's header.
6. **Andre:** `npm run gateway:check` with the organisation principal of `GATEWAY_CHECK_PRINCIPAL`: one `hb-small` call, well under US$ 0.01. Langfuse shows the root `gen_ai.chat` with a generation `litellm_request` beneath it. The generation shows:
   - the model;
   - tokens equal to the usage block the command prints;
   - a cost;
   - no input or output;
   - no key, user, team or metadata attribute;
   - the environment `development`.

**Unit 81 — each call named for its agent.**

1. Type check: every `GatewayCall` names an `agent`.
2. The client's tests: the two headers, and `promptSha256` unchanged.
3. The lines' tests: `hb.agent` on the model-call span, and the key on `PRODUCT_LANGFUSE_KEYS`.
4. A search query: Langfuse shows `embed.query` (span) → `embed.query` (embedding).
5. **Andre:** one real question at `/en/assistant`, signed in to an organisation test account. A turn costs a few cents. Every model call is a span named for its agent, with its generation nested under it, and the generations carry `langfuse.version`. Until unit 83, the turn's spans are roots side by side.

**Unit 82 — the text switch.**

1. The tests of § 9.5.
2. `npm run gateway:key -- --flagged`. It lists the principals whose key carries the flag. For each `GatewayKey` row it asks the gateway's `/key/info` under the master key. It prints ids, never a key. The builder runs it before the switch and finds none. The route and its parameter are checked against the pinned image in this unit.
3. **Andre:** in the project `.env`, sets `LANGFUSE_MESSAGE_TEXT=on` and `NODE_ENV=development`, keeping `APP_URL` and `AUTH_DEV_PROVIDER` as `.env.example` writes them. In `infra/observability/.env`, sets `LANGFUSE_MESSAGE_TEXT=on`. The builder restarts the workers and recreates the collector. The workers' boot line says the switch is on, or names the condition that failed.
4. **Andre:** rotates each organisation test key once (`npm run gateway:key -- --org <id>`). The builder lists those keys from the `GatewayKey` rows. Individual accounts have no key while spec 11 D5's caps are unset, so there is no `--user` rotation. `--flagged` then lists them.
5. **Andre:** `npm run gateway:check` shows its prompt and answer in Langfuse. This look also settles what § 9.3 marks unverified: `system`, and the output's shape. He then sets both halves back to `off`, and after the same restarts, the next run shows neither.
6. Builder, no model call:
   - under `NODE_ENV=production` with `on`, `npm run workers` refuses to start, naming the variable;
   - with `NODE_ENV` unset and `on`, the boot line says the setting is ignored and why.

**Unit 83 — the turn as one tree.**

1. Unit tests:
   - `inSpan` records once with its id, on success and on a throw;
   - the turn's span is the parent of retrieval, the calls, the aid's run and the sensors;
   - the scope's trace attributes are on every span recorded inside it, and the outcome only on `assistant.answer`;
   - `onSensor` is called once per sensor of each pass;
   - no `sensor` line or span carries a detail;
   - a `FAIL` or `WARN` sensor span carries level `WARNING`;
   - `LINE_KINDS` equals the collector's list;
   - no file outside `lib/telemetry/langfuse.ts` names `langfuse.`.
2. A stub turn through the workers: Tempo's tree as § 13 shows it, without the gateway's generations.
3. **Andre:** one real question. Langfuse shows the tree of § 13, with its tags, release and outcome, and `assistant.answer` as its root.

**Unit 84 — the workflows' activities.**

1. The interceptor's tests, on a fake context:
   - an `activity` line and a span per execution, with the workflow's type, id, attempt and outcome, and no error message;
   - `LINE_KINDS` still equals the collector's list;
   - an activity's throw rethrown unchanged;
   - a failing lookup gives the derived trace;
   - a legacy research run sets no trace attribute.
2. The resolution's tests, for each row of § 7.2.
3. The doors' tests for `suggestionOfEvidenceItem`, `researchTraceOf` and `researchTraceOfFinding`, against the database.
4. `tests/integration/workflows.test.ts` passes unchanged.
5. A research run on an individual test account. It has no key, so it ends "not run" and costs nothing. Its trace in Langfuse is the start request's, named `research.run`. It holds `activity.loadRun`, `activity.planRun` and `activity.concludeRun` with their outcomes, as roots. This is the first look at a trace with several roots (§ 18).

**Unit 85 — the suggestion's one trace and the workflows' sensors.**

1. Unit tests:
   - the grading call and the adjudicator's call carry `suggestionTraceId(id)`;
   - `Adjudication.traceId` and the `GRADED` and `DECIDED` payloads still carry the attempt's;
   - the sensor spans of intake, consistency, the brief, the validation and the report.
2. The worked examples' suite and the suggestion workflow's suites pass unchanged.
3. **Andre:** one suggestion with one evidence link, from a contributor test account, submitted on the development engine. It makes the grader's `hb-small` calls and one `hb-frontier` adjudication, some cents. Langfuse shows one `suggestion` trace holding the grade and the attempt, found by `metadata.suggestion_id`.

**Unit 86 — the dashboards and the readiness list.**

1. `infra/observability/README.md`'s Langfuse section:
   - start and stop;
   - the five collector variables and where they live, and the workers' half;
   - the switch, its gate and its locks;
   - what never reaches Langfuse;
   - how to find a suggestion's trace;
   - the dashboard's widgets;
   - the pin checklist (§ 18);
   - the move.
2. The tracker's "before real readers" list (§ 10).
3. **Andre:** builds the dashboard of § 13 in Langfuse and reads one trace of each kind.

## 17. Documents this amends

- **architecture.md:**
  - § 1, the Observability row: Langfuse Cloud in development by L1; self-hosted in region before real data.
  - § 2.1, the Observability container: the collector exports to Langfuse; the gateway exports to the collector; Tempo receives no gateway span.
  - § 2.2, three conduits:
    - product → collector: HTTP 4318, loopback or internal;
    - gateway → collector: HTTP 4318, internal, no auth;
    - collector → Langfuse: HTTPS 443, Basic auth; Langfuse Cloud in development and only labelled `development`, self-hosted in region in production.
  - § 5.7: a row for the Langfuse keys (`infra/observability/.env`, the collector alone, blanked in the gateway, never model-visible).
  - § 7: the Model call row (the agent; no message text except in development behind `LANGFUSE_MESSAGE_TEXT` and its gate, and never for a failed call). The Adjudication row's "Langfuse trace link" is the suggestion's trace. Two new rows: Workflow activity and Sensor.
  - § 11, invariant 29 gains: "Since 2026-10-14 (feature-specs/49, Andre's L1), development telemetry of test accounts may go to Langfuse Cloud until the self-hosted Langfuse exists; production never." **Reported under rules § 1.5: an invariant changes by Andre's answer.** (unit 79)
- **code-standards.md**, Workers, workflows and agents:
  - every model call names its agent;
  - `langfuse.*` attributes are written only by `lib/telemetry/langfuse.ts`;
  - a new span attribute joins `PRODUCT_LANGFUSE_KEYS` or its exclusions in the same change;
  - nothing sets a user, session or principal attribute for Langfuse;
  - the text opt-out header is named only by `lib/gateway/messageText.ts`. (units 79, 81, 82, 83)
- **Spec 11:**
  - § 3.5: the callback is `langfuse_otel`, to the collector, with the Langfuse variables blanked in the gateway.
  - § 8: the `LANGFUSE_*` row moves to the collector, and `LANGFUSE_MESSAGE_TEXT` is added in its two halves. `OTEL_EXPORTER=otlp_http` and `OTEL_ENDPOINT` are required wherever `litellm.yaml` is deployed. (units 79, 80, 82)
- **Spec 21:**
  - § 5.1: the span names beyond the table (`sensor.*`, `activity.*`, `search.query`); spans opened as scopes, carrying their subject's trace attributes; `GatewaySpan.span_id`; `hb.parent: request`; the checks start telemetry.
  - § 5.2: "Langfuse stays LiteLLM's callback … not a service here" becomes: Langfuse is reached through the collector's second pipeline, and it is still not a compose service. The Tempo pipeline drops the gateway's spans. (units 79, 80, 83)
- **Spec 33** § 12: the attempt's trace id is its records'; its calls carry the suggestion's trace. (unit 85)
- **Spec 45:** D6 (the development reversal, § 9.4) and § 29 (the three corrections). (unit 82)
- **Spec 48** § 5.8: the research lines nest under their activities' spans. (unit 84)
- **`infra/gateway/litellm.yaml`**, its comment on `turn_off_message_logging`: what it redacts and what it does not (§ 9.2). (unit 80)
- **`infra/observability/README.md`**, the project `.env.example` (`LANGFUSE_MESSAGE_TEXT`, and a comment that `NODE_ENV=development` goes beside it), `infra/observability/.env.example` (new, five names), and `infra/gateway/.env.example` (the `LANGFUSE_*` lines go, with a line saying where they live now). (units 79, 80, 82, 86)
- **progress-tracker.md:**
  - each unit;
  - the risk "Base64 to Langfuse through the gateway", closed by § 9.3;
  - the "before real readers" list. (every unit)

## 18. Risks and limits

- **Read in the image, not yet seen.** These were read in the image's source, not run, and unit 80 or 82 is the first to see each:
  - the attribute names for tokens and cost on `/v1/messages` (`llm.token_count.*`, `llm.cost.total`);
  - the per-request opt-out with the key's flag;
  - the shape of the logged output;
  - whether `system` stays out of `messages`.

  If tokens or cost are missing, Andre can add the model's price in Langfuse's model settings, or the collector can map the key. If the generation cannot be made usable, the unit stops and asks Andre (§ 5.2).
- **The failure path's ordering is the image's.** A new image could run the failure handlers in another order, or redact in both. The collector's unconditional deletion does not depend on either.
- **A new image pin** must re-check four things the tests cannot run. They join the pin's checklist in `infra/observability/README.md`:
  - the `traceparent` read;
  - the opt-out's key flag;
  - the logger's behaviour with blank keys and the exporter it then builds;
  - which failure handler runs first, and whether the logger now reads `LITELLM_LOGGING_NO_UPSTREAM_LLM_CALL`.
- **The collector's statements** are checked by its `validate` command, by a test that reads the file, and by a test that runs the pinned image over fixtures. The fixtures are written from the image's source, not recorded from a live gateway. Andre's look is the live check.
- **Several roots in one trace.** A research run's and a suggestion's activities are each a root, and Langfuse's page asks only that a root be sent. How it draws several roots, and which one gives the trace its environment, is unverified until unit 84. The collector sets the environment on every span, so the second question should not matter.
- **Re-parenting in the collector.** Clearing a span's parent with an OTTL statement is checked by the fixture test, not against Langfuse.
- **Langfuse Cloud is outside Brazil.** Development only, by L1. It holds test accounts' ids and, with the switch, their words, until the project is deleted (§ 10).
- **A suggestion's trace is old.** Its latency column is the suggestion's age, and it is listed on the day it began.
- **Large prompts.** With text on, Langfuse may refuse a batch of long prompts. The collector logs it; development only.
- **The queue is in memory.** A collector restart loses what was waiting.

## 19. Out of scope

- Self-hosting Langfuse (§ 14).
- Langfuse's scores, evaluations, LLM-as-judge, datasets, prompt management, annotation queues and user feedback.
- Alerts from Langfuse (Grafana's stay as spec 21 set them).
- The web tier's requests in Langfuse.
- Sampling.
- Deleting from Langfuse on a reader's delete.
- Cost per account in Langfuse (`BudgetLedger`'s).
- A failed call's prompt in Langfuse, even in development (§ 9.2).
- The IDE.

## 20. Decisions this spec needs

All four answered by Andre on 2026-10-14: D1 A (no person or session leaves; record ids only), D2 A (the flag only on keys minted while the development gate is on), D3 A (the embedding job stays in Tempo), D4 **US**, so the development project is at `us.cloud.langfuse.com` and the OTLP endpoint is `https://us.cloud.langfuse.com/api/public/otel`. Wherever this spec writes the EU endpoint as an example, read the US one.

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | People and sessions in Langfuse — **Andre, 2026-10-14: A** | **A** none: no user, principal, organisation, session or conversation id; record ids only (§ 6.5). **B** the conversation as Langfuse's session and the principal as its user, in development only. | **A.** Invariant 26 forbids a screen that counts messages per session or ranks people, and Langfuse's Sessions and Users pages are both. Cost per account is `BudgetLedger`'s. |
| D2 | Which keys carry the gateway's opt-out flag — **Andre, 2026-10-14: A** | **A** only keys minted while the development gate is on (§ 9.1); a check lists them, and they are rotated before real readers. **B** every key minted where the development check holds, whether the switch is on or off. **C** A, and the workers also clear the flag through the gateway's `/key/update` at boot whenever the switch is off. | **A.** It costs one rotation of the organisation test keys each time the switch goes from off to on. B leaves flagged keys behind on any machine that passes the check. C adds a management call at every boot for a state the readiness list already clears. |
| D3 | The release's embedding job in Langfuse — **Andre, 2026-10-14: A** | **A** dropped on the Langfuse road. **B** kept. | **A.** It is a batch job, not an agent, and costs nothing (self-hosted). One re-index is about a thousand units, out of Hobby's 50,000 a month, and it shows the book, which is in the repository. |
| D4 | The Langfuse Cloud region of the development project — **Andre, 2026-10-14: B, US (`us.cloud.langfuse.com`)** | **A** EU (`cloud.langfuse.com`). **B** US (`us.cloud.langfuse.com`). **C** another region (Japan). | **A**, unless his account already holds the project elsewhere. Every region is outside Brazil (L1 accepts that). Export is asynchronous, so distance costs nothing. EU is Langfuse's home region, under the GDPR, the regime nearest LGPD. If he already made the project in another region, that region's endpoint is the one to write, and nothing else changes. |

L1 settles the invariant 29 exception, L2 the switch's existence and L3 the suggestion's one trace. None of them is a decision here.

Five questions the first draft asked are now decided by the spec, each where it arises:

- **The callback** is `langfuse_otel`, by Andre's standing rule (§ 5.2).
- **The opt-out** is per request, behind a development gate, with the yaml left as it is (§ 9.2). A second, development-only yaml would be a file that can be mounted anywhere. The per-request opt-out has a unit test for each lock, and the collector's lock is run against the pinned image.
- **The evidence bytes row never carries text** (§ 9.3).
- **A failed call never carries text** (§ 9.2).
- **Tempo receives no gateway span** (§ 5.5).

## 21. Units

Each unit leaves the app working. The `observe` profile is off by default, and every addition is inert until a collector, a key or the switch is there.

| Unit | What | Touches | Andre |
|---|---|---|---|
| **79** | The collector's road to Langfuse: both pipelines' processors (the Tempo filter, the Langfuse filter, the resource, app and gateway shapes, events dropped, the environment), `basicauth/langfuse`, `otlp_http/langfuse`; `hb.parent: request` on request scopes' children; `PRODUCT_LANGFUSE_KEYS`; `infra/observability/.env.example`; compose: the collector's `env_file` and networks, and the gateway's blank `LANGFUSE_*`; `infra/gateway/.env.example` without `LANGFUSE_*`; the docker-gated collector test; the README's section; architecture § 1, § 2, § 5.7 and invariant 29 | `infra/observability/`, `infra/gateway/.env.example`, `docker-compose.yml`, `lib/telemetry/spans.ts`, `lib/telemetry/langfuse.ts`, `lib/api/handler.ts`, `workers/server.ts`, `tests/observability*.test.ts`, `lib/telemetry/*.test.ts`, context | deletes the gateway's Langfuse lines; creates the project and keys; writes `infra/observability/.env`; looks |
| **80** | The gateway's generations: `callbacks: ["langfuse_otel"]`, the yaml's corrected comment, the gateway's three `OTEL_*` variables; the model-call span's id shared with `traceparent`; the two checks start telemetry; spec 11 § 3.5 and § 8 | `infra/gateway/litellm.yaml`, `docker-compose.yml`, `lib/gateway/`, `lib/telemetry/lines.ts`, `scripts/gateway-check.ts`, `scripts/research-check.ts`, `tests/gateway-config.test.ts`, tests | `npm run gateway:check`; looks |
| **81** | Each call named for its agent: `AgentNameSchema` and `GatewayCall.agent`, every call site, the two headers, `hb.agent` on its span | `lib/schemas/gateway.ts`, `lib/gateway/`, `lib/telemetry/lines.ts`, `lib/telemetry/langfuse.ts`, the workers' call sites | one real question; looks |
| **82** | The development text switch: `LANGFUSE_MESSAGE_TEXT` and `messageTextGate` in `lib/env.ts` (refused in production, gated in development), `lib/gateway/messageText.ts`, the keys' flag under the gate, `gateway:key -- --flagged`, the boot lines; spec 45 D6 and § 29, architecture § 7 | `lib/env.ts`, `lib/gateway/`, `workers/keys.ts`, `scripts/gateway-key.ts`, `workers/main.ts`, `.env.example`, tests, context | sets both halves; rotates the organisation test keys; turns it on and off; looks |
| **83** | The turn as one tree: `inSpan` with trace attributes, the turn's and retrieval's scopes, the `sensor` and `search` line kinds and the answer flow's sensors, `langfuseAttributesOf` (types, levels, trace attributes), `search.query`; spec 21 § 5.1 | `lib/telemetry/`, `workers/answer/`, `workers/server.ts`, `infra/observability/otel-collector.yaml` (the kinds and keys), tests | one real question; looks |
| **84** | The workflows' activities: the interceptor, its `activity` line kind, the trace's resolution, the three door functions, the registration in `workers/temporal.ts`; spec 48 § 5.8 | `workers/telemetry/`, `lib/telemetry/subjects.ts`, `lib/telemetry/print.ts`, `lib/db/improve.ts`, `lib/db/research.ts`, `workers/temporal.ts`, `infra/observability/otel-collector.yaml` (the kinds and keys), tests | looks at a free "not run" research |
| **85** | The suggestion's one trace and the workflows' sensors: the grading and adjudication calls on `suggestionTraceId`; the intake, consistency, brief, validation and report sensor spans; spec 33 § 12 | `workers/activities/evidence.ts`, `workers/activities/suggestion.ts`, `workers/research/run/`, tests, context | one suggestion on the development engine; looks |
| **86** | The dashboards and the readiness list: the README's last section, the tracker's "before real readers" list, an end-to-end look at one trace of each kind | `infra/observability/README.md`, the tracker | builds the dashboard in Langfuse |

**Order.**

- **Units 79 and 80 open the road.** Unit 79 opens it with every lock of the collector in place before any key is written. Unit 80 adds the gateway, with each generation already nested under a span that is sent.
- **Unit 81 names the calls.**
- **Unit 82 is the switch.** It comes after the road it guards, and before anything adds more to that road.
- **Units 83 to 85 add the product's own steps.**
- **Unit 86 closes.**

Each unit is reviewed once, read-only, in one pass, and its defects are fixed in its commit (Andre's lean shape).

## 22. Checked against the code before it was written (2026-10-14)

Two read-only reviews read the draft against the repository, the pinned gateway image and Langfuse's documentation. One read for privacy (12 findings); the other read for integration (11 findings). Every finding was checked at its source before it was acted on. Where both reviews found the same thing, they are answered together.

**Fixed.**

- **A failed call reaches the logger unredacted** (privacy F1). Confirmed in the image, and wider than the finding: the router's rejections and the proxy's gate refusals take the same path. That includes the budget refusal, because the `opentelemetry.py` logger does not read the marker that the newer `integrations/otel/` uses to skip it. The finding was wrong on one detail: the repair is not streamed (`run.ts:229-233`). Calls that were not streamed and failed are redacted, because the synchronous handler runs first there (`utils.py:2076-2083`). The fix:
  - the collector deletes the text of every `ERROR` gateway span and of the bytes row, unconditionally;
  - § 9.2 and § 9.3 now say which locks hold where;
  - § 15 gained the row;
  - spec 45 § 29 gets a third correction;
  - the docker-gated test carries a raw failed span (§ 5.5, § 9.2, § 9.4).
- **Langfuse keys in the gateway's environment** (privacy F2, integration F3). Confirmed: `langfuse_otel.py:276-287` and `:331-332`; compose's `env_file`; today's example. The fix:
  - compose blanks the four variables in unit 79;
  - Andre deletes the lines from his file;
  - the builder's presence check prints no value;
  - a gateway-config test asserts the blanks (§ 4, § 5.2).
- **`NODE_ENV` defaults to development** (privacy F3). Confirmed: `lib/env.ts:13`, the workers' Dockerfile and compose. The fix:
  - `on` takes effect only behind a positive check: a raw `NODE_ENV=development`, a loopback `APP_URL` and `AUTH_DEV_PROVIDER=1`;
  - the keys' flag is minted only under it;
  - the collector's half lives in `infra/observability/.env`, a separate act;
  - each condition is tested (§ 9.1, D2).
- **The readiness list did not stop the export to Cloud** (privacy F4). The fix:
  - a step to empty or move the endpoint;
  - the collector drops everything for a Cloud endpoint unless the environment is `development`, and everything when no environment is named;
  - the label moved out of compose into `infra/observability/.env` (§ 5.5, § 10).
- **Flagged keys outlive the switch** (privacy F5). The fix:
  - the flag is minted only under the gate;
  - `gateway:key -- --flagged` lists the keys that carry it;
  - the readiness list rotates until it is empty (§ 9.2, § 10, D2).
- **The console fallback** (privacy F6). Confirmed: `opentelemetry.py:338` and `:3054-3059`. The fix:
  - both variables are required by spec 11 § 8 and the README's checklist;
  - a test asserts them on every gateway definition;
  - `OTEL_EXPORTER` set alone fails closed (§ 5.2).
- **The collector's off-state was never executed** (privacy F7). The fix is `tests/observability-collector.test.ts`, which runs the pinned image over fixtures in five configurations. The gateway's list is a `keep_matching_keys` pattern, since `keep_keys` takes exact names (§ 9.5).
- **`redact_user_api_key_info` does nothing on this road** (privacy F8, integration F5). Confirmed: only four modules read it. The setting is not added, and § 5.2 and § 6.5 say the keep-list alone keeps identity out.
- **The product's spans passed a deny-list** (privacy F9). The fix:
  - an allow-list, `PRODUCT_LANGFUSE_KEYS`;
  - a test that every builder's keys are listed or excluded;
  - a test that the collector's list equals the module's (§ 5.5, § 9.5).
- **Hobby and Core keep data indefinitely** (privacy F10). Confirmed on Langfuse's data-retention page. The fix:
  - § 10 says so;
  - deleting the project is a required readiness step;
  - § 14 notes that a self-hosted Langfuse keeps data indefinitely too, so the move must choose a mechanism.
- **Span events leave through a keep-list** (privacy F11, integration F6). Confirmed: `opentelemetry.py:2181-2199`. The fix:
  - every span event is dropped on the Langfuse road;
  - the gateway's resource is cut to `service.name`, which removes `deployment.environment: production` and `model_id`;
  - § 5.5 now says what the processors cannot remove.
- **Commands that print a container's environment** (privacy F12). Added to § 4's list.
- **The gateway's raw span would reach Tempo** (integration F1). Confirmed: today's Tempo pipeline has no filter. The fix:
  - `filter/tempo` drops every `hb-gateway` span;
  - Tempo stays as spec 21 defined it;
  - the docker-gated test asserts it (§ 5.5).
- **Langfuse needs a root span** (integration F2). Confirmed on Langfuse's OpenTelemetry page, and confirmed that only four entry points start telemetry. The fix:
  - request scopes mark their children `hb.parent: request`, and the collector makes them roots;
  - the two checks start telemetry;
  - the span-id sharing moves from unit 81 to unit 80, so no generation hangs from an unsent parent;
  - § 18's unverified claim about orphans is gone (§ 5.6).
- **Trace attributes on every span** (integration F4). Confirmed on Langfuse's page. The fix:
  - name, tags, release and record ids are carried in the scope and set on every product span;
  - the outcome goes on the subject's span;
  - generations carry none, and § 6.4 states that limit and why § 13's widgets do not need them.
- **Unit order and principals** (integration F7). The fix:
  - unit 80 expects a generation named `litellm_request`, and the name and the `embedding` type come in unit 81;
  - every search check runs on an organisation account, or signed out with `GATEWAY_ANONYMOUS_PRINCIPAL`;
  - rotation lists organisation keys only (§ 16).
- **`otlphttp` is deprecated** (integration F8). The exporter is `otlp_http/langfuse`, and `validate` checks the auth extension's name.
- **What the output holds** (integration F9). § 9.3 describes the first choice's role and content, or its tool calls, and marks the thinking and web-tool claims unverified until unit 82.
- **Sensor level** (integration F10). `langfuseAttributesOf` sets `WARNING` for `FAIL` and `WARN`, and a test checks it (§ 8).
- **The legacy research workflow's trace name** (integration F11). Its spans set no trace attribute (§ 6.4, § 7.2).

**Rejected, with the reason.**

- **`ENV NODE_ENV=production` in `infra/workers/Dockerfile`** (part of privacy F3). `lib/env.ts:109-127` would then require `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_SECRET`, `OPA_URL` and `OBJECT_STORE_SECRET` in a container whose compose service sets none of them, so `docker compose up workers` would stop booting. The gate reads `NODE_ENV` as the process received it, so the image, which sets none, is off already.
- **Refusing to boot when `on` fails the development check** (part of privacy F3, which asked for a positive assertion and did not say refuse). A test process or a scheduled job reading the same `.env` would stop booting. The spec ignores the setting instead, which fails closed, and prints why. Production still refuses `on` outright.
- **Having the gateway refuse to start without `OTEL_ENDPOINT`** (part of privacy F6). The gateway is the vendor's image, run by its own entry point. The repository has no deployment definition besides compose, which is tested. A wrapper command would be a new moving part protecting an unbuilt deployment. Spec 11 § 8 and the README's checklist carry the requirement, and `OTEL_EXPORTER` set alone already fails closed.
- **Clearing the parent of named spans only** (one of integration F2's two options). The `hb.parent: request` mark covers every subject with one rule, including spans before unit 83 and spans a later unit adds. A list of names would need a change for each.

## 23. As built (unit 79: the collector's road to Langfuse, 2026-10-14)

Built as § 4, § 5.5, § 5.6, § 9.5, § 16's unit 79 rows and § 21's unit 79 row say, but for the points below. Nothing in the unit sends anything anywhere: no key exists, the `observe` profile stays off by default, and the collector drops every span on the Langfuse road until `infra/observability/.env` names an endpoint and an environment.

- **The collector** (`infra/observability/otel-collector.yaml`). The Tempo pipeline is `[filter/tempo, batch]`; `traces/langfuse` shares the `otlp` receiver and runs `filter/langfuse`, `transform/langfuse-resource`, `transform/langfuse-app`, `transform/langfuse-gateway`, `transform/langfuse-all` and `batch` into `otlp_http/langfuse`, authenticated by `basicauth/langfuse` (the pinned image's name, checked with its `components` and `validate`) and carrying `x-langfuse-ingestion-version: 4`. The statements are § 5.5's outline in the image's current path syntax (`span.*`, `resource.*`, context inferred, a group's `conditions` for the product's and the gateway's halves), the product's keep-list a folded `keep_keys` of exactly `PRODUCT_LANGFUSE_KEYS`, the gateway's one anchored `keep_matching_keys`. The `hb.agent` rename and the two `embed.release` conditions are in already, inert until unit 81, so the fixture suite proves them now.
- **The product** (`lib/telemetry/spans.ts`, `lib/telemetry/langfuse.ts`, `lib/api/handler.ts`, `workers/server.ts`). `withSpanScope` takes `request: true`; the handler pipeline and both scopes of the workers' server pass it; `recordSpan` marks `hb.parent: request` on a span whose parent it inherits from such a scope, never on one whose line names its parent or one outside a scope. `PRODUCT_LANGFUSE_KEYS` holds 46 keys, `PRODUCT_LANGFUSE_EXCLUDED` the exclusions of § 5.5 and one more (below).
- **Compose and the examples.** The gateway's `environment` blanks `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` and `LANGFUSE_OTEL_HOST`, and since the review the upstream client's three (below); the collector gains `env_file` `./infra/observability/.env` (optional) and `networks: [default, hb-internal]`, and sets no `LANGFUSE_*` itself. `infra/observability/.env.example` names the five variables with no value, the US endpoint written in its comment (D4); `infra/gateway/.env.example` has no `LANGFUSE_*` line and says where they live now. The project `.env.example` already documented `OTEL_EXPORTER_OTLP_ENDPOINT` (spec 21), so it is unchanged.
- **Documents.** Architecture § 1, § 2.1, § 2.2 (three conduits), § 3.1, § 5.7 and invariant 29 (**reported under rules § 1.5: an invariant changes by Andre's L1**), and § 12; code-standards' Workers rule on the allow-list; spec 11 § 3.5 and § 8; spec 21 § 5.1 and § 5.2; `infra/observability/README.md`'s Langfuse section, which unit 86 completes.

Decided here, for the review:

- **`traces_endpoint`, not `endpoint`.** Run in the pinned image, an `otlp_http` exporter whose `endpoint` is set and empty, as a copied example leaves `LANGFUSE_OTLP_ENDPOINT=`, refuses to start ("at least one endpoint must be specified"), and the collector with it, Tempo's and Loki's pipelines included. So the exporter names `traces_endpoint: ${env:LANGFUSE_OTLP_ENDPOINT:-http://127.0.0.1:9}/v1/traces`, which is what `endpoint` would have composed; set and empty it reads `/v1/traces`, which is never dialled, since the filter has dropped everything. The example asks for the endpoint without a trailing slash. The variable's default applies only when it is unset, which is why the filter tests the expanded text for `""` rather than relying on the default.
- **The job's counts are excluded, its name listed.** `jobSpanOf` emits `hb.count.<name>`, a key per count that no fixed `keep_keys` can hold, so `hb.count.` joins the exclusions; `hb.job`, `hb.policy` (the request's decision) and `hb.secret.detected` (the guard's flag, added by `recordSpan`) are on the list, being enumerations no exclusion names, though the job's and the request's spans never take the road.
- **`$$`** ends the gateway's pattern: the collector's configuration expands `$`, and `$$` is its escape.
- **The suite's second configuration.** `tests/observability-collector.test.ts` passes the committed file and a second `--config` that replaces the receivers (`otlp_json_file`, with `include_file_name: false`), the exporters (`file`, one per pipeline, and one for the logs pipeline, whose file receiver needs the storage extension) and `service.extensions` (`basicauth/langfuse` alone). The collector merges maps and replaces lists, so the processors and each pipeline's processor list are the committed ones by construction, not by copy. Five containers run in parallel, each stopped once Tempo's file holds every product span; the stop drains the Langfuse pipeline before the files are read.
- **The fixtures** (`tests/fixtures/collector.ts`). The product's spans are its builders' own, recorded through `recordSpan` in a request's scope, so the mark is the real one; one of them carries keys no builder emits today (a principal, a subject, a path, a question, an e-mail), as a later builder might. The gateway's eight spans are written from the pinned image's source with file and line beside each: a redacted success, a success with its text, a failed streamed call with its raw input, `error.*` and an `exception` event, the bytes row with a document, the grader's call, the question's embedding, the release's embedding, and a span of the proxy's own; each carries the image's identity and duplicate attributes (`metadata`, `user.id`, `session.id`, `litellm.key_alias`, `litellm.team_id`, `llm.invocation_parameters`, `input.value`, …) under a resource with `deployment.environment: production`, `model_id` and `telemetry.sdk.*`.
- **The blanks, run.** Besides the source, the pinned gateway image was run with `--network none`, no env file and the four variables set to `""`: the `langfuse` logger builds with its client disabled, and `langfuse_otel`'s configuration falls back to `from_env` (the console exporter, which unit 80's `OTEL_EXPORTER` and `OTEL_ENDPOINT` replace). The same run showed that importing LiteLLM fetches its remote cost map from `raw.githubusercontent.com` unless told not to, which `--network none` refused; that is the gateway's existing egress, outside this unit, and noted in the tracker.

Verified:

- the pinned collector's `validate` exits 0 over the committed file unset, with test values, and with every variable set and empty; it refused an injected OTTL error, so it parses the statements;
- `docker compose --env-file <a scratch file of dummy values> --profile observe config --quiet` exits 0 (nothing printed; the project `.env` was not used);
- type check, and lint with no warning on every touched TypeScript file;
- `tests/gateway-config.test.ts`, `lib/telemetry`, `tests/observability.test.ts`: 73 passed, the collector suite skipped without its variable; `lib/api/handler.test.ts`, `workers/server.test.ts` and `lib/gateway` pass unchanged;
- with `HB_COLLECTOR_TEST=1`, `tests/observability-collector.test.ts`: 14 passed in about 3 s before the review (15 after it, below), over the five configurations (the half off, the half on, the endpoint set and empty, the environment unset, a Cloud endpoint with `production`); with the failure condition taken out of the input's deletion for one run, the half-on case failed on `researcher.read`, and the line was put back; no test container is left;
- `npm run secrets:scan`: 241 files, none found.

Not run here, and owed (§ 16, unit 79, steps 6 to 9):

- **Andre** deletes every line containing `LANGFUSE` from his `infra/gateway/.env`; compose's blanks cover it meanwhile. **Run after the commit, 2026-10-14:** the gateway recreated on the blanks (`docker compose up -d --no-deps gateway`, after the mid-call check); the presence check printed "no Langfuse variable", and `/health/liveliness` answered 200.
- **Step 7, run after the commit, 2026-10-14,** with a search in place of a stub turn: a turn would go through the real gateway, a search's embedding is free. With no `infra/observability/.env`, the `observe` profile up and the workers restarted with `OTEL_EXPORTER_OTLP_ENDPOINT` on their command line, one search as a keyed organisation's reader through `/api/v1/search` (`vector: ok`, 141 ms). Tempo holds its trace, with the workers' `gen_ai.embeddings` marked `hb.parent: request`; the collector logged no export to Langfuse and no failed one. The search page reported its vector half `unavailable` while the route's ran: its loader missed `/embed/query`'s 150 ms in development mode, the page's timing and not this unit's.
- **Andre** creates the Langfuse project in the US region with its keys, writes `infra/observability/.env` from its example (`LANGFUSE_TRACING_ENVIRONMENT=development`, `LANGFUSE_MESSAGE_TEXT=off`), and the collector is recreated; then `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in the project `.env`, the workers restarted, and a search query looked at in Langfuse (step 9).

**The review (2026-10-14).** One reviewer, read-only, ran the collector suite and two probes of the pinned collector with `--network none`. One medium finding and four low; all five fixed in the same commit.

- **F1, medium: any OTLP sender was "the product".** The road told the gateway from everything else, so a program on this machine that is not the product's, sending to 4318 as an OpenTelemetry SDK does by default, kept its resource (host, user, command line), its span names and its status messages; only its span attributes were cut. A probe showed it. Fixed: a fourth condition of `filter/langfuse` drops any span whose `service.name` is not `hb-web`, `hb-workers`, `hb-jobs` or `hb-gateway` (an absent name included), and `transform/langfuse-resource` cuts every resource to its name, not only the gateway's. The fixture gains two foreign senders, one named and one not; Tempo keeps their spans, and the suite asserts that nothing of them reaches the Langfuse output, in the half off and the half on. The product's own status messages are its error codes (`lib/telemetry/lines.ts`), so nothing free-text is left on that field.
- **F2, low: the environment's condition was never proven alone.** The `no-environment` configuration used the Cloud endpoint, so the Cloud condition dropped everything anyway. It now uses a self-hosted endpoint, `https://langfuse.example.test/api/public/otel`; and `no-endpoint` sets the two keys to empty too, as a copied example does.
- **F3, low: the Cloud check was case-sensitive.** `US.cloud.langfuse.com` with `production` would have been sent. The pattern is now `(?i)cloud\.langfuse\.com`, and `cloud-production` writes its endpoint in mixed case.
- **F4, low: the `langfuse` callback's upstream client.** The pinned logger builds a second client whenever `UPSTREAM_LANGFUSE_SECRET_KEY` is set (`litellm/integrations/langfuse/langfuse.py:264-279`, read in the image). Compose blanks `UPSTREAM_LANGFUSE_PUBLIC_KEY`, `UPSTREAM_LANGFUSE_SECRET_KEY` and `UPSTREAM_LANGFUSE_HOST`; the empty public key disables that client. Andre's step says every line containing `LANGFUSE`, and the presence check reads all seven.
- **F5, low: documents.** Spec 11 § 8's row said the blanks meant `infra/gateway/.env` no longer held the keys; the blanks hide them from the container, and the file holds them until Andre deletes them. § 16 step 7 now says how the product's spans reach the collector before the project `.env` names it. The README's "never … a person" and "Cloud receives only `development`" hold now that F1 and F3 are fixed.

Verified after the fixes: with `HB_COLLECTOR_TEST=1`, the collector suite, `tests/observability.test.ts`, `tests/gateway-config.test.ts` and `lib/telemetry`: 88 passed. Each new guard was taken out for one run (the senders' condition, the environment's condition, the `(?i)`) and six tests failed, among them each guard's own; the file was put back. No test container is left.
