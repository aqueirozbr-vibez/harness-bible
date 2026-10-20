import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TemporalAddressSchema, TemporalNamespaceSchema } from "@/lib/schemas/workflows";

import { servicesOf } from "./fixtures/compose";

/*
 * The workflow engine as code (feature-specs/28 § 3, unit 45a): what the compose file starts, where it listens and
 * what it is pinned to. These read the repository's own files, as the observability suite does; that the engine
 * runs, keeps its state across a restart and leaves the product's database alone is checked by running it
 * (the unit's verification, in the tracker).
 */

const root = join(import.meta.dirname, "..");
/* Line endings as `\n` whatever the checkout wrote: every pattern below is written against them. */
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8").replace(/\r\n/g, "\n");

const services = servicesOf(read("docker-compose.yml"));
const block = (name: string): string => services.get(name) ?? "";
const imageOf = (name: string): string => /\n {4}image: (\S+)\n/.exec(`\n${block(name)}`)?.[1] ?? "";
const portsOf = (name: string): ReadonlyArray<string> => [...block(name).matchAll(/^ {6}- "([^"]+:\d+:\d+)"$/gm)].map((match) => match[1] ?? "");
const ENGINE = ["temporal-schema", "temporal", "temporal-namespace"];
const PINNED = /^temporalio\/[a-z-]+:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/;

describe("the workflow engine in the compose file", () => {
  it("is three services a plain `up` starts and a UI that only its own profile does", () => {
    for (const name of ENGINE) {
      expect(services.has(name), name).toBe(true);
      expect(block(name)).not.toContain("profiles:");
    }
    expect(block("temporal-ui")).toContain('profiles: ["workflows-ui"]');
  });

  it("pins every image by digest, the server and its admin tools to one version", () => {
    for (const name of [...ENGINE, "temporal-ui"]) expect(imageOf(name), name).toMatch(PINNED);
    const version = (name: string) => PINNED.exec(imageOf(name))?.[1];
    expect(imageOf("temporal")).toMatch(/^temporalio\/server:/);
    expect(imageOf("temporal-schema")).toMatch(/^temporalio\/admin-tools:/);
    expect(imageOf("temporal-namespace")).toBe(imageOf("temporal-schema"));
    expect(version("temporal-schema")).toBe(version("temporal"));
  });

  it("publishes the frontend and the UI on the loopback alone, and nothing else", () => {
    expect(portsOf("temporal")).toEqual(["127.0.0.1:7233:7233"]);
    expect(portsOf("temporal-ui")).toEqual(["127.0.0.1:8233:8080"]);
    expect(block("temporal-schema")).not.toContain("ports:");
    expect(block("temporal-namespace")).not.toContain("ports:");
  });

  it("keeps the two steps that run once on the internal network, and the server reachable from it", () => {
    expect(block("temporal-schema")).toContain("networks: [hb-internal]");
    expect(block("temporal-namespace")).toContain("networks: [hb-internal]");
    expect(block("temporal")).toContain("networks: [default, hb-internal]");
  });

  it("starts in order: the schema to completion, then the server until healthy, then the namespace", () => {
    expect(block("temporal")).toMatch(/depends_on:\n {6}temporal-schema:\n {8}condition: service_completed_successfully\n/);
    expect(block("temporal-namespace")).toMatch(/depends_on:\n {6}temporal:\n {8}condition: service_healthy\n/);
    expect(block("temporal")).toContain("healthcheck:");
  });

  it("is named to the workers container, which waits for the namespace before it starts polling", () => {
    expect(block("workers")).toContain("TEMPORAL_ADDRESS: temporal:7233");
    expect(block("workers")).toContain("TEMPORAL_NAMESPACE: ${TEMPORAL_NAMESPACE:-harness-bible}");
    expect(block("workers")).toMatch(/temporal-namespace:\n {8}condition: service_completed_successfully\n/);
    expect(block("workers")).not.toContain("ports:");
  });

  it("keeps its history in databases of its own, never the product's", () => {
    expect(block("temporal-schema")).toContain('"temporal temporal" "temporal_visibility visibility"');
    for (const name of ENGINE) expect(block(name), name).not.toContain("harness_bible");
  });

  it("is given none of the product's secrets", () => {
    for (const name of [...ENGINE, "temporal-ui"]) {
      for (const secret of ["LITELLM_MASTER_KEY", "GATEWAY_KEY_SECRET", "WORKERS_TOKEN", "INFINITY_API_KEY", "LEDGER_EXPORT_KEY"]) {
        expect(block(name), `${name} · ${secret}`).not.toContain(secret);
      }
    }
  });

  it("says out loud that it runs without an authorizer, and mounts its dynamic configuration read-only", () => {
    expect(block("temporal")).toContain('TEMPORAL_ALLOW_NO_AUTH: "true"');
    expect(block("temporal")).toContain("./infra/temporal/dynamicconfig.yaml:/etc/temporal/config/dynamicconfig/hb.yaml:ro");
    expect(block("temporal")).toContain("DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/hb.yaml");
  });
});

describe("the engine's dynamic configuration", () => {
  const keys = [...read("infra", "temporal", "dynamicconfig.yaml").matchAll(/^([a-zA-Z.]+):$/gm)].map((match) => match[1]);

  it("sets the two keys the unit decided and no other", () => {
    expect(keys).toEqual(["limit.maxIDLength", "frontend.enableServerVersionCheck"]);
  });
});

describe("the engine in the example environment", () => {
  const example = read(".env.example");
  const valueOf = (name: string): string => new RegExp(`^${name}=(.*)$`, "m").exec(example)?.[1] ?? "";

  it("names an address and a namespace the schema accepts, the address being the port compose publishes", () => {
    expect(TemporalAddressSchema.safeParse(valueOf("TEMPORAL_ADDRESS")).success).toBe(true);
    expect(TemporalNamespaceSchema.safeParse(valueOf("TEMPORAL_NAMESPACE")).success).toBe(true);
    expect(`${valueOf("TEMPORAL_ADDRESS")}:7233`).toBe(portsOf("temporal")[0]);
  });

  it("names the namespace the compose file registers when the variable is unset", () => {
    expect(block("temporal-namespace")).toContain(`TEMPORAL_NAMESPACE: \${TEMPORAL_NAMESPACE:-${valueOf("TEMPORAL_NAMESPACE")}}`);
    expect(block("temporal-ui")).toContain(`TEMPORAL_DEFAULT_NAMESPACE: \${TEMPORAL_NAMESPACE:-${valueOf("TEMPORAL_NAMESPACE")}}`);
  });
});
