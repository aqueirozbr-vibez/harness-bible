import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { messageTextGateOf } from "./env";

/*
 * The environment's one reader (code-standards § Next.js): every variable the schema declares is read from the
 * process, and nothing is read that the schema does not declare. A variable declared and never read parses as unset
 * whatever the process holds, which is how unit 53e's two settings first read as off.
 */

const source = readFileSync(join(import.meta.dirname, "env.ts"), "utf8").replace(/\r\n/g, "\n");
const schema = source.slice(source.indexOf("const EnvSchema = z"), source.indexOf(".superRefine("));
const fed = source.slice(source.indexOf("export const env: Env = EnvSchema.parse({"));

describe("lib/env.ts", () => {
  it("reads every variable it declares, and only those", () => {
    const declared = [...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);
    const read = [...fed.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(20);
    expect([...read].sort()).toEqual([...declared].sort());
  });
});

/*
 * The development text switch's gate (feature-specs/49 § 9.1, § 9.5). The four conditions through the pure
 * function; the boot's refusals through a fresh import of the module under stubbed variables, as a process boots.
 */
describe("the development text switch (49 § 9.1)", () => {
  const ON = { text: "on", nodeEnv: "development", appUrl: "http://localhost:3000", authDevProvider: "1" } as const;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function boot(variables: Readonly<Record<string, string>>): Promise<typeof import("./env")> {
    vi.resetModules();
    for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value);
    return import("./env");
  }

  it("opens only with the setting on, a raw NODE_ENV=development, a loopback APP_URL and the development sign-in", () => {
    expect(messageTextGateOf(ON)).toEqual({ on: true, why: null });
    for (const appUrl of ["http://127.0.0.1:3000", "http://[::1]:3000"]) expect(messageTextGateOf({ ...ON, appUrl }).on).toBe(true);
  });

  it("stays shut with any one condition missing, and says which", () => {
    expect(messageTextGateOf({ ...ON, text: "off" })).toEqual({ on: false, why: "LANGFUSE_MESSAGE_TEXT is off" });
    /* unset, which the schema defaults to development, is not development here */
    expect(messageTextGateOf({ ...ON, nodeEnv: undefined }).why).toMatch(/^NODE_ENV is unset/);
    expect(messageTextGateOf({ ...ON, nodeEnv: "test" }).why).toBe("NODE_ENV is test, not development");
    expect(messageTextGateOf({ ...ON, nodeEnv: "production" }).on).toBe(false);
    expect(messageTextGateOf({ ...ON, appUrl: "https://harness-bible.example" }).why).toBe("APP_URL's host harness-bible.example is not a loopback host");
    expect(messageTextGateOf({ ...ON, authDevProvider: undefined }).why).toBe("AUTH_DEV_PROVIDER is not 1");
    /* unset, which the schema defaults to localhost, is not a loopback APP_URL here either (unit 82's review) */
    expect(messageTextGateOf({ ...ON, appUrl: undefined }).why).toBe("APP_URL is unset, and only an explicit loopback APP_URL passes");
  });

  it("reads unset as off, and boots with the gate shut", async () => {
    const loaded = await boot({ LANGFUSE_MESSAGE_TEXT: "" });
    expect(loaded.env.LANGFUSE_MESSAGE_TEXT).toBe("off");
    expect(loaded.messageTextGate.on).toBe(false);
  });

  it("boots with the gate open from the process's own variables, and shut when NODE_ENV comes only from the default", async () => {
    expect((await boot({ LANGFUSE_MESSAGE_TEXT: "on", NODE_ENV: "development", APP_URL: "http://localhost:3000", AUTH_DEV_PROVIDER: "1" })).messageTextGate.on).toBe(true);
    const defaulted = await boot({ LANGFUSE_MESSAGE_TEXT: "on", NODE_ENV: "", APP_URL: "http://localhost:3000", AUTH_DEV_PROVIDER: "1" });
    expect(defaulted.env.NODE_ENV).toBe("development");
    expect(defaulted.messageTextGate.on).toBe(false);
    /* nor when APP_URL comes only from its default, as in every deployment of the workers */
    const noAppUrl = await boot({ LANGFUSE_MESSAGE_TEXT: "on", NODE_ENV: "development", APP_URL: "", AUTH_DEV_PROVIDER: "1" });
    expect(noAppUrl.env.APP_URL).toBe("http://localhost:3000");
    expect(noAppUrl.messageTextGate.on).toBe(false);
  });

  it("refuses on in production, naming the variable", async () => {
    await expect(boot({ LANGFUSE_MESSAGE_TEXT: "on", NODE_ENV: "production" })).rejects.toThrow(/LANGFUSE_MESSAGE_TEXT must be off in production/);
  });

  it.each(["true", "1", "yes"])("refuses %s in any environment rather than read it as anything", async (value) => {
    await expect(boot({ LANGFUSE_MESSAGE_TEXT: value, NODE_ENV: "development" })).rejects.toThrow(/LANGFUSE_MESSAGE_TEXT/);
  });
});
