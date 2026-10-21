import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PRODUCT_LANGFUSE_KEYS } from "@/lib/telemetry/langfuse";

import { ACTIVITY_SPAN, ANSWER, ANSWER_SPAN, CLASSIFY_SPAN, collectorFixture, TURN_TAGS, DOCUMENT, DRAFT_SPAN, EMAIL, EMBED_SPAN, FOREIGN_HOST, FOREIGN_OWNER, FOREIGN_SERVICE, FOREIGN_SPANS, PRINCIPAL, QUESTION, RETRIEVE_SPAN, TRACE, USER, WORKERS_REQUEST } from "./fixtures/collector";

/*
 * The collector's road to Langfuse, run (feature-specs/49 § 9.5; unit 79). The pinned collector image runs the
 * committed infra/observability/otel-collector.yaml over recorded spans, with no network at all (`--network none`):
 * a second configuration file swaps its receivers and exporters, OTLP/JSON fixture files in and one `file` exporter
 * out per pipeline, and leaves its processors, the pipelines' processor lists and the auth extension as committed.
 * Five configurations, each a container with its own test values; infra/observability/.env is never mounted.
 *
 * Only with HB_COLLECTOR_TEST=1, and then Docker must answer: the builder runs it in each unit that touches the
 * collector. `npm test` without the variable skips it, as the database suites skip without a database.
 */

const enabled = process.env.HB_COLLECTOR_TEST === "1";
const root = join(import.meta.dirname, "..");
const exec = promisify(execFile);

/** The second configuration: what goes in and what comes out, nothing of what happens between. */
const OVERLAY = `receivers:
  otlp_json_file:
    include: [/in/*.json]
    start_at: beginning
    include_file_name: false
exporters:
  file/tempo:
    path: /out/tempo.json
  file/langfuse:
    path: /out/langfuse.json
  file/lines:
    path: /out/lines.json
service:
  extensions: [basicauth/langfuse]
  pipelines:
    traces:
      receivers: [otlp_json_file]
      exporters: [file/tempo]
    traces/langfuse:
      receivers: [otlp_json_file]
      exporters: [file/langfuse]
    logs:
      receivers: [otlp_json_file]
      exporters: [file/lines]
`;

const US = "https://us.cloud.langfuse.com/api/public/otel";

/** The five configurations of § 9.5; a variable left out is unset in the container. */
const CONFIGURATIONS = {
  off: { LANGFUSE_OTLP_ENDPOINT: US, LANGFUSE_TRACING_ENVIRONMENT: "development", LANGFUSE_MESSAGE_TEXT: "off" },
  on: { LANGFUSE_OTLP_ENDPOINT: US, LANGFUSE_TRACING_ENVIRONMENT: "development", LANGFUSE_MESSAGE_TEXT: "on" },
  /* every value set and empty, as a copied example leaves them: the collector must still start, and send nothing */
  "no-endpoint": { LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "", LANGFUSE_OTLP_ENDPOINT: "", LANGFUSE_TRACING_ENVIRONMENT: "development", LANGFUSE_MESSAGE_TEXT: "on" },
  /* not a Cloud endpoint, so only the environment's own condition can stop it: a self-hosted Langfuse unlabelled */
  "no-environment": { LANGFUSE_OTLP_ENDPOINT: "https://langfuse.example.test/api/public/otel", LANGFUSE_MESSAGE_TEXT: "on" },
  /* a host name ignores case, and so must the Cloud check */
  "cloud-production": { LANGFUSE_OTLP_ENDPOINT: "https://US.Cloud.Langfuse.com/api/public/otel", LANGFUSE_TRACING_ENVIRONMENT: "production", LANGFUSE_MESSAGE_TEXT: "on" },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

type Configuration = keyof typeof CONFIGURATIONS;

interface Span {
  readonly service: string;
  readonly resource: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: number;
  readonly status: number;
}

interface Outputs {
  readonly tempo: ReadonlyArray<Span>;
  readonly langfuse: ReadonlyArray<Span>;
}

interface OtlpKeyValue {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}

function valueOf(value: Readonly<Record<string, unknown>>): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value) return ((value.arrayValue as { values?: ReadonlyArray<{ stringValue?: string }> }).values ?? []).map((item) => item.stringValue);
  return value;
}

