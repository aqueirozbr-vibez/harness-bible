# 28 · The workflow engine — feature spec (Temporal as a service, the workers as its workers, the web tier's client, the test environment)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: architecture § 1 (the workflow engine row), § 2 (the Temporal container and its conduit), § 6.3 (the workflows) and invariant 17; TRD § 2.0 ("Durable suggestion and answer workflows; curator approval as a signal; timers for the 24-hour target; idempotent activities") and § 7.4 to 7.7; Andre's answer A9 of 2026-10-05 (spec 27 § 3): Temporal, as documented. No screen belongs to this spec.

Prerequisite specs: `11-model-gateway.md` § 7 (the workers as a process and their private surface), `27-improve-and-researcher-plan.md`.

Scope: tracker unit 45 (45a to 45e). The engine and nothing that runs on it: the service in compose, the workers as a Temporal worker beside their HTTP surface, one workflow that proves the engine on this machine, the web tier's way to start, signal and query, and how a workflow is tested. Not here: any workflow of the product (`SuggestionWorkflow` is spec 33, `MergeWorkflow` 37, `ExportWorkflow` 38, `ResearchWorkflow` 40).

## 1. Purpose

A suggestion lives for days. It is graded in seconds, waits for an adjudicator in minutes, may wait for a curator for a week, and its merge waits on a check and on a person again. Between those steps the process that started it may restart, the gateway may be at its cap until the first of the month, and a curator's decision may arrive from another request. The product needs somewhere that remembers where each suggestion is and what it is waiting for, and that is what the architecture names Temporal for. Until now nothing of it existed: the assistant's turn is one request, and the two nightly jobs are the operating system's (`infra/schedules/`).

This unit comes first in Improve because every later unit either is a workflow or starts one, and because it carries the plan's largest technical risk: a native SDK on Windows under Node 24. The risk is retired here, on a workflow that does nothing else, before anything depends on it.

## 2. Dependencies and order

| Unit | Delivers | Proves |
|---|---|---|
| 45a | the service | the engine starts, keeps its state across a restart, and is not reachable from outside the machine |
| 45b | the worker and the proving workflow | a workflow runs to completion on this machine, survives the workers being killed in the middle, and takes a signal |
| 45c | the test environment | a workflow's test runs in `npm test` with time skipped, and fails loudly when the environment cannot start |
| 45d | the web tier's client | a route handler can start, signal and query, and an unreachable engine is a refusal, not a hang |
| 45e | the two nightly jobs as schedules of the engine | the purge and the session sweep run at their hours without the operating system's scheduler |

New dependencies, stated as rules § 2.5 asks. The architecture lists Temporal (§ 1), which is the rule that permits them; the versions are pinned exactly, as `@anthropic-ai/sdk` is.

| Package | Used by | Licence | Note |
|---|---|---|---|
| `@temporalio/worker` | `workers/` | MIT | carries a native bridge (prebuilt per platform) and bundles workflow code with its own bundler |
| `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/common` | `workers/workflows/`, `workers/activities/` | MIT | — |
| `@temporalio/client` | `workers/`, `lib/workflows/` | MIT | gRPC |
| `@temporalio/testing` | tests (dev dependency) | MIT | downloads a test server binary on first use |

Their installed sizes are read and recorded by 45b before it installs them; the unit stops for confirmation if the total is out of proportion to what the workers already carry.

## 3. The service (45a)

- **Compose.** One service, `temporal`, in `docker-compose.yml`, on the internal network `hb-internal`, publishing its gRPC port on `127.0.0.1` alone, as the gateway publishes 4000: the engine starts workflows for whoever reaches it, so it is not offered to the network. The image is pinned by digest, as the gateway's is (architecture § 12, unit 25a).
- **Persistence.** The engine keeps its history in PostgreSQL, in a database of its own (`temporal`) in the `db` container, created idempotently by an init script under `infra/temporal/`, as `infra/gateway/init.sql` creates `litellm`. It is never the product's database: no product table is read or written by the engine, and no product query reads the engine's tables.
- **Which image.** Temporal publishes a server image that sets up its own schema in PostgreSQL and a command-line development server. 45a uses the first, because the second keeps its state in a file or in memory and the criterion of this unit is state that survives a restart. If the first does not run on this machine, 45a stops under rules § 4.4 rather than falling back silently.
- **Namespace.** `harness-bible`, created by the same init step.
- **Web UI.** Temporal's own UI is a second service under a compose profile (`workflows-ui`), off by default, as the `observe` profile is. It shows workflow histories, which by § 5.3 hold no reader's words.
- **Configuration** (`lib/env.ts`, `.env.example`, no value committed): `TEMPORAL_ADDRESS` (host and port), `TEMPORAL_NAMESPACE`. Both optional in the web tier's schema, as `WORKERS_URL` is: a machine without the engine runs the reader and the assistant as before, and every endpoint that needs a workflow refuses (§ 5).
- **Region.** The engine and its database are inside the residency boundary (invariant 29), like every other container.

