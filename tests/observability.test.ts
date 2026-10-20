import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SERIES, seriesSql } from "@/lib/metrics/assistant";
import { generated } from "@/lib/metrics/dashboard";
import { RESEARCH_SERIES, researchSql } from "@/lib/metrics/research";
import { generatedResearch } from "@/lib/metrics/researchDashboard";
import { PRODUCT_LANGFUSE_KEYS } from "@/lib/telemetry/langfuse";
import { LINE_KINDS } from "@/lib/telemetry/print";

import { servicesOf } from "./fixtures/compose";

/*
 * The observability stack as code (feature-specs/21 § 5.2, § 13.5): what the compose profile starts, what the
 * collector lets through, and what the dashboard's database role may read. These read the repository's own files,
 * as the gateway's configuration suite does; that the stack runs is checked by running it (infra/observability/README.md).
 */

const root = join(import.meta.dirname, "..");
/* Line endings as `\n` whatever the checkout wrote: every pattern below is written against them. */
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8").replace(/\r\n/g, "\n");

const compose = read("docker-compose.yml");
const collector = read("infra", "observability", "otel-collector.yaml");
const initSql = read("infra", "observability", "init.sql");
const datasources = read("infra", "observability", "grafana", "provisioning", "datasources", "datasources.yaml");

const services = servicesOf(compose);
const OBSERVE = ["otel-collector", "tempo", "loki", "observe-init", "grafana"];

