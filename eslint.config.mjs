import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/* feature-specs/11 § 5.5 and feature-specs/12 § 4.3, § 7.1: the gateway client, the key cipher and the two calls
   built on them — the embedder and the re-ranker, which decrypt the principal's key and post to the proxy — exist
   for the workers; the web tier may import errors.ts, prices.ts and lib/db/budget.ts only. Enforced here, so
   invariant 6 holds at lint time. The glob covers the `@/` alias and every relative form. */
const WORKERS_ONLY = "lib/gateway/client.ts, keys.ts, embed.ts and rerank.ts are the workers' (feature-specs/11 § 5.5; feature-specs/12 § 4.3, § 7.1; architecture § 11 invariant 6).";
const GATEWAY_PRIVATE = { group: ["**/lib/gateway/client", "**/lib/gateway/keys", "**/lib/gateway/embed", "**/lib/gateway/rerank"], message: WORKERS_ONLY };

/* The same invariant through the transitive path: workers/check.ts and workers/keys.ts import the client and the
   cipher, so an import of workers/ reaches them. The web tier's one door to the workers is lib/workers/client.ts
   `workersFetch` over HTTP (feature-specs/11 § 7.2), which the negated pattern leaves open. A gitignore-semantics
   pattern cannot tell a relative `../workers/x` written from lib/ apart from one written from app/, so the workers
   are imported by the `@/` alias, as every caller in the repository does. */
const WORKERS_PRIVATE = "workers/ runs in the workers process alone; the web tier reaches it through @/lib/workers/client (feature-specs/11 § 7.1, § 7.2; architecture § 11 invariant 6).";
const WORKERS_FOLDER = { group: ["**/workers/**", "!**/lib/workers/**"], message: WORKERS_PRIVATE };

/* feature-specs/32 § 4: the evidence fetcher is the only code that requests a URL a stranger chose, and it runs in
   the workers alone. The workers folder is closed to the web tier above already; this names the fetcher by
   itself, so the rule outlives any later opening of workers/ and says which spec it keeps. Scripts may run it
   (scripts/fetch-check.ts), as they run the workers' other code. */
const FETCH_PRIVATE = { group: ["**/workers/fetch/**"], message: "workers/fetch/ is the evidence fetcher and runs in the workers alone: nothing of the web tier fetches a URL a stranger chose (feature-specs/32 § 4; architecture § 2.2, invariant 34)." };

/* feature-specs/28 § 4.2: a workflow is replayed from its history, so its code may import the engine's own workflow
   API, files of its own folder and the shared schemas, and nothing else: no database, no gateway, no environment,
   no Node built-in, no activity (activities are called through `proxyActivities` with the types of
   workers/workflows/activities.ts). A pure module a workflow comes to need is added to the allow-list here, by name:
   since unit 74, workers/research/pace.ts, the asks' pacing and a suggestion's place as a finding's outcome, which both
   workflows that wait for a suggestion import (feature-specs/48 § 8.4). */
const WORKFLOW_CODE = "workflow code imports @temporalio/workflow, ./ files of workers/workflows, @/lib/schemas and @/workers/research/pace only: it must be replayable from its history (feature-specs/28 § 4.2).";
const WORKFLOWS_ONLY = [
  { regex: "\\.\\.", message: WORKFLOW_CODE },
  { regex: "^(?!@temporalio/workflow$|\\./|@/lib/schemas/|@/workers/research/pace$)", message: WORKFLOW_CODE },
];

/* feature-specs/28 § 5: the web tier reaches the workflow engine through lib/workflows/client.ts and nowhere else,
   so that every start, signal and query is validated against lib/schemas/workflows.ts, bounded by one deadline and
   fails closed. That file imports the SDK's client and none of its other packages: the worker carries a native
   module that must never be in the web container's build. */
const ENGINE_CLIENT = "the web tier reaches the workflow engine through @/lib/workflows/client (feature-specs/28 § 5).";
const TEMPORAL_SDK = { group: ["@temporalio/*"], message: ENGINE_CLIENT };
const TEMPORAL_SDK_BUT_CLIENT = { group: ["@temporalio/*", "!@temporalio/client"], message: "lib/workflows/ imports @temporalio/client and no other package of the SDK (feature-specs/28 § 5)." };

/* feature-specs/30 § 1, § 10.2: the rubric is arithmetic and table lookup that the same evidence must take the same
   way everywhere, the form's preview included. So lib/rubric/ imports files of its own folder and the shared
   schemas, and nothing else: no database, no environment, no clock's helper, no model's client. The one exception
   is named: the scope sensor's vocabulary for "about operating equipment", which rule 3 of the class reads so that
   the product has one such vocabulary and not two (30 § 4.2, D4); that file is itself pure. */