## 4. The workers (45b)

### 4.1 Layout

```
workers/
  workflows/         workflow code: deterministic, bundled by the SDK; index.ts exports every workflow
  activities/        activity code: everything that touches the database, the gateway, the network or the clock
  temporal.ts        the worker's start and stop, the connection, the task queues
```

`workers/main.ts` starts the Temporal worker beside the HTTP surface when `TEMPORAL_ADDRESS` is set, and stops both on a signal. One process, as now: it is the process that holds `GATEWAY_KEY_SECRET`, and activities are where model calls are made (invariant 6).

Two task queues, so that a month's research waiting on its budget never holds a suggestion back: `hb-improve` (suggestion, merge, export) and `hb-research`.

### 4.2 Rules of workflow code

A workflow is replayed from its history, so it must compute the same thing every time.

1. A file under `workers/workflows/` imports only `@temporalio/workflow`, other files of that folder, `lib/schemas/**` and modules that are pure by the same definition `lib/rubric/` uses. It never imports `lib/db/**`, `lib/gateway/**`, `lib/env.ts`, `node:*` or anything that reads a clock, a random source or the network. `eslint.config.mjs` enforces it with a restricted-import block for that folder, and a test lints a violating snippet, as `tests/gateway-lint.test.ts` does for invariant 6.
2. Everything else is an activity. An activity is idempotent: run twice with the same input it leaves the same rows and the same ledger records. Where an activity appends to the ledger it does so under a key derived from the workflow id and the step, checked before the append (§ 4.4).
3. A workflow's decisions are code's. A workflow never passes a model's output into a branch without the check the agent's spec names (invariant 8).

### 4.3 Identity and ids

| Workflow | Id | Started by |
|---|---|---|
| `SuggestionWorkflow` | `suggestion:<S-NN-NNNN>` | `POST /suggestions/{id}/submit` (spec 31), or the research run (spec 42) |
| `MergeWorkflow` | `merge:<S-NN-NNNN>` | `SuggestionWorkflow`, as a child, on acceptance |
| `ExportWorkflow` | `export:<AuditExport.id>` | `POST /org/audit-exports` (spec 38) |
| `ResearchWorkflow` | `research:<Message.id>` | the workers, at the end of an answered turn (spec 40) |
| `ProvingWorkflow` | `proving:<uuid>` | `npm run workflows:check` |

The id is the deduplication: starting a workflow whose id is running is not an error, it returns the running one. That is what makes `submit` idempotent beyond its `Idempotency-Key`.

### 4.4 Activities: timeouts, retries, the ledger

- An activity that makes one model call sets no retry of its own. The gateway client already retries by its request row (spec 11 § 5.3), and every agent's cap is one attempt (invariant 15): a second attempt by the engine would be a second judgment. Its start-to-close timeout is the row's worst case, the row's timeout times its attempts, as spec 11 § 7.2 derives the `/gateway/check` route's.
- An activity that only reads or writes the product's rows retries on a transient database error with the engine's default backoff. The number of attempts and each activity's timeout are listed in the workflow's own spec, never defaulted in code.
- A budget refusal (`BudgetExceededError`) is not a failure of the activity. It is returned as a value carrying `resetsAt`, and the workflow sleeps until then (specs 33 § 7, 40 § 7). No activity retries into a cap.
- **A ledger record is appended once.** The activity that appends computes `stepKey = sha256(workflowId + ":" + step)` and stores it in the payload (`stepKey`, in each Phase 4 payload schema of spec 29 § 5). Before appending it asks `lib/db/ledger.ts` for a record with that suggestion id, kind and step key; finding one, it returns that record. So a retried activity cannot write `decided` twice. This is the workflow's side of invariant 17.

### 4.5 The proving workflow

