# The observability stack

Where the product's spans and lines go when someone wants to look at them (feature-specs/21 § 5.2; architecture § 7): an OpenTelemetry collector, Tempo for traces, Loki for lines, and Grafana over both and over the application database. It is **off by default**. Nothing here is needed to develop or to test: without `OTEL_EXPORTER_OTLP_ENDPOINT` the product exports nothing and its JSON lines on stdout are all there is.

## Start and stop

```
docker compose --profile observe up -d grafana otel-collector
```

Name the two services. Their dependencies come with them: Tempo, Loki, the database, and `observe-init`, which runs once and exits. A bare `docker compose --profile observe up` would also start every other service in the compose file.

```
docker compose --profile observe rm -sf grafana otel-collector tempo loki observe-init
```

Stop it this way, by name. `docker compose down` stops the whole project, the database included.

| What | Where |
|---|---|
| Grafana | http://localhost:3001, user `admin`, password `GRAFANA_ADMIN_PASSWORD` (default `admin`) |
| The collector, for spans | http://localhost:4318 (OTLP/HTTP) |
| Tempo, Loki | no published port; Grafana and the collector reach them by service name |

Both published ports are on the loopback interface alone.

## Sending it something

**Spans.** Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `.env` and restart the dev server and the workers; each says `telemetry: … export` when it starts. A scheduled job picks the variable up the same way. Every span is built from one of the product's own lines and keeps that line's trace id, so a `traceparent` from a response, a line in a log and a trace in Tempo are the same id.

**Lines.** The collector reads `*.log` under one directory, `HB_LOG_DIR`, and keeps only lines that are JSON with a `kind` the product prints (`span`, `model_call`, `job`, `policy`, `retrieve`, `aid_run`, `answer`); an npm banner, a sentence or a stack trace in the same file is dropped. The default directory is `var/log/hb` in this checkout (git-ignored). The scheduled jobs already append to a log each (`infra/schedules`): on a Linux host that directory is `/var/log/hb`; the Windows tasks write to `%LOCALAPPDATA%\harness-bible\logs`, so set `HB_LOG_DIR` to that path to see their lines. By hand:

```
npm run auth:sweep >> var/log/hb/sweep.log
```

A line has no time of its own: its time in Loki is when the collector read it. The collector therefore reads new lines only, and a line written while it was stopped is read when it starts again, under that later time.

In Grafana's Explore, the lines are `{service_name="hb-lines"}`, and a line's parsed fields filter directly: `{service_name="hb-lines"} | kind="job" | job="assistant:purge"`. A line's `traceId` links to its trace in Tempo.

## What Grafana may read from the database