function record(list: ReadonlyArray<OtlpKeyValue> | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((entry) => [entry.key, valueOf(entry.value)]));
}

interface OtlpLine {
  readonly resourceSpans?: ReadonlyArray<{
    readonly resource?: { readonly attributes?: ReadonlyArray<OtlpKeyValue> };
    readonly scopeSpans?: ReadonlyArray<{
      readonly spans?: ReadonlyArray<{
        readonly traceId: string;
        readonly spanId: string;
        readonly parentSpanId?: string;
        readonly name: string;
        readonly attributes?: ReadonlyArray<OtlpKeyValue>;
        readonly events?: ReadonlyArray<unknown>;
        readonly status?: { readonly code?: number };
      }>;
    }>;
  }>;
}

/** A `file` exporter's output: one OTLP/JSON request a line. */
function spansIn(path: string): ReadonlyArray<Span> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) =>
      ((JSON.parse(line) as OtlpLine).resourceSpans ?? []).flatMap((resourceSpans) => {
        const resource = record(resourceSpans.resource?.attributes);
        return (resourceSpans.scopeSpans ?? []).flatMap((scope) =>
          (scope.spans ?? []).map((span) => ({
            service: String(resource["service.name"]),
            resource,
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId ?? "",
            attributes: record(span.attributes),
            events: span.events?.length ?? 0,
            status: span.status?.code ?? 0,
          })),
        );
      }),
    );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The product's spans in the fixture: Tempo receives every one of them, and none of the gateway's. */
const PRODUCT_SPANS = (JSON.parse(collectorFixture()) as OtlpLine).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length ?? 0;
const product = (spans: ReadonlyArray<Span>): ReadonlyArray<Span> => spans.filter((span) => span.service === "hb-workers");
/** Who may be on the Langfuse road at all: the product's services and the gateway. */
const SENDERS = new Set(["hb-web", "hb-workers", "hb-jobs", "hb-gateway"]);
/** What the two foreign senders carry, and what must therefore never be sent. */
const FOREIGN_WORDS = [FOREIGN_SERVICE, FOREIGN_HOST, FOREIGN_OWNER, "search?q", "failed on"];