`ProvingWorkflow(input: { token: string })`: runs an activity that returns the release id from the database; waits for the signal `proceed` or for a timer of one minute, whichever comes first; runs a second activity that returns the ledger head's `seq`; returns `{ releaseId, headSeq, signalled }`. It exists to prove the engine and stays in the repository as its health check: `npm run workflows:check` starts it, signals it, awaits the result and prints one line.

`GET /health` on the workers' private surface gains `temporal: "up" | "down" | "off"` (`off` when `TEMPORAL_ADDRESS` is unset), probed as the gateway is: cached, deadlined inside the route's own deadline.

### 4.6 The nightly jobs (45e)

Code-standards § Data and Storage and `infra/schedules/README.md` both say the retention jobs become Temporal schedules "from Phase 4, when Temporal arrives". So they do, last in this unit, once the engine is proved: `assistant:purge` (03:10 America/Sao_Paulo) and `auth:sweep` (03:20), each a schedule that starts a one-activity workflow calling the function the script calls today. The scripts stay as the manual way to run them; the crontab and the Windows task are removed, with the README saying so. A machine without the engine has no nightly purge and its health check says `temporal: "off"`, which is why 45e comes after 45a to 45d have run for a while on this one.

## 5. The web tier's client (45d)

`lib/workflows/client.ts`: `startWorkflow(name, id, args)`, `signalWorkflow(id, signal, args)`, `queryWorkflow(id, query)`. It is the web tier's only import of `@temporalio/client`.

- **Typed by name.** The workflow names, their argument schemas and their signals are zod schemas in `lib/schemas/workflows.ts`, shared with `workers/workflows/`; the client validates before it sends.
- **Fail closed.** No `TEMPORAL_ADDRESS`, a connection that cannot be made, or a call that exceeds its deadline is `WorkflowsUnavailableError` → `WORKFLOWS_UNAVAILABLE`, 503, in the API's error form, with the message naming what was not done ("The suggestion was not submitted. Try again."; candidate, rules § 4.6). Nothing is half done: the endpoint that starts a workflow writes the state that says so only after the start returned (spec 31 § 6).
- **Deadline.** One number for the three calls, since each is a single round trip to the engine: the `/health` row's 5 s of spec 11 § 7.2, the deadline the product already uses for "is the other process there".
- **What crosses.** Arguments are ids, enumerations, numbers and hashes (§ 5.3 below). The client's schemas make a string field a branded id or an enum; there is no free-text field to put a sentence in.

### 5.3 No reader's words in a history

Temporal persists every workflow argument, every activity argument and every activity result. A question a reader asked is purged from `Message.text` after 30 days (architecture § 4.4); a copy in a workflow history would outlive it. So:

- A workflow's input and every activity's input and result are ids, enumerations, numbers, booleans, hashes and ISO instants. Text a person or a model wrote stays in the product's rows and is read by the activity that needs it.
- The schemas of `lib/schemas/workflows.ts` are built from a small set of field types that excludes `z.string()` without a brand, a pattern or an enumeration. A unit test walks every schema in the file and fails on a bare string.
- An activity that fails throws an error whose message is a code and ids, never the text it was working on.

## 6. Tests (45c)

- **Unit**: a workflow's logic that is a pure function (routing, deadlines, the state it should be in) is tested as one, beside its module.
- **Workflow tests**: `tests/workflows/*.test.ts` run each workflow in Temporal's test environment with time skipping, with activities replaced by doubles, so a seven-day wait takes milliseconds. They are part of `npm test`.
- **The precondition is loud.** The test environment needs its server binary, downloaded once. `tests/workflows/environment.ts` starts it in a `beforeAll`; if it cannot start, the suite fails with the command that fixes it, as `tests/integration/search.test.ts` does for a release without vectors (architecture § 12, 2026-09-24). CI caches the binary.
- **Integration**: `tests/integration/workflows.test.ts` runs `ProvingWorkflow` against the compose service, behind `describe.skipIf(!hasTemporal)`, the engine's twin of `hasDatabase`.

## 7. States

| State | Behaviour |
|---|---|
| engine not configured | the workers start without a Temporal worker and say so in one line; `/health` reports `temporal: "off"`; every endpoint that needs a workflow answers 503 `WORKFLOWS_UNAVAILABLE` |
| engine unreachable at start | the workers start their HTTP surface and retry the connection; `/health` reports `down` |
| workers killed during a workflow | the workflow resumes when a worker returns, from its history; an activity in flight is run again and, being idempotent, changes nothing twice |
| engine restarted | running workflows continue; timers fire at their time or at once if it passed |