The PostgreSQL source signs in as `hb_metrics`, a role `observe-init` creates from `init.sql` and whose password is `HB_METRICS_PASSWORD` (default `hb_metrics`, as the development database's own is `hb`). The role is granted **columns**, not tables: exactly the ones the statements of `lib/metrics/sql` read. It cannot select a message's text, a claim's text, a mode result, a verdict's detail, any account, session, key or ledger table, or the book; and it cannot write. Grafana runs whatever SQL an editor types, so the role is what keeps a reader's words out of a dashboard.

A new statement that reads another column adds that column to `init.sql` in the same change; `tests/observability.test.ts` fails until it does, and `tests/integration/observability.test.ts` runs every statement as the role.

## Nothing leaves the machine but what goes to Langfuse

Tempo's, Loki's and Grafana's usage reports and update checks are switched off (`tempo.yaml`, `loki.yaml`, the `GF_*` settings in `docker-compose.yml`). Traces and lines are kept in the containers and go when the containers are removed; how long telemetry itself is kept is not decided here. The one thing that may leave is what the collector sends to Langfuse, and only once `infra/observability/.env` names an endpoint and an environment (next section).

## Langfuse (feature-specs/49)

The collector is the one road to Langfuse: it alone holds the Langfuse keys, and the web tier, the workers and the gateway export to it and hold none. Compose blanks the gateway's own Langfuse variables, the `langfuse` callback's `UPSTREAM_LANGFUSE_*` included, so none of LiteLLM's Langfuse clients can open a second road whatever `infra/gateway/.env` holds. Unit 79 built the road; the gateway's generations (unit 80), the agents' names (81), the text switch's other half (82) and the product's own steps (83 to 85) come after it, and this section grows with them (unit 86).

**Where the variables live.** Copy `infra/observability/.env.example` to `infra/observability/.env` (git-ignored) and fill it yourself; nothing else reads it, and no Langfuse key is ever pasted anywhere else.

| Variable | What |
|---|---|
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | the project's keys, sent as HTTP Basic by the `basicauth/langfuse` extension |
| `LANGFUSE_OTLP_ENDPOINT` | the project's OTLP endpoint, without a trailing slash: `https://us.cloud.langfuse.com/api/public/otel` for the development project (the US region, D4) |
| `LANGFUSE_TRACING_ENVIRONMENT` | the environment label every span carries: `development` here |
| `LANGFUSE_MESSAGE_TEXT` | the collector's half of the development-only text switch, `on` or `off`; unset is `off` |

Then recreate the collector: `docker compose --profile observe up -d --force-recreate otel-collector`. With the endpoint or the environment empty, or the file absent, the collector drops every span on that road before its exporter, and Tempo and Loki work as before; to stop the export, empty `LANGFUSE_OTLP_ENDPOINT` and recreate. Langfuse Cloud (`*.cloud.langfuse.com`, in any case) receives only spans labelled `development`. Wrong keys show in the collector's log as a 401, with no key in it; a key's presence is never checked by printing an environment.

**What goes, and what never does** (`otel-collector.yaml`, `traces/langfuse`). Only the product's services (`hb-web`, `hb-workers`, `hb-jobs`) and the gateway may send on this road: another program on this machine that speaks OTLP to 4318 reaches Tempo and nothing else. Every resource is cut to its service's name. Then two allow-lists, not deny-lists: of the product's spans, exactly the attributes of `PRODUCT_LANGFUSE_KEYS` (`lib/telemetry/langfuse.ts`); of the gateway's, one anchored pattern (the observation's type and text, the guide's version, the model, tokens and usage). Never a request's span, a job's, the release's embedding job, a span event, a person, an account, a session or an address; never a failed call's text or the evidence grader's PDF or image row; text at all only with this half of the switch `on`. A span whose parent is a request's span becomes a root there, since that parent never goes; Tempo keeps it as it was. Tempo receives no gateway span.

**Checked** three ways: the image's own `validate` (`docker run --rm --network none -v <this folder>/otel-collector.yaml:/c.yaml <the pinned image> validate --config /c.yaml`), `tests/observability.test.ts` (the file as text), and `HB_COLLECTOR_TEST=1 npx vitest run tests/observability-collector.test.ts`, which runs this file in the pinned image with no network over recorded spans, in five configurations.

## The pins

Each of the four images is pinned by digest, with the version that digest was on 2026-10-04 written beside it: collector-contrib 0.161.0, Tempo 3.0.0, Loki 3.7.8, Grafana 13.2.3. A new pin is a reviewed change to `docker-compose.yml`; pull the new tag, read its digest with `docker image inspect <image> --format '{{index .RepoDigests 0}}'`, and run the checks below again. A new collector pin also runs its `validate` over `otel-collector.yaml` and the collector suite with `HB_COLLECTOR_TEST=1`.

## Checking it works

1. `docker compose --profile observe ps -a`: four services running, `observe-init` exited 0.
2. In Grafana, Connections → Data sources: PostgreSQL, Tempo and Loki each pass *Test*. That test only connects; the real check of PostgreSQL is the next step.
3. `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run auth:sweep >> var/log/hb/sweep.log`, then in Explore: the job's line under Loki, and its trace under Tempo by the line's `traceId`.
4. In Explore, PostgreSQL: paste a file of `lib/metrics/sql` with `$1::timestamp`, `$2::timestamp` and `$3::text` replaced by `$__timeFrom()::timestamp`, `$__timeTo()::timestamp` and `'month'::text`. The numbers are the ones `npm run assistant:metrics` prints for the same window.

5. Dashboards → Harness Bible → *Assistant citation and flag rate*: fourteen panels, none with an error badge.
6. Alerting → Alert rules → Harness Bible: five rules, each *Health ok*. With no purge line in two days, *no purge run in two days* is firing; `npm run assistant:purge >> var/log/hb/purge.log` clears it within about a minute.

## The dashboard

*Assistant citation and flag rate* (architecture § 7) is provisioned from `grafana/dashboards/assistant.json`. Four headline numbers for the range (citation rate, flag rate, refusal rate, first-token p95; the default range is the month to date), one panel by day for each series of `lib/metrics/sql`, and the retention job's own lines from Loki. Every SQL query is one of those files with Grafana's time macros in place of its three parameters, so the dashboard and `npm run assistant:metrics` cannot disagree. Hover a panel's (i) for the statement's own definition.

The file is **generated**. Do not edit it, here or in Grafana (the provider does not keep changes made in the editor):

```
npm run observe:generate            # after changing a statement or lib/metrics/dashboard.ts
npm run observe:generate -- --check # exits 1 when a file is stale; the test suite makes the same comparison
```

Grafana rereads the folder every ten seconds, so a regenerated file shows without a restart.

## The alerts

Five rules, provisioned from `grafana/provisioning/alerting/alerts.json`, generated by the same command. Four are warnings and one pages; each window is in its query and the group is evaluated every minute, Grafana's own default.

| Rule | Fires when | Source |
|---|---|---|
| first-token p95 above 2 s over the last hour | the 95th percentile of the last hour's first tokens is over 2,000 ms | `first-token-p95.sql` |
| a refusal cause above 20 % of turns over the last day | any one cause is more than a fifth of the day's turns | `refusal-rate.sql`, per cause |
| citation rate below 90 % over the last day | fewer than nine in ten of the day's answers are cited on every claim | `citation-rate.sql` |
| no purge run in two days | Loki holds no purge line without an `error` in the last two days | the job's lines |
| a secret was found in a log line (**page**) | any line of the last day carries `hb.secret.detected` | every line the product prints |

A window with no turns in it is not an alert (`Normal (NoData)`); two days with no purge line is. A purge that ran and failed does not count as a run. An alert asks its statement for the whole window as one row by passing a bucket wider than any window, `millennium`.

Where an alert goes is not decided in Phase 2 (feature-specs/21 D6): the rules use Grafana's default contact point, which is a placeholder address, and with no mail server configured a firing rule is visible in Grafana and logged, not sent.

The page means the guard replaced a secret in a line before it was written: the value did not leave the process, but a line holds ids, counts and codes and no text, so something upstream put a secret where none belongs. Find the line in Explore, `{service_name="hb-lines"} | hb_secret_detected="true"`, and follow its `traceId`.