const RUBRIC_CODE = "lib/rubric/ imports ./ files of its own folder, @/lib/schemas and the scope sensor's vocabulary (@/lib/sensors/scope) only: the score is pure (feature-specs/30 § 10.2; architecture § 3.1).";
const RUBRIC_ONLY = [
  { regex: "\\.\\.", message: RUBRIC_CODE },
  { regex: "^(?!\\./|@/lib/schemas/|@/lib/sensors/scope$)", message: RUBRIC_CODE },
];

/* feature-specs/37 § 3 ("the write key"): pipeline/git.ts is the one code that writes the book's repository, and the
   merge activities (workers/activities/merge*.ts, units 54b, 54c and 54e) are the only code that imports it: no route,
   page, script, other activity or pipeline step reaches the book. Locally there is no deploy key; this is its constraint
   kept by construction. */
const BOOK_REPO_WRITER = { group: ["**/pipeline/git"], message: "pipeline/git.ts writes the book's repository: only the merge activities, workers/activities/merge*.ts, import it (feature-specs/37 § 3)." };

/* A flat-config block replaces a rule's options rather than adding to them, so each block below states every group
   that applies to its files: the later, narrower block is the whole rule for the folder it names. */
function restrictImports(...patterns) {
  return { "no-restricted-imports": ["error", { patterns }] };
}

const SOURCE = ["**/*.ts", "**/*.tsx", "**/*.mts"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: SOURCE,
    ignores: ["workers/**", "**/*.test.ts"],
    rules: restrictImports(GATEWAY_PRIVATE, WORKERS_FOLDER, FETCH_PRIVATE, TEMPORAL_SDK, BOOK_REPO_WRITER),
  },
  {
    // The web tier's one client of the workflow engine.
    files: ["lib/workflows/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(GATEWAY_PRIVATE, WORKERS_FOLDER, FETCH_PRIVATE, TEMPORAL_SDK_BUT_CLIENT, BOOK_REPO_WRITER),
  },
  {
    // scripts/gateway-key.ts and gateway-check.ts run the workers' own code on the command line.
    files: ["scripts/**/*.ts", "scripts/**/*.mts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(GATEWAY_PRIVATE, BOOK_REPO_WRITER),
  },
  {
    // lib/gateway/ is the client, the cipher and the calls built on them; nothing in it imports the workers.
    files: ["lib/gateway/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(WORKERS_FOLDER, FETCH_PRIVATE, TEMPORAL_SDK, BOOK_REPO_WRITER),
  },
  {
    // The rubric's score: pure, so this is the whole rule for the folder.
    files: ["lib/rubric/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(...RUBRIC_ONLY),
  },
  {
    // tests/workflows/ runs workflow code in Temporal's test environment with the workers' own bundle
    // (feature-specs/28 § 6), so its helpers import workers/ as the scripts above do; the fetcher is not theirs.
    files: ["tests/workflows/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(GATEWAY_PRIVATE, FETCH_PRIVATE, BOOK_REPO_WRITER),
  },
  {
    // tests/fixtures/improve/ runs the worked examples end to end (feature-specs/33 § 8): the workers' own activities on
    // the stub gateway's client and a fetcher given the fixture's documents, for their suite and the development seed.
    // It fetches nothing a stranger chose, and its gateway is the stub started in the same process.
    files: ["tests/fixtures/improve/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(BOOK_REPO_WRITER),
  },
  {
    // tests/fixtures/research/ runs a research run on the stub gateway (feature-specs/41 § 11, 43 § 13.11): the research
    // activities and the suggestion's on the stub's client, and a fetcher that serves the stub's fixture pages, for the
    // end-to-end suite and the research seed. It fetches nothing a stranger chose; its gateway is the stub in the same process.
    files: ["tests/fixtures/research/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(BOOK_REPO_WRITER),
  },
  {
    // The workers (the wide block above ignores workers/): of them, the merge activities alone write the book.
    files: ["workers/**/*.ts"],
    ignores: ["**/*.test.ts", "workers/workflows/**", "workers/activities/merge*.ts"],
    rules: restrictImports(BOOK_REPO_WRITER),
  },
  {
    // Workflow code (the wide block above ignores workers/, so this is the whole rule for the folder).
    files: ["workers/workflows/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: restrictImports(...WORKFLOWS_ONLY),
  },
]);

export default eslintConfig;