## 8. Out of scope

- Any workflow of the product.
- Moving the assistant's turn onto the engine (spec 27 § 8).
- The quarterly calibration snapshot of architecture § 6.3 as a schedule: the measures of spec 36 § 6 are computed on read from the events, so nothing needs a snapshot yet.
- Temporal's mTLS (architecture § 2.2) on the development machine: loopback and the internal network. It is a deployment's configuration.
- `POST /webhooks/temporal` (TRD § 6.1, "workflow state changes for notifications"): it exists to drive e-mail, which is deferred (spec 35 D3).

## 9. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | One process for HTTP and the Temporal worker, or two | one | the workers are already the one process with the key secret; a second container doubles the places a secret lives for no isolation gained |
| D2 | The web tier talks to the engine itself, or through the workers | itself | architecture § 2.1 and § 2.2 say so ("Web tier → Temporal: start, signal, query"), and a curator's decision must not depend on the workers' HTTP surface being up |
| D3 | Free text in workflow histories | never (§ 5.3) | the 30-day purge and the ledger's "hashes of free text" rule would both be defeated by a second copy |
| D4 | If the SDK does not run on Windows under Node 24 | stop and ask | Andre chose Temporal over a state machine in PostgreSQL (A9); the fallback is his to choose again, with the failure in hand |

## 10. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `docker compose up -d temporal` starts the service; `docker compose port temporal` shows a loopback binding only; the `temporal` database exists and the product's database has no new table.
2. `npm run workflows:check` prints the release id and the ledger head's `seq` with `signalled: true`.
3. The same check with the workers killed after the first activity and started again completes with the same result, and the first activity's effect happened once.
4. With the service stopped and started in the middle, the workflow completes.
5. `npm test` runs the proving workflow's test with time skipped: the unsignalled branch, which waits a minute, finishes in under a second.
6. With the test server made unavailable, the workflow suite fails naming the fix; it does not skip.
7. With `TEMPORAL_ADDRESS` unset, `lib/workflows/client.ts` raises `WorkflowsUnavailableError` at once; set to a closed port, within the deadline.
8. The lint test refuses `import { getPrisma } from "@/lib/db/client"` in a file under `workers/workflows/`.
9. The schema-walk test refuses a workflow argument schema with a bare `z.string()`.
10. 45e: with the test's clock moved to 03:10, the purge's workflow runs once and empties what the script would have; moved again, it does not run twice for the same night.
11. `npm run build`, `npx tsc --noEmit`, `npm run lint` and `npm test` pass on this machine. If the native bridge fails to load, the unit reports the failure under D4 and builds nothing further.


## 11. As built (unit 45a, 2026-10-05)

The service of § 3, on this machine. Where it differs from § 3, what was found and why:

- **The image is the server with a schema step, not a self-setting-up server.** § 3 named "a server image that sets up its own schema". Temporal stopped publishing that image at 1.29 (the registry holds no later tag); from 1.30 its own published arrangement is the server image plus the admin image running the schema tool (`temporalio/samples-server`, `compose/docker-compose-postgres.yml`, read 2026-10-05). So the compose file has three services where § 3 said one: `temporal-schema` (runs once), `temporal`, `temporal-namespace` (runs once). The command is **`docker compose up -d temporal-namespace`**, which brings up all three in order; § 10.1's `up -d temporal` starts the first two and not the namespace. It is still the real server on PostgreSQL and never the development server, which is what § 3 chose it for.
- **Pins**: `temporalio/server` and `temporalio/admin-tools` 1.31.3, `temporalio/ui` 2.55.0, each by digest. 1.31.3 is the latest patch of the minor version Temporal's own sample pins; 1.32.0 exists and is three weeks old.
- **Two databases, not one**: `temporal` (history) and `temporal_visibility`, in the `db` server. They are created by the schema step's own tool, which is idempotent (run again it reports zero updates), so there is no `init.sql`: the database's init scripts run only on an empty volume and this machine's has data.
- **The scripts are inline in the compose file**, as `observe-init`'s is, not files under `infra/temporal/`: a mounted `.sh` is checked out with CRLF endings on Windows and does not run. `infra/temporal/` holds the dynamic configuration alone.
- **Dynamic configuration, two keys**, both known to the server's own validator: `limit.maxIDLength` 255 (the width of the SQL schema's id columns; the published SQL configuration's value) and `frontend.enableServerVersionCheck` false, so the server does not report its version and cluster id to its vendor. The UI's news fetch and version notice are off for the same reason.
- **No authorizer, said explicitly** (`TEMPORAL_ALLOW_NO_AUTH`): the server warns that a later version will refuse to start without either. On this machine the frontend is on the loopback and the internal network only.
- **The namespace's retention is the tool's default, 72 hours**: how long the engine keeps the history of a workflow that has ended. Nobody chose it. Nothing the product needs later lives in a history (§ 5.3), so it matters for debugging only; it is listed for Andre in the tracker.
- **The UI** is `temporal-ui` under the profile `workflows-ui`, on `127.0.0.1:8233`.
- **Configuration**: `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` are optional in `lib/env.ts`, their forms in `lib/schemas/workflows.ts` (a host and a port without a scheme; lower-case letters, digits and hyphens), which is the file § 5 gives the workflows' names and arguments to. Neither is required in production yet: that joins the first endpoint that cannot work without the engine (spec 31 § 6).