describe("the compose `observe` profile", () => {
  it("holds the five observability services and nothing else, so a plain `up` starts none of them", () => {
    /* By the profile's own name: since unit 45a the file has a second profile, the workflow engine's UI. */
    const profiled = [...services].filter(([, block]) => block.includes('profiles: ["observe"]')).map(([name]) => name);
    expect(profiled.sort()).toEqual([...OBSERVE].sort());
    for (const name of OBSERVE) expect(services.get(name)).toContain('profiles: ["observe"]');
  });

  it("pins every image: the four vendors' by digest, the role's one-shot service to the database's own image", () => {
    for (const name of ["otel-collector", "tempo", "loki", "grafana"]) {
      expect(services.get(name)).toMatch(/\n {4}image: [a-z/-]+:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
    }
    const imageOf = (name: string) => /\n {4}image: (\S+)\n/.exec(services.get(name) ?? "")?.[1];
    expect(imageOf("observe-init")).toBe(imageOf("db"));
  });

  it("publishes its ports on the loopback alone, and only the collector's and Grafana's", () => {
    const published = OBSERVE.flatMap((name) => [...(services.get(name) ?? "").matchAll(/\n {6}- "([^"]+:\d+:\d+)"\n/g)].map((match) => `${name} ${match[1] ?? ""}`));
    expect(published).toEqual(["otel-collector 127.0.0.1:4318:4318", "grafana 127.0.0.1:3001:3000"]);
  });

  it("sends nothing to a vendor: each of the three usage reports is switched off", () => {
    expect(read("infra", "observability", "tempo.yaml")).toMatch(/\nusage_report:\n {2}reporting_enabled: false\n/);
    expect(read("infra", "observability", "loki.yaml")).toMatch(/\nanalytics:\n {2}reporting_enabled: false\n/);
    for (const setting of ["GF_ANALYTICS_REPORTING_ENABLED", "GF_ANALYTICS_CHECK_FOR_UPDATES", "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES", "GF_NEWS_NEWS_FEED_ENABLED"]) {
      expect(services.get("grafana")).toContain(`${setting}: "false"`);
    }
  });

  it("carries no password in the file: the role's and Grafana's come from the environment, with a development default", () => {
    expect(services.get("observe-init")).toContain("HB_METRICS_PASSWORD: ${HB_METRICS_PASSWORD:-hb_metrics}");
    expect(services.get("grafana")).toContain("GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}");
    expect(datasources).toContain("password: $HB_METRICS_PASSWORD");
    for (const name of ["HB_METRICS_PASSWORD", "GRAFANA_ADMIN_PASSWORD", "HB_LOG_DIR"]) expect(read(".env.example")).toContain(`# ${name}=`);
    expect(read(".gitignore")).toContain("\n/var/\n");
  });
});

/** Every `.ts` file under a folder, tests left out. */
function sourcesUnder(folder: string): ReadonlyArray<string> {
  return readdirSync(join(root, folder)).flatMap((entry) => {
    const path = join(folder, entry);
    if (entry === "generated" || entry === "node_modules") return [];
    if (statSync(join(root, path)).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("the collector", () => {
  it("takes spans over OTLP/HTTP on 4318 and sends them to Tempo, and lines from the log folder to Loki", () => {
    expect(collector).toMatch(/\n {2}otlp:\n {4}protocols:\n {6}http:\n {8}endpoint: 0\.0\.0\.0:4318\n/);
    /* Tempo receives no gateway span (feature-specs/49 § 5.5) */
    expect(collector).toMatch(/\n {4}traces:\n {6}receivers: \[otlp\]\n {6}processors: \[filter\/tempo, batch\]\n {6}exporters: \[otlp_grpc\/tempo\]\n/);
    expect(processor("filter/tempo")).toBe(`    error_mode: ignore\n    traces:\n      span:\n        - 'resource.attributes["service.name"] == "hb-gateway"'\n`);
    expect(collector).toMatch(/\n {4}logs:\n {6}receivers: \[file_log\]\n {6}processors: \[resource\/lines, batch\]\n {6}exporters: \[otlp_http\/loki\]\n/);
    expect(collector).toContain("      - /var/log/hb/*.log\n");
    /* New lines only: a line has no time of its own, so an old one read late would be filed under today. */
    expect(collector).toContain("\n    start_at: end\n");
    expect(services.get("otel-collector")).toContain("${HB_LOG_DIR:-./var/log/hb}:/var/log/hb:ro");
  });

  it("lets through exactly the kinds of line the product prints, and drops everything else", () => {
    const allowed = JSON.parse(/expr: 'not \(attributes\.kind in (\[[^\]]+\])\)'/.exec(collector)?.[1] ?? "[]") as string[];
    expect([...allowed].sort()).toEqual([...LINE_KINDS].sort());
    /* Every line is written by `printLine` with one of those kinds, and nothing builds a line of its own beside it. */
    const printed = new Set<string>();
    const handMade: string[] = [];
    for (const file of ["lib", "workers", "scripts"].flatMap(sourcesUnder)) {
      const source = read(file);
      for (const match of source.matchAll(/printLine\("([a-z_]+)"/g)) if (match[1] !== undefined) printed.add(match[1]);
      if (/JSON\.stringify\(\{ kind: /.test(source) && !file.replace(/\\/g, "/").endsWith("lib/telemetry/print.ts")) handMade.push(file);
    }
    expect([...printed].sort()).toEqual([...LINE_KINDS].sort());
    expect(handMade).toEqual([]);
    expect(collector).toMatch(/- type: json_parser\n {8}parse_from: body\n {8}on_error: drop_quiet\n/);
  });
});

/** One processor's block of the collector's file, comments left out, from its name to the next processor. */
function processor(name: string): string {
  const body = collector.slice(collector.indexOf("\nprocessors:\n"), collector.indexOf("\nexporters:\n"));
  const start = body.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = body.slice(start + name.length + 5);
  const end = rest.search(/\n {2}[a-z][\w/-]*:\n/);
  return `${(end === -1 ? rest : rest.slice(0, end + 1))
    .split("\n")
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== "")
    .join("\n")}\n`;
}

/** Every OTTL condition or statement of a processor, quoted or folded, as one line each. */
function statementsOf(name: string): ReadonlyArray<string> {
  const block = processor(name);
  const folded = [...block.matchAll(/- >-\n((?: {12}.*\n)+)/g)].map((match) => (match[1] ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" "));
  return [...[...block.matchAll(/^\s*- '(.*)'$/gm)].map((match) => (match[1] ?? "").replace(/''/g, "'")), ...folded];
}

/*
 * The road to Langfuse (feature-specs/49 § 5.5, § 9.5; unit 79): read as text, as the rest of this file is. That the
 * pinned image parses it is its own `validate` (README); that it does what this reads is
 * tests/observability-collector.test.ts, which runs it over recorded spans (HB_COLLECTOR_TEST=1).
 */
describe("the collector's road to Langfuse (49 § 5.5)", () => {
  it("is its own pipeline from the same receiver, its processors in the spec's order", () => {
    expect(collector).toMatch(
      /\n {4}traces\/langfuse:\n {6}receivers: \[otlp\]\n {6}processors: \[filter\/langfuse, transform\/langfuse-resource, transform\/langfuse-app, transform\/langfuse-gateway, transform\/langfuse-all, batch\]\n {6}exporters: \[otlp_http\/langfuse\]\n/,
    );
    expect(collector).toContain("\n  extensions: [file_storage, basicauth/langfuse]\n");
  });

  it("drops everything while the endpoint or the environment is empty, Langfuse Cloud for any environment but development, and any sender but the product's", () => {
    const conditions = statementsOf("filter/langfuse");
    expect(conditions.slice(0, 4)).toEqual([
      '"${env:LANGFUSE_OTLP_ENDPOINT:-}" == ""',
      '"${env:LANGFUSE_TRACING_ENVIRONMENT:-}" == ""',
      /* a host name ignores case */
      'IsMatch("${env:LANGFUSE_OTLP_ENDPOINT:-}", "(?i)cloud\\\\.langfuse\\\\.com") and "${env:LANGFUSE_TRACING_ENVIRONMENT:-}" != "development"',
      /* the product's three services and the gateway; `$$` is the configuration's escape of `$` */
      'not IsMatch(resource.attributes["service.name"], "^hb-(web|workers|jobs|gateway)$$")',
    ]);
    /* requests, jobs, the release's embedding job (D3), and every gateway span but the generation */
    expect(conditions.slice(4)).toEqual([
      'name == "http.request"',
      'name == "job"',
      'attributes["hb.agent"] == "embed.release"',
      'attributes["langfuse.generation.name"] == "embed.release"',
      'resource.attributes["service.name"] == "hb-gateway" and attributes["langfuse.observation.type"] != "generation"',
      /* the span events, every one: an exception's message and stack trace never leave */
      "true",
    ]);
    expect(processor("filter/langfuse")).toMatch(/\n {6}spanevent:\n {8}- 'true'\n/);
  });

  it("cuts every resource to its name", () => {
    expect(statementsOf("transform/langfuse-resource")).toEqual(['keep_keys(resource.attributes, ["service.name"])']);
  });

  it("makes a marked product span a root, names a call's span for its agent, and keeps exactly PRODUCT_LANGFUSE_KEYS", () => {
    const statements = statementsOf("transform/langfuse-app");
    expect(statements).toEqual([
      'resource.attributes["service.name"] != "hb-gateway"',
      'set(span.parent_span_id, SpanID(0x0000000000000000)) where span.attributes["hb.parent"] == "request"',
      'set(span.name, span.attributes["hb.agent"]) where span.attributes["hb.agent"] != nil',
      expect.stringMatching(/^keep_keys\(span\.attributes, \[ .* \]\)$/),
    ]);
    const kept = [...(statements[3] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(kept).toEqual([...PRODUCT_LANGFUSE_KEYS]);
  });

  it("names the gateway's generation, maps its cost, keeps one anchored pattern, and passes its text only where § 9 allows", () => {
    const off = '"${env:LANGFUSE_MESSAGE_TEXT:-off}" != "on"';
    expect(statementsOf("transform/langfuse-gateway")).toEqual([
      'resource.attributes["service.name"] == "hb-gateway"',
      'set(span.name, span.attributes["langfuse.generation.name"]) where span.attributes["langfuse.generation.name"] != nil',
      'set(span.attributes["gen_ai.usage.cost"], span.attributes["llm.cost.total"]) where span.attributes["llm.cost.total"] != nil',
      'set(span.attributes["langfuse.observation.type"], "embedding") where IsMatch(span.name, "^embed\\\\.")',
      /* a failed call, the evidence grader's PDF or image row, and the collector's half of the switch, off by default */
      `delete_key(span.attributes, "langfuse.observation.input") where span.status.code == STATUS_CODE_ERROR or span.name == "evidence.grade.bytes" or ${off}`,
      `delete_key(span.attributes, "langfuse.observation.output") where span.status.code == STATUS_CODE_ERROR or span.name == "evidence.grade.bytes" or ${off}`,
      /* langfuse.observation.(type|input|output), langfuse.version, llm.model_name, llm.token_count.*, gen_ai.usage.*, gen_ai.(request|response).model */
      'keep_matching_keys(span.attributes, "^(langfuse\\\\.observation\\\\.(type|input|output)|langfuse\\\\.version|llm\\\\.model_name|llm\\\\.token_count\\\\..+|gen_ai\\\\.usage\\\\..+|gen_ai\\\\.(request|response)\\\\.model)$$")',
    ]);
  });

  it("labels every span with the environment, and exports over OTLP/HTTP with Basic auth and the ingestion header", () => {
    expect(statementsOf("transform/langfuse-all")).toEqual(['set(span.attributes["langfuse.environment"], "${env:LANGFUSE_TRACING_ENVIRONMENT:-}")']);
    expect(collector).toContain(
      "\n  otlp_http/langfuse:\n    traces_endpoint: ${env:LANGFUSE_OTLP_ENDPOINT:-http://127.0.0.1:9}/v1/traces\n    auth:\n      authenticator: basicauth/langfuse\n",
    );
    expect(collector).toMatch(/\n {4}headers:\n {6}x-langfuse-ingestion-version: "4"\n/);
    expect(collector).toContain("\n  basicauth/langfuse:\n    client_auth:\n      username: ${env:LANGFUSE_PUBLIC_KEY:-unset}\n      password: ${env:LANGFUSE_SECRET_KEY:-unset}\n");
  });

  it("holds no key: the keys and the endpoint are the collector's environment, from infra/observability/.env alone", () => {
    const code = collector.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    expect(code).not.toMatch(/[ps]k-lf-|sk-[A-Za-z0-9]|Bearer /);
    expect(code).not.toMatch(/https:\/\//);
    const service = services.get("otel-collector") ?? "";
    expect(service).toMatch(/\n {4}env_file:\n {6}- path: \.\/infra\/observability\/\.env\n {8}required: false\n/);
    expect(service).not.toMatch(/LANGFUSE_/);
    expect(service).not.toContain("environment:");
    expect(service).toContain("\n    networks: [default, hb-internal]\n");
  });

  it("is configured from an example that names the five variables and holds no value", () => {
    const example = read("infra", "observability", ".env.example");
    const assigned = [...example.matchAll(/^([A-Z_]+)=(.*)$/gm)].map((match) => [match[1], match[2]]);
    expect(assigned).toEqual([
      ["LANGFUSE_PUBLIC_KEY", ""],
      ["LANGFUSE_SECRET_KEY", ""],
      ["LANGFUSE_OTLP_ENDPOINT", ""],
      ["LANGFUSE_TRACING_ENVIRONMENT", ""],
      ["LANGFUSE_MESSAGE_TEXT", ""],
    ]);
    /* the development project's region (D4) */
    expect(example).toContain("https://us.cloud.langfuse.com/api/public/otel");
    expect(read(".gitignore")).toMatch(/^\.env\*$/m);
  });
});

/** `GRANT SELECT (a, "b") ON "Table" TO hb_metrics;` as table → columns. */
function grantsOf(sql: string): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const match of sql.matchAll(/^GRANT SELECT \(([^)]+)\) ON "(\w+)" TO hb_metrics;$/gm)) {
    out.set(match[2] ?? "", new Set((match[1] ?? "").split(",").map((column) => column.trim().replace(/"/g, ""))));
  }
  return out;
}

describe("the dashboard's database role", () => {
  const grants = grantsOf(initSql);
  const statements = initSql.split("\n").filter((line) => !line.startsWith("--")).join("\n");

  it("is granted columns of the five activity tables and the three research views, by SELECT and by nothing else", () => {
    expect([...grants.keys()].sort()).toEqual(["BudgetLedger", "Conversation", "Flag", "Message", "ResearchFact", "ResearchFlag", "ResearchSpend", "SensorVerdict"]);
    const granting = statements.split("\n").filter((line) => line.startsWith("GRANT "));
    expect(granting.filter((line) => !line.startsWith("GRANT SELECT (") && line !== "GRANT USAGE ON SCHEMA public TO hb_metrics;")).toEqual([]);
    expect(statements).toContain("ALTER ROLE hb_metrics SET default_transaction_read_only = on;");
    expect(statements).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hb_metrics;");
    /* The password is set by the compose service from the environment, never written here. */
    expect(statements).not.toMatch(/PASSWORD/i);
  });

  it("cannot read a reader's words, a verdict's detail, an input, or anything of an account", () => {
    const all = [...grants.values()].flatMap((columns) => [...columns]);
    for (const column of ["text", "claimText", "modeResult", "aidInputs", "detail", "data", "email", "displayName", "keyCiphertext", "traceId", "contextLabel", "payload", "ref", "actor", "organisationId"]) expect(all).not.toContain(column);
    /* research is read through its three views alone: no table of a reader's research, no ledger (feature-specs/44 § 4, § 8.3; 48 § 11.7) */
    for (const table of ["ResearchRun", "ResearchFinding", "ProposalEndorsement", "LedgerRecord"]) expect(grants.has(table), table).toBe(false);
  });

  it.each([...SERIES.map((series) => ({ name: series.name, sql: () => seriesSql(series.name) })), ...RESEARCH_SERIES.map((series) => ({ name: `research/${series.name}`, sql: () => researchSql(series.name) }))].map((entry) => [entry.name, entry.sql] as const))("may read every column %s reads", (name, sqlOf) => {
    const code = sqlOf().split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    const tableOf = new Map([...code.matchAll(/(?:FROM|JOIN) "(\w+)" (\w+)\b/g)].map((match) => [match[2] ?? "", match[1] ?? ""]));
    expect(tableOf.size).toBeGreaterThan(0);
    const read: string[] = [];
    for (const match of code.matchAll(/\b(\w+)\.(?:"(\w+)"|(\w+))/g)) {
      const table = tableOf.get(match[1] ?? "");
      if (table !== undefined) read.push(`${table}.${match[2] ?? match[3] ?? ""}`);
    }
    expect(read.length).toBeGreaterThan(0);
    for (const reference of new Set(read)) {
      const [table, column] = reference.split(".");
      expect(grants.get(table ?? "")?.has(column ?? ""), `${reference} is read by ${name}.sql and not granted in init.sql`).toBe(true);
    }
  });
});

describe("Grafana's sources", () => {
  it("are the three, each with the uid a dashboard names, and PostgreSQL is the application database as hb_metrics", () => {
    expect([...datasources.matchAll(/\n {4}uid: (\S+)\n {4}type: (\S+)\n/g)].map((match) => `${match[1] ?? ""} ${match[2] ?? ""}`)).toEqual([
      "hb-postgres grafana-postgresql-datasource",
      "hb-tempo tempo",
      "hb-loki loki",
    ]);
    expect(datasources).toMatch(/\n {4}url: db:5432\n {4}user: hb_metrics\n {4}jsonData:\n {6}database: harness_bible\n/);
    expect(datasources).toContain("url: http://tempo:3200");
    expect(datasources).toContain("url: http://loki:3100");
    expect([...datasources.matchAll(/editable: (\w+)/g)].map((match) => match[1])).toEqual(["false", "false", "false"]);
  });
});

describe("the generated dashboard and alert rules", () => {
  const dashboard = read("infra", "observability", "grafana", "dashboards", "assistant.json");
  const alerts = read("infra", "observability", "grafana", "provisioning", "alerting", "alerts.json");

  const researchBoard = read("infra", "observability", "grafana", "dashboards", "research.json");
  const researchRules = read("infra", "observability", "grafana", "provisioning", "alerting", "research.json");

  it("are, in the repository, exactly what the statements produce: run `npm run observe:generate` after changing one", () => {
    const output = generated();
    expect(dashboard).toBe(output.dashboard);
    expect(alerts).toBe(output.alerts);
    /* the researcher's dashboard and its rule (feature-specs/44 § 4) */
    const research = generatedResearch();
    expect(researchBoard).toBe(research.dashboard);
    expect(researchRules).toBe(research.alerts);
  });

  it("name only the sources Grafana is provisioned with", () => {
    const provisioned = new Set([...datasources.matchAll(/\n {4}uid: (\S+)\n/g)].map((match) => match[1] ?? ""));
    const named = new Set([...`${dashboard}${alerts}${researchBoard}${researchRules}`.matchAll(/"(?:uid|datasourceUid)": "(hb-[a-z0-9-]+|__expr__)"/g)].map((match) => match[1] ?? ""));
    /* The dashboards' own uids and the rules' are not sources. */
    for (const own of ["hb-assistant", "hb-first-token-p95", "hb-refusal-rate", "hb-citation-rate", "hb-purge-absent", "hb-secret-detected", "hb-research", "hb-research-cap"]) named.delete(own);
    expect([...named].sort()).toEqual(["__expr__", "hb-loki", "hb-postgres"]);
    for (const uid of named) if (uid !== "__expr__") expect(provisioned.has(uid), uid).toBe(true);
  });

  it("reach Grafana where its provisioning looks: the dashboards folder the provider names, and the alerting folder", () => {
    const provider = read("infra", "observability", "grafana", "provisioning", "dashboards", "dashboards.yaml");
    expect(provider).toContain("      path: /var/lib/grafana/dashboards\n");
    expect(provider).toContain("    allowUiUpdates: false\n");
    const grafana = services.get("grafana") ?? "";
    expect(grafana).toContain("./infra/observability/grafana/dashboards:/var/lib/grafana/dashboards:ro");
    for (const folder of ["datasources", "dashboards", "alerting"]) {
      expect(grafana).toContain(`./infra/observability/grafana/provisioning/${folder}:/etc/grafana/provisioning/${folder}:ro`);
    }
  });
});
