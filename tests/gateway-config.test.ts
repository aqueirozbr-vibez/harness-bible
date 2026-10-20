import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aliasesFromConfig } from "@/infra/gateway/stub/server";
import { ALIAS_PINS, EMBED_TARGET, MODEL_PRICES } from "@/lib/gateway/prices";

/*
 * The gateway as code (feature-specs/11 § 3, § 9, § 12.6): the four aliases map to the pinned ids, every key in
 * LiteLLM's configuration is an environment reference, the image is pinned, and no provider key name reaches the
 * application's folders. The files are read as text: the configuration is small and a YAML parser is not a
 * dependency the architecture lists.
 */

const root = join(import.meta.dirname, "..");
const litellm = readFileSync(join(root, "infra", "gateway", "litellm.yaml"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
const dockerfile = readFileSync(join(root, "infra", "workers", "Dockerfile"), "utf8");

/**
 * The aliases lib/gateway/prices.ts prices: the two that go through `/v1/messages`. `hb-embed` and `hb-rerank` are
 * pinned without a price because Voyage's published per-token rates are owed (feature-specs/12 § 3, BLOCKED).
 */
const MESSAGES_ALIASES = ["hb-frontier", "hb-small"] as const;

/** The alias table of feature-specs/11 § 3.2, in its order. */
const ALIASES: ReadonlyArray<readonly [alias: string, target: string]> = [
  ["hb-frontier", "anthropic/claude-opus-5"],
  ["hb-small", "anthropic/claude-haiku-4-5"],
  ["hb-embed", "infinity/BAAI/bge-m3"],
  ["hb-rerank", "infinity/BAAI/bge-reranker-base"],
];

function values(text: string, key: string): ReadonlyArray<string> {
  return [...text.matchAll(new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(\\S+)\\s*$`, "gm"))].map((m) => m[1]);
}

/** One service's block of docker-compose.yml, from its name to the next top-level key. */
function service(name: string): string {
  const block = compose.match(new RegExp(`^  ${name}:\\n(?:(?:    .*|\\s*)\\n)*`, "m"));
  expect(block, name).not.toBeNull();
  return (block as RegExpMatchArray)[0];
}

function filesUnder(dir: string): ReadonlyArray<string> {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes("generated"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("infra/gateway/litellm.yaml", () => {
  it("names the four aliases in the spec's order", () => {
    expect(values(litellm, "model_name")).toEqual(ALIASES.map(([alias]) => alias));
  });

  it("pins each alias to its target", () => {
    expect(values(litellm, "model")).toEqual(ALIASES.map(([, target]) => target));
    // The string Section.embeddingModel stores is this file's target for hb-embed (feature-specs/12 § 3, § 4.2).
    expect(EMBED_TARGET).toBe(ALIASES.find(([alias]) => alias === "hb-embed")?.[1]);
  });

  it("holds keys as environment references only", () => {
    const keys = values(litellm, "api_key");
    expect(keys).toHaveLength(ALIASES.length);
    expect(keys.every((key) => key.startsWith("os.environ/"))).toBe(true);
    expect(values(litellm, "master_key")).toEqual(["os.environ/LITELLM_MASTER_KEY"]);
  });

  it("pins every alias lib/gateway/prices.ts names to the same id, and prices the messages aliases (§ 3.2)", () => {
    const pinned = aliasesFromConfig(litellm);
    for (const [alias, pin] of Object.entries(ALIAS_PINS)) {
      expect(pinned.get(alias), alias).toBe(pin);
    }
    // A pin change in the YAML without the matching prices.ts edit fails here, not at the first call.
    for (const alias of MESSAGES_ALIASES) {
      expect(MODEL_PRICES[ALIAS_PINS[alias] as string], alias).toBeDefined();
    }
    expect([...pinned.keys()].filter((alias) => MODEL_PRICES[pinned.get(alias) as string] !== undefined)).toEqual([...MESSAGES_ALIASES]);
  });

  it("carries no key literal", () => {
    for (const file of ["infra/gateway/litellm.yaml", "infra/gateway/.env.example", "docker-compose.yml", ".env.example", "infra/workers/Dockerfile", "infra/observability/.env.example"]) {
      expect(readFileSync(join(root, file), "utf8")).not.toMatch(/sk-[A-Za-z0-9]/);
    }
  });
});

describe("docker-compose.yml gateway service", () => {
  it("pins the LiteLLM image by digest", () => {
    const image = compose.match(/^\s*image:\s*(ghcr\.io\/berriai\/litellm:\S+)\s*$/m)?.[1];
    expect(image).toMatch(/^ghcr\.io\/berriai\/litellm:[^@\s]+@sha256:[0-9a-f]{64}$/);
  });

  it("mounts the configuration read-only and reads the master key from the environment", () => {
    expect(compose).toContain("./infra/gateway/litellm.yaml:/app/config.yaml:ro");
    expect(compose).toMatch(/LITELLM_MASTER_KEY: \$\{LITELLM_MASTER_KEY:\?/);
  });

  it("publishes the proxy on the loopback interface alone (§ 8: http://localhost:4000)", () => {
    expect(service("gateway")).toContain('- "127.0.0.1:4000:4000"');
    expect(compose).not.toMatch(/^\s*- "4000:4000"$/m);
  });
});

/*
 * No road to Langfuse from the gateway (feature-specs/49 § 4, § 5.2; unit 79): the collector alone holds the Langfuse
 * keys. Compose's `environment` overrides `env_file`, and both of LiteLLM's Langfuse loggers read an empty value as
 * unset, so the blanks close the road whatever infra/gateway/.env still holds, the `langfuse` callback's "upstream"
 * client's three included; and the example no longer asks for a Langfuse key.
 */
describe("the gateway's Langfuse variables (49 § 4; unit 79)", () => {
  const BLANKED = [
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_HOST",
    "LANGFUSE_OTEL_HOST",
    "UPSTREAM_LANGFUSE_PUBLIC_KEY",
    "UPSTREAM_LANGFUSE_SECRET_KEY",
    "UPSTREAM_LANGFUSE_HOST",
  ];

  it("are blank in every definition of the gateway service in the repository", () => {
    /* Every file that runs the gateway's image: a second definition fails here until it blanks them too. */
    const definitions = [...filesUnder(join(root, "infra")), ...readdirSync(root).filter((name) => /\.ya?ml$/.test(name)).map((name) => join(root, name))].filter(
      (file) => /\.ya?ml$/.test(file) && /^\s*image:\s*ghcr\.io\/berriai\/litellm:/m.test(readFileSync(file, "utf8")),
    );
    expect(definitions.map((file) => file.slice(root.length + 1).replace(/\\/g, "/"))).toEqual(["docker-compose.yml"]);
    const environment = service("gateway").replace(/\r\n/g, "\n").match(/\n {4}environment:\n((?: {6}.*\n)*)/)?.[1] ?? "";
    for (const name of BLANKED) expect(environment, name).toMatch(new RegExp(`^ {6}${name}: ""$`, "m"));
    expect(environment.match(/^ {6}\w*LANGFUSE_\w+:/gm)).toHaveLength(BLANKED.length);
  });

  it("are not in infra/gateway/.env.example, which says where they live now", () => {
    const example = readFileSync(join(root, "infra", "gateway", ".env.example"), "utf8");
    expect(example).not.toContain("LANGFUSE_");
    expect(example).toContain("infra/observability/.env");
  });
});

/*
 * The workers container (feature-specs/11 § 7.1): no published port, the internal network alone, and the image
 * of infra/workers/Dockerfile, which runs the entry point of `npm run workers`.
 */
describe("docker-compose.yml workers service", () => {
  const workers = service("workers");

  it("builds from infra/workers/Dockerfile", () => {
    expect(workers).toContain("dockerfile: infra/workers/Dockerfile");
    expect(dockerfile).toMatch(/CMD \["npx", "tsx", "workers\/main\.ts"\]/);
  });

  it("publishes no port and sits on the internal network alone", () => {
    expect(workers).not.toContain("ports:");
    expect(workers).toContain("networks: [hb-internal]");
    expect(compose).toMatch(/^ {2}hb-internal:\n {4}internal: true$/m);
  });

  it("holds the two secrets of § 8 and reads every one of them from the environment", () => {
    for (const name of ["WORKERS_TOKEN", "GATEWAY_KEY_SECRET", "LITELLM_MASTER_KEY"]) {
      expect(workers, name).toContain(`${name}: \${${name}:?`);
    }
  });
});

describe("the application's folders", () => {
  it("never name a provider key (feature-specs/11 § 12.6)", () => {
    for (const dir of ["lib", "app", "components"]) {
      for (const file of filesUnder(join(root, dir))) {
        expect(readFileSync(file, "utf8"), file).not.toContain("ANTHROPIC_API_KEY");
      }
    }
  });
});

/*
 * The gateway's logging (feature-specs/45 D6; unit 64): no message body leaves the gateway for a callback. LiteLLM
 * redacts the messages, the prompt and the response before Langfuse while `turn_off_message_logging` is set under
 * `litellm_settings`, on success and on failure. A single request may still turn that off, by the header
 * `litellm-disable-message-redaction` or the parameter `turn_off_message_logging`, so nothing of the application may
 * send either.
 */
describe("the gateway's logging (45 D6; unit 64)", () => {
  it("sends Langfuse spans and costs, and no message body", () => {
    const settings = litellm.match(/^litellm_settings:\n((?: {2}.*\n|\s*\n)*)/m)?.[1] ?? "";
    expect(values(settings, "turn_off_message_logging")).toEqual(["true"]);
    expect(values(settings, "success_callback")).toEqual(['["langfuse"]']);
    expect(values(settings, "failure_callback")).toEqual(['["langfuse"]']);
    /* and no prompt in the gateway's own spend logs, whose default is off */
    expect(litellm).not.toMatch(/store_prompts_in_spend_logs:\s*true/);
  });

  it("is never turned off by a request: nothing of the application sends the header or the parameter that would", () => {
    const sources = ["lib", "workers", "app", "components", "scripts"].flatMap((dir) => filesUnder(join(root, dir))).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
    expect(sources.filter((file) => /message-redaction|turn_off_message_logging/i.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