Measured: the schema step takes a few seconds the first time and reports zero updates after; the server is healthy 6 s after it starts and holds about 95 MiB; a workflow started with no worker to run it was still there, same run id, after the server's container was restarted; the product's database had 31 tables before and after, and the server gained two databases. In its first seconds, and again after a restart, the server logs a few dozen `error` lines while a single node finds itself (`shard status unknown`, `Not enough hosts to serve the request`); none follows once it is healthy.

`tests/workflow-engine.test.ts` holds the compose file to this: the pins and their one version, the loopback publications, the internal network, the order of the three, databases of its own, none of the product's secrets, the two dynamic keys. The compose file's service parser moved to `tests/fixtures/compose.ts` for it, and the observability suite's check that only its own services are profiled now names its profile, since the file has a second.


## 12. As built (unit 45b, 2026-10-05)

The workers of § 4, running on this machine. The risk § 1 named is retired: Temporal's SDK, native bridge included, loads under Node 24.19 on Windows and connects to the engine in about 20 ms.

- **Packages**: `@temporalio/worker`, `@temporalio/workflow` and `@temporalio/client`, each 1.24.0 exactly, MIT, declaring Node 20.3 or later. `node_modules` went from 1,091 MB to 1,310 MB: the bridge package alone is 147 MB because it ships a prebuilt binary for five platforms, and the bundler brings webpack and swc. § 2 also listed `@temporalio/activity` and `@temporalio/common`: neither is imported yet, so neither is a direct dependency (both arrive transitively); `@temporalio/testing` is unit 45c's.
- **Layout** as § 4.1, with one file more: `workers/workflows/activities.ts` holds the activities' **types**, the interface a workflow asks of the world, and `workers/activities/` implements it. A workflow therefore imports nothing outside its own folder but the engine's workflow API and `lib/schemas/`, and the lint rule needs no exception for a type import of the activities.
- **The rule of § 4.2** is two patterns of `no-restricted-imports` for `workers/workflows/**`: no parent traversal anywhere in a specifier, and nothing that is not `@temporalio/workflow`, `./…` or `@/lib/schemas/…`. `tests/workflows-lint.test.ts` lints nineteen refused specifiers and five allowed ones. A pure module a workflow comes to need (the rubric will be the first) is added to the allow-list by name.
- **The bundle**: the SDK compiles `workers/workflows/` for its deterministic sandbox when the workers start, in about a second, 2.6 MB, with the `@/` alias added to its resolver. `lib/schemas/workflows.ts` and `lib/schemas/ids.ts` are in it, and so is zod, which runs inside the sandbox: the proving workflow checks its own argument with the shared schema and fails for good, not as a retried task, when it does not parse.
- **The SDK is loaded on demand** (`import("./temporal")` in `workers/main.ts`, held by a test): without `TEMPORAL_ADDRESS` neither it nor its native module is loaded, as no OpenTelemetry code loads without a collector. The engine's configuration (`EngineConfig`, `engineConfigOf`) is therefore in `workers/env.ts`, which loads nothing. An address without a namespace refuses the boot rather than assuming one.
- **Supervision** (`superviseEngine`): an engine that is not there at start, or a worker that fails, does not stop the HTTP surface. The start is tried again every 30 s, the interval the health probes already refresh at, and each failure is one line.
- **`/health`** has a fourth member, `temporal`: `off` without an engine, else a cached probe that connects and asks the engine for the namespace inside the probes' 3 s deadline. The surface's option is optional, so the suites that start a surface without an engine read `off`.
- **`npm run workflows:check`** starts one `ProvingWorkflow`, signals it and prints its result; with `-- --no-signal` it lets the workflow's own one-minute timer end the wait, which is the form to use while killing something in the middle.
- **Numbers this unit had to choose**, each the product's own number for the same kind of thing, listed for Andre in the tracker: the proving workflow's two reads have a start-to-close timeout of 5 s (the `/health` route's deadline) and 3 attempts (the gateway client's default of two retries); the supervisor's retry is the probes' 30 s.
- **The compose `workers` service** is given the engine's address and waits for the namespace step. **It was not verified in the container**, because the container cannot start, for a reason older than this unit (the tracker's Known defects): the image copies `lib/` and `workers/` only, and since unit 29c, when the process began to run the assistant's answer flow, the workers import `pipeline/renderHash` and read `guides/`.