describe.skipIf(!enabled)("the collector's road to Langfuse, run in the pinned image (49 § 9.5)", () => {
  const outputs = new Map<Configuration, Outputs>();
  const containers: string[] = [];
  let dir = "";

  async function docker(args: ReadonlyArray<string>): Promise<string> {
    return (await exec("docker", [...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  }

  /** One configuration: a container with its own test values, stopped once Tempo has every product span, then read. */
  async function run(name: Configuration, image: string): Promise<void> {
    const out = join(dir, name);
    mkdirSync(out);
    /* the image's user is 10001, not the test's */
    chmodSync(out, 0o777);
    const container = `hb-collector-test-${String(process.pid)}-${name}`;
    containers.push(container);
    const variables = Object.entries(CONFIGURATIONS[name]).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    await docker([
      "run",
      "-d",
      "--name",
      container,
      "--network",
      "none",
      ...variables,
      "--mount",
      `type=bind,source=${join(root, "infra", "observability", "otel-collector.yaml")},target=/c.yaml,readonly`,
      "--mount",
      `type=bind,source=${join(dir, "overlay.yaml")},target=/o.yaml,readonly`,
      "--mount",
      `type=bind,source=${join(dir, "in")},target=/in,readonly`,
      "--mount",
      `type=bind,source=${out},target=/out`,
      image,
      "--config",
      "/c.yaml",
      "--config",
      "/o.yaml",
    ]);
    const deadline = Date.now() + 60_000;
    while (product(spansIn(join(out, "tempo.json"))).length < PRODUCT_SPANS) {
      if (Date.now() > deadline) {
        const logs = await exec("docker", ["logs", "--tail", "40", container]).then((result) => `${result.stdout}${result.stderr}`, () => "");
        throw new Error(`the collector (${name}) did not pass the fixture to Tempo within 60 s:\n${logs}`);
      }
      await sleep(250);
    }
    /* a stop drains every pipeline, the Langfuse one included, before the process exits */
    await docker(["stop", "-t", "15", container]);
    outputs.set(name, { tempo: spansIn(join(out, "tempo.json")), langfuse: spansIn(join(out, "langfuse.json")) });
  }

  beforeAll(async () => {
    await docker(["version", "--format", "{{.Server.Version}}"]).catch((error: unknown) => {
      throw new Error(`HB_COLLECTOR_TEST=1 needs Docker, which did not answer: ${error instanceof Error ? error.message : String(error)}`);
    });
    /* the image compose pins, by digest */
    const image = /\n {2}otel-collector:\n(?: {4}.*\n|\s*\n)*? {4}image: (\S+)\n/.exec(readFileSync(join(root, "docker-compose.yml"), "utf8").replace(/\r\n/g, "\n"))?.[1];
    expect(image).toMatch(/^otel\/opentelemetry-collector-contrib:[\d.]+@sha256:[0-9a-f]{64}$/);
    dir = mkdtempSync(join(tmpdir(), "hb-collector-"));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "turn.json"), `${collectorFixture()}\n`);
    writeFileSync(join(dir, "overlay.yaml"), OVERLAY);
    await Promise.all((Object.keys(CONFIGURATIONS) as Configuration[]).map((name) => run(name, image ?? "")));
  }, 180_000);

  afterAll(async () => {
    for (const container of containers) await exec("docker", ["rm", "-f", container]).catch(() => undefined);
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  const output = (name: Configuration): Outputs => {
    const found = outputs.get(name);
    expect(found, name).toBeDefined();
    return found as Outputs;
  };
  const byName = (spans: ReadonlyArray<Span>, name: string): Span => {
    const found = spans.find((span) => span.name === name);
    expect(found, name).toBeDefined();
    return found as Span;
  };

  /** What may be on a gateway span on the road: the anchored pattern of § 5.5, and the environment. */
  const GATEWAY_KEY = /^(langfuse\.observation\.(type|input|output)|langfuse\.version|llm\.model_name|llm\.token_count\..+|gen_ai\.usage\..+|gen_ai\.(request|response)\.model|langfuse\.environment)$/;
  const PRODUCT_KEYS = new Set<string>([...PRODUCT_LANGFUSE_KEYS, "langfuse.environment"]);

  it.each(Object.keys(CONFIGURATIONS) as Configuration[])("%s: Tempo receives every product span as it was, and no gateway span", (name) => {
    const { tempo } = output(name);
    expect(tempo.filter((span) => span.service === "hb-gateway")).toEqual([]);
    expect(product(tempo)).toHaveLength(PRODUCT_SPANS);
    /* a foreign sender's spans stay on this machine, in Tempo, as they came */
    expect(tempo.filter((span) => !SENDERS.has(span.service))).toHaveLength(FOREIGN_SPANS);
    /* the marked span keeps its parent and its mark in Tempo; the principal stays a fact of Tempo's (21 § 5.1) */
    for (const id of [CLASSIFY_SPAN, DRAFT_SPAN, RETRIEVE_SPAN, ANSWER_SPAN, EMBED_SPAN]) {
      expect(tempo.find((span) => span.spanId === id), id).toMatchObject({ parentSpanId: WORKERS_REQUEST, attributes: { "hb.parent": "request" } });
    }
    expect(tempo.find((span) => span.spanId === DRAFT_SPAN)?.attributes["hb.principal"]).toBe(PRINCIPAL);
    expect(tempo.map((span) => span.name)).toContain("http.request");
    /* a research's outcome ask, which the Langfuse road drops, stays in Tempo (49 § 28) */
    expect(tempo.map((span) => span.name)).toContain("activity.findingOutcomes");
  });

  describe("the collector's half off", () => {
    it("sends the agents' work and nothing else: no request, no job, no release embedding, no span of the proxy's own", () => {
      const { langfuse } = output("off");
      expect(langfuse.map((span) => `${span.service} ${span.name}`).sort()).toEqual([
        "hb-gateway assistant.classify",
        "hb-gateway assistant.draft",
        "hb-gateway assistant.grade",
        "hb-gateway embed.query",
        "hb-gateway evidence.grade.bytes",
        "hb-gateway researcher.read",
        "hb-workers activity.planResearch",
        "hb-workers assistant.answer",
        "hb-workers assistant.classify",
        "hb-workers assistant.draft",
        "hb-workers assistant.retrieve",
        "hb-workers embed.query",
        "hb-workers sensor.citation",
      ]);
      expect(langfuse.every((span) => span.traceId === TRACE)).toBe(true);
    });

    it("makes the marked product spans roots, and keeps each generation under its call's span", () => {
      const { langfuse } = output("off");
      for (const span of langfuse.filter((candidate) => candidate.service === "hb-workers")) expect(span.parentSpanId, span.name).toBe("");
      expect(langfuse.find((span) => span.service === "hb-gateway" && span.name === "assistant.draft")?.parentSpanId).toBe(DRAFT_SPAN);
      expect(langfuse.find((span) => span.service === "hb-gateway" && span.name === "assistant.classify")?.parentSpanId).toBe(CLASSIFY_SPAN);
    });

    it("carries no text, no event, no identity, and no resource but the sender's name", () => {
      const { langfuse } = output("off");
      for (const span of langfuse) {
        expect(span.events, span.name).toBe(0);
        expect(span.attributes, span.name).not.toHaveProperty("langfuse.observation.input");
        expect(span.attributes, span.name).not.toHaveProperty("langfuse.observation.output");
        expect(span.attributes["langfuse.environment"], span.name).toBe("development");
        expect(span.resource, span.name).toEqual({ "service.name": span.service });
      }
      for (const span of langfuse.filter((candidate) => candidate.service === "hb-gateway")) {
        expect(Object.keys(span.attributes).filter((key) => !GATEWAY_KEY.test(key)), span.name).toEqual([]);
      }
      /* every product span reduced to its list: no principal, subject, path, usage or mark */
      for (const span of langfuse.filter((candidate) => candidate.service === "hb-workers")) {
        expect(Object.keys(span.attributes).filter((key) => !PRODUCT_KEYS.has(key)), span.name).toEqual([]);
      }
      const sent = langfuse.map((span) => JSON.stringify(span)).join("\n");
      for (const word of [QUESTION, ANSWER, PRINCIPAL, USER, EMAIL, DOCUMENT, "requester", "user_api_key", "invocation_parameters", "production", "harness-bible"]) expect(sent).not.toContain(word);
    });

    it("sends nothing of a sender that is not the product's or the gateway's, named or not", () => {
      const { langfuse } = output("off");
      expect(langfuse.filter((span) => !SENDERS.has(span.service))).toEqual([]);
      const sent = langfuse.map((span) => JSON.stringify(span)).join("\n");
      for (const word of FOREIGN_WORDS) expect(sent).not.toContain(word);
    });

    it("carries the turn's tags as a list, the release, and a failing sensor as a guardrail at level WARNING (unit 83)", () => {
      /* every product span of the turn's own; a legacy research's activity in the turn's trace sets none (unit 84) */
      const product = output("off").langfuse.filter((span) => span.service === "hb-workers" && !span.name.startsWith("activity."));
      for (const span of product) {
        expect(span.attributes["langfuse.trace.tags"], span.name).toEqual(TURN_TAGS);
        expect(span.attributes["langfuse.trace.name"], span.name).toBe("assistant.turn");
        expect(span.attributes["langfuse.release"], span.name).toBe("2026.09");
      }
      expect(byName(product, "sensor.citation")).toMatchObject({ status: 0, attributes: { "langfuse.observation.type": "guardrail", "langfuse.observation.level": "WARNING", "hb.sensor.result": "FAIL", "hb.sensor.substituted": 1 } });
      expect(byName(product, "assistant.answer").attributes["langfuse.observation.type"]).toBe("agent");
    });

    it("sends a legacy research's activity as a root with its workflow, attempt and mark and no trace attribute, and no outcome ask (unit 84)", () => {
      const { langfuse } = output("off");
      const activity = langfuse.find((span) => span.spanId === ACTIVITY_SPAN);
      expect(activity).toMatchObject({ name: "activity.planResearch", parentSpanId: "", attributes: { "hb.workflow.type": "ResearchWorkflow", "hb.workflow.id": "research:5f0c2a1e-0000-4000-8000-0000000000c1", "hb.activity.attempt": 1, "hb.outcome": "ok", "hb.legacy": true, "hb.research.run_id": "5f0c2a1e-0000-4000-8000-0000000000c2" } });
      expect(Object.keys(activity?.attributes ?? {}).filter((key) => key.startsWith("langfuse.trace.") || key === "langfuse.release")).toEqual([]);
      expect(langfuse.map((span) => span.name)).not.toContain("activity.findingOutcomes");
    });

    it("names each generation for its agent, types an embedding, and gives Langfuse its cost", () => {
      const gateway = output("off").langfuse.filter((span) => span.service === "hb-gateway");
      expect(byName(gateway, "assistant.draft").attributes).toMatchObject({ "langfuse.observation.type": "generation", "langfuse.version": "v1.13", "llm.model_name": "claude-opus-5", "llm.token_count.prompt": 1200, "gen_ai.usage.cost": 0.014 });
      expect(byName(gateway, "embed.query").attributes["langfuse.observation.type"]).toBe("embedding");
      expect(byName(gateway, "researcher.read").status).toBe(2);
      /* every product call's span reads as its agent, its generation's name too (unit 81) */
      expect(output("off").langfuse.find((span) => span.service === "hb-workers" && span.spanId === CLASSIFY_SPAN)?.name).toBe("assistant.classify");
      expect(output("off").langfuse.find((span) => span.service === "hb-workers" && span.spanId === DRAFT_SPAN)?.name).toBe("assistant.draft");
    });
  });

  describe("the collector's half on", () => {
    it("lets a successful generation's prompt and answer through", () => {
      const draft = byName(output("on").langfuse.filter((span) => span.service === "hb-gateway"), "assistant.draft");
      expect(String(draft.attributes["langfuse.observation.input"])).toContain(QUESTION);
      expect(String(draft.attributes["langfuse.observation.output"])).toContain(ANSWER);
    });

    it("never a failed call's, the evidence bytes row's, an event, or an identity", () => {
      const { langfuse } = output("on");
      const gateway = langfuse.filter((span) => span.service === "hb-gateway");
      for (const name of ["researcher.read", "evidence.grade.bytes"]) {
        expect(byName(gateway, name).attributes, name).not.toHaveProperty("langfuse.observation.input");
        expect(byName(gateway, name).attributes, name).not.toHaveProperty("langfuse.observation.output");
      }
      for (const span of langfuse) expect(span.events, span.name).toBe(0);
      for (const span of gateway) expect(Object.keys(span.attributes).filter((key) => !GATEWAY_KEY.test(key)), span.name).toEqual([]);
      for (const span of langfuse.filter((candidate) => candidate.service === "hb-workers")) expect(Object.keys(span.attributes).filter((key) => !PRODUCT_KEYS.has(key)), span.name).toEqual([]);
      /* the question goes once, in the draft's input, and nowhere else: not in the failure's, not in an error */
      const sent = langfuse.filter((span) => span.name !== "assistant.draft" || span.service !== "hb-gateway").map((span) => JSON.stringify(span)).join("\n");
      for (const word of [QUESTION, ANSWER, PRINCIPAL, USER, EMAIL, DOCUMENT]) expect(sent).not.toContain(word);
      /* nor anything of a foreign sender's, the question in its span name and status included */
      expect(langfuse.filter((span) => !SENDERS.has(span.service))).toEqual([]);
      const all = langfuse.map((span) => JSON.stringify(span)).join("\n");
      for (const word of FOREIGN_WORDS) expect(all).not.toContain(word);
    });
  });

  it.each(["no-endpoint", "no-environment", "cloud-production"] as const)("%s: sends nothing to Langfuse, and Tempo works as before", (name) => {
    expect(output(name).langfuse).toEqual([]);
    expect(product(output(name).tempo)).toHaveLength(PRODUCT_SPANS);
  });
});