Verified by running it, on the compose engine of unit 45a:

| § 10 | What was done | What happened |
|---|---|---|
| 2 | `npm run workflows:check` | `release 2026.09 · ledger head 5828 · signalled true`, 305 to 456 ms; both values equal a direct query of the database |
| 3 | started without a signal; the workers killed outright after the first activity; started again | finished at 60.4 s with `signalled false`; the history holds one scheduling of the first activity (before the kill) and one of the second (after it) |
| 4 | started without a signal; the engine's container restarted in the middle | finished at 60.2 s; the workers stayed in their running state throughout |
| § 7 | a second workers process with no engine configured | says so in one line; `temporal: "off"` |
| § 7 | a second workers process naming a port nothing listens on | the surface is up; `/health` answers `temporal: "down"` in 3 s; one line says no worker is running and when it will try again |
| 8 | the lint test | refuses the database, the gateway, the environment, activities, Node built-ins, zod and the SDK's other packages in workflow code |

Not verified: a stop by signal on this machine (the supervisor's stop is covered by its tests; from a script on Windows a process can only be killed outright); the Linux build of the bridge, which only the container would exercise.

The SDK logs its own lines at its default level (the bundle, each worker's state) in its own format beside the product's JSON lines. They carry task queue names and no text of anyone's, and the collector's allow-list of line kinds does not pass them on.



## 13. As built (unit 45c, 2026-10-05)

The tests of § 6. A workflow's suite runs in `npm test` on Temporal's time-skipping test server, which starts and runs on this machine; a wait of a minute takes a third of a second, and a server that cannot start fails the suite with the command that repairs it.

- **Package**: `@temporalio/testing` 1.24.0 exactly, MIT, a development dependency, 101 KB by the registry's count. Everything it depends on was installed by unit 45b, so `node_modules` stayed at 1,310 MB until the server's own file arrived.
- **The test server** is a program, not a package: it is published with Temporal's Java SDK and the TypeScript SDK downloads it from `temporal.download`. It is pinned to **`v1.40.0`**, the release the vendor's "default" answered for SDK 1.24.0 on 2026-10-05, where the SDK's own default is "whatever is current". It is 58 MB and is kept in `node_modules/.cache/temporal-test-server/`: ignored by git, and exactly as long-lived as an install. It is pinned by version and not by digest, because the SDK's downloader takes no digest.
- **Something the SDK does that its documentation does not say plainly**: it fetches the file again once it is older than a time to live, one day unless told, and that applies to a pinned version too (found by setting it to a millisecond: the same release was downloaded again). It has no value for "never". The version being pinned, the file's age means nothing, so the time to live is set to ten years, which stands for never; otherwise `npm test` would need the network every morning.
- **Files**: `tests/workflows/server.ts` (the pin, the folder, the start, and the text of the failure; no vitest in it, so a script can import it), `tests/workflows/environment.ts` (`workflowEnvironment()`, what a workflow suite calls), `scripts/workflows-test-server.ts` (`npm run workflows:test-server`).
- **`workflowEnvironment()`** starts one server per test file in a `beforeAll`, bundles the workflow code with `bundleWorkflows()`, the function the workers' own start now calls, so a suite runs exactly what the workers load, and hands each test `withWorker(doubles, during)`: a worker on a task queue of its own whose activities are the doubles the test gives. The server has one clock, so the tests of a file run one after another and never `concurrent`.
- **What the SDK says during a test is held, and printed only for a test that failed.** A test of a failure makes the SDK log every failed activity and workflow with a stack, which beside a green result reads as something broken; and when a test is red for a reason of the engine's, those lines are the only place the reason is. The lines of the SDK's native half are forwarded to the same place.
- **The precondition is loud** (§ 10.6), and the fix is one command. `npm run workflows:test-server` fetches the server if the install lacks it, deletes and fetches again a file that is there and does not start, starts it once and prints one line. A suite whose server cannot start fails with three lines: what did not start, what is needed and where it is kept, and that command.
- **CI** restores a cache of the folder after `npm ci` (which empties `node_modules`), keyed by the runner's system and the release, then runs the command above, then `npm test`. `tests/workflows/server.test.ts` holds the key to the pin and the three steps to that order. CI itself has still never run.
- **The integration suite** (`tests/integration/workflows.test.ts`) is behind the database **and** the engine, not the engine alone as § 6 wrote: the real activities read the product's rows. It starts the workers' own worker (`startEngine`, which gained an optional list of task queues) on a queue of that run's own, so a `npm run workers` on the same machine is never handed the suite's task; it deletes the workflow it started.
- **Lint**: the helpers of `tests/workflows/` import `workers/`, as the scripts do, by a block of their own in `eslint.config.mjs`.

Verified by running it:

| § 10 | What was done | What happened |
|---|---|---|
| 5 | `npx vitest run tests/workflows/` | 15 cases pass. The unsignalled branch, which waits a minute, takes 0.36 s, and the engine's own clock stood at least a minute later when the workflow closed. A failed activity's two back-offs are skipped the same way |
| 5 | the server by hand | the first start, with its download, 5.1 s; later starts 0.2 s; a sleep of seven days, 5 ms |
| 6 | the server's file replaced by one that is not a program | the suite fails (exit 1) with the three lines; it does not skip |
| 6 | no file, and the download made unreachable | the same, naming the address it could not reach; the repair command fails with the same text and exit 1 |
| 6 | `npm run workflows:test-server` after the first of those | says the file did not start, fetches it again (3.4 s), starts it; the suite passes |
| — | the integration suite with the database and the compose engine | 2 cases pass in 3.1 s; without the engine's address it is skipped; a minute later the namespace no longer lists its workflow |
| — | the workers restarted on this unit's code | bundle, polling, `npm run workflows:check` in 418 ms, `/health` reads `temporal: "up"` |

The proving workflow's suite holds six things: the result with a signal; the minute without one; a signal that arrives while the first activity is still running; an activity that fails twice and answers on the third attempt; one that fails three times, after which the second activity never runs; and an argument that is not a uuid, refused for good with the code `WORKFLOW_INPUT` and no activity run.

Limits: the test server is not the real server (the SDK's own note says it lacks some of its capabilities and may behave differently), which is what the integration suite is for; and the SDK notes it has no ARM build, so on Apple silicon it needs Rosetta 2. Not verified: the CI steps, and the server's Linux file.



## 14. As built (unit 45d, 2026-10-05)

The client of § 5. A route handler starts, asks and signals a workflow through `lib/workflows/client.ts`; with no engine it is refused at once, and with an engine that does not answer, at five seconds. `next.config.ts` did not need to change.

- **The three calls take the workflow's name first**: `startWorkflow(name, id, input)`, `signalWorkflow(name, id, signal, input)`, `queryWorkflow(name, id, query)`, where § 5 wrote the last two without it. The name is what types the signal and the query and what says which form the id must have, so a suggestion's id cannot be sent to another workflow. A signal that carries nothing takes `null`.
- **Typed by a table.** `WORKFLOWS` in `lib/schemas/workflows.ts` has one entry per workflow: its task queue, the schema of its id, of its argument and of its result, its signals (a schema, or `null`) and its queries (the schema of the answer). The client parses the id and the argument before anything is sent and a query's answer before it is returned. A test holds the table's names to what `workers/workflows/index.ts` exports. A workflow joins the table in the unit that writes it.
- **The proving workflow answers a query**, `stage`: `release`, `waiting`, `head` or `done`. § 2 asks this unit to prove a query, and no workflow had one.
- **The deadline is enforced by the client, because the SDK's is not one.** Measured on a port nothing listens on: asked for five seconds, the SDK gave up after 6.1. It retries an unreachable engine by itself, backing off without looking at the deadline. So the client holds the whole call, connection included, to `WORKFLOWS_DEADLINE_MS` (5 s, § 5's number): at that instant it cancels what is in flight and answers. After it the SDK sends nothing: gRPC refuses a call whose deadline has passed before it leaves.
- **The SDK's retries are kept inside that bound**, and earn their place: a call made while the engine's container was restarting was answered in 1.2 s instead of refused. The price is that a port nothing listens on costs the full five seconds, not a fast refusal.
- **One connection per process**, made without connecting and kept as the database client is kept, so the development server's reloads do not leave one behind each time. It came back by itself after the engine restarted.
- **What is thrown.** `WorkflowsUnavailableError` (`WORKFLOWS_UNAVAILABLE`, 503 in the catalogue) for no address, no namespace, an engine that cannot be reached, one that did not answer in time, a namespace the engine does not know, and a query's answer of another shape. `WorkflowNotFoundError` (the catalogue's `NOT_FOUND`) when the engine answered and nothing under that id can take the call: never started, or ended, for a signal. It is not "unavailable", and what it means to a reader is the endpoint's to say. Anything else is passed on as it is and is a 500.
- **No sentence was written for the 503.** `WORKFLOWS_UNAVAILABLE` has no entry in the message catalogues, as `WORKERS_UNAVAILABLE` has none: the endpoint says what was not done, and § 5's "The suggestion was not submitted. Try again." stays spec 31's candidate, Andre's to confirm.
- **A start that timed out may still have started**: the request can reach the engine as the deadline passes. The id is the answer (§ 4.3): a second start under a running id is handed the same run, which the integration suite holds. What the engine does **not** refuse is a start under an id whose workflow has **ended**: it begins a new run (the SDK's default, seen with the proving workflow). Whether that may happen is for each workflow's endpoint to prevent from its own rows (specs 31 and 40), and is listed for those units in the tracker.
- **The walk of § 5.3** is `freeTextIn` (`lib/schemas/freeText.ts`). It returns every place in a schema that could hold a sentence. It allows by name: numbers, booleans, enumerations, literals, strings of the formats uuid and date-time, a string with a pattern, a template of literals and such parts, and objects, arrays, tuples, unions and records of those. A string with no pattern, an e-mail address, a URL, an object that keeps keys nobody named, and every kind it does not know are findings. A pattern is also given a sentence to refuse, which catches `.+` and a pattern with no anchors; that is a probe and not a proof. `lib/schemas/workflows.test.ts` runs it over everything the file exports, the table included, so a schema added later is held to it without being listed.
- **The rule of § 5's first line is lint**: no package of the SDK under `app/`, `components/`, `lib/` or `pipeline/`; `lib/workflows/` may import `@temporalio/client` and no other, because the worker's package carries a native module that must not be in the web container's build. The production build was read for it: the client is bundled into one server chunk of 1.4 MB, and nothing of the worker or its bridge is there.
- **Closing** (`closeWorkflowsEngines`, for a script or a suite; the web tier never closes) waits for the SDK's calls to settle first. Found by the suite: closing straight after a timed-out call let the SDK's retry timer fire on a closed connection, an exception nothing can catch. The test now closes at that worst moment and stays to see nothing thrown; with the wait taken out it failed six runs of six.

Verified by running it, with a route handler written for the purpose and deleted again (start, then query, then signal):

| § 10 | What was done | What happened |
|---|---|---|
| — | the handler in the development server | 200; 419 ms the first time, which made the connection, then 178 and 113 ms |
| — | the handler in the production server (`next start`) | 200 in 110 and 48 ms |
| 7 | the production server with `TEMPORAL_ADDRESS` naming a port nothing listens on | 503 `WORKFLOWS_UNAVAILABLE` at 5,015 and 5,002 ms |
| 7 | the production server with `TEMPORAL_ADDRESS` empty | 503 `WORKFLOWS_UNAVAILABLE` in 1 ms and 0 ms |
| — | the engine's container restarted under the development server | the call made during the restart: 200 in 1.2 s; the next two, 50 ms each, on the connection held from before |
| 9 | the walk over every schema of `lib/schemas/workflows.ts` | no finding; a workflow argument with a bare string beside its id is refused by its path |
| — | the integration suite, through the client, on the compose engine | start, a second start handed the same run, `stage` read as `waiting`, the signal, `done`; a signal to the workflow once ended, and to an id nobody started, are `WorkflowNotFoundError`; a namespace nobody registered is unavailable |

Not verified: the web tier in a container. The production server was run from the checkout.
