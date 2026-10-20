import { afterEach, describe, expect, it, vi } from "vitest";

import { env, SECRET_ENV_KEYS } from "@/lib/env";
import { FLAG_REASONS } from "@/lib/schemas/api";
import { LINE_KINDS, printLine, SECRET_DETECTED } from "@/lib/telemetry/print";

import { guard } from "./guard";
import { processSecrets, registerProcessSecret, SECRET_MIN_LENGTH } from "./processSecrets";
import { redactSecrets, withoutRedactionMarks } from "./redact";

/*
 * The run-time half of the secret scanner (feature-specs/21 § 6.1, § 6.2, § 13.6): the process's own secret values,
 * the guard every line and span passes through, and the one printer of lines. As in the pattern table's suite, every
 * key-shaped example is assembled at run time.
 */

const FAKE_KEY = ["sk", "ant", `api03-${"Qw7".repeat(30)}`].join("-");
const OWN_SECRET = `deployment-bearer-${"z9".repeat(12)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the process's own secrets", () => {
  it("are the values of the secret variables, never their names, and only those long enough to be a secret", () => {
    const values = processSecrets();
    expect(values).toContain(env.IP_HASH_SALT);
    for (const key of SECRET_ENV_KEYS) expect(values).not.toContain(key);
    expect(values.every((value) => value.length >= SECRET_MIN_LENGTH)).toBe(true);
    expect([...SECRET_ENV_KEYS]).toEqual(["DATABASE_URL", "KEYCLOAK_CLIENT_SECRET", "IP_HASH_SALT", "LEDGER_EXPORT_KEY", "GATEWAY_KEY_SECRET", "WORKERS_TOKEN", "OBJECT_STORE_SECRET"]);
  });

  it("take a value a process holds elsewhere, as the workers' master key is, and leave out one too short to mean anything", () => {
    registerProcessSecret(OWN_SECRET);
    registerProcessSecret("short");
    registerProcessSecret(undefined);
    expect(processSecrets()).toContain(OWN_SECRET);
    expect(processSecrets()).not.toContain("short");
    /* Longest first, so a secret that contains another is taken whole. */
    const lengths = processSecrets().map((value) => value.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe("redaction with the process's values", () => {
  it("replaces a value that has no shape, and names it a process secret", () => {
    expect(redactSecrets(`token=${OWN_SECRET};`, [OWN_SECRET])).toEqual({ text: "token=[redacted:process-secret];", findings: ["process-secret"] });
    expect(redactSecrets(`${OWN_SECRET} ${OWN_SECRET}`, [OWN_SECRET]).findings).toEqual(["process-secret", "process-secret"]);
  });

  it("calls a value that is both by the name that matters more: it is ours", () => {
    expect(redactSecrets(`key ${FAKE_KEY}`, [FAKE_KEY])).toEqual({ text: "key [redacted:process-secret]", findings: ["process-secret"] });
    expect(redactSecrets(`key ${FAKE_KEY}`).findings).toEqual(["anthropic-key"]);
  });

  it("gives retrieval the question without the marks, and nothing when the question was only a secret", () => {
    expect(withoutRedactionMarks("Our key is [redacted:anthropic-key], why does a retried write become a second write?")).toBe("Our key is , why does a retried write become a second write?");
    expect(withoutRedactionMarks("[redacted:api-key]  [redacted:process-secret]")).toBe("");
    expect(withoutRedactionMarks("no marks here")).toBe("no marks here");
  });
});

describe("the guard", () => {
  it("hands back the very same value when there is nothing in it", () => {
    const line = { traceId: "0af7651916cd43dd8448eb211c80319c", job: "auth:sweep", counts: { keys: 9 }, ms: 4, tags: ["a", "b"], at: null };
    const guarded = guard(line, []);
    expect(guarded.detected).toBe(0);
    expect(guarded.value).toBe(line);
  });

  it("replaces a secret wherever it sits: a field, a nested field, an item of a list", () => {
    const line = { path: `/api/v1/x/${FAKE_KEY}`, detail: { note: `Bearer ${"t".repeat(30)}` }, list: ["fine", OWN_SECRET], ms: 3, ok: true };
    const guarded = guard(line, [OWN_SECRET]);
    expect(guarded.detected).toBe(3);
    expect(guarded.value).toEqual({ path: "/api/v1/x/[redacted:anthropic-key]", detail: { note: "[redacted:bearer-token]" }, list: ["fine", "[redacted:process-secret]"], ms: 3, ok: true });
    /* The line that came in is not the one that goes out, and is itself untouched. */
    expect(line.path).toContain(FAKE_KEY);
  });

  it("leaves what is not text or a plain container exactly as it is", () => {
    const at = new Date("2026-10-04T00:00:00Z");
    expect(guard({ at, n: 1, none: undefined }, []).value.at).toBe(at);
    expect(guard(42, [])).toEqual({ value: 42, detected: 0 });
    expect(guard(null, [])).toEqual({ value: null, detected: 0 });
  });
});

describe("printLine", () => {
  it("prints a line of each kind as it is given, with its kind first", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const kind of LINE_KINDS) expect(printLine(kind, { traceId: "t", ms: 1 })).toBe(0);
    expect(info.mock.calls.map((call) => String(call[0]))).toEqual(LINE_KINDS.map((kind) => `{"kind":"${kind}","traceId":"t","ms":1}`));
  });

  it("replaces a secret that reached a line, says it found one, and never prints the value", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    registerProcessSecret(OWN_SECRET);
    expect(printLine("span", { traceId: "t", path: `/api/v1/search/${FAKE_KEY}`, code: OWN_SECRET, ms: 2 })).toBe(2);
    const printed = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(printed)).toEqual({ kind: "span", traceId: "t", path: "/api/v1/search/[redacted:anthropic-key]", code: "[redacted:process-secret]", ms: 2, [SECRET_DETECTED]: true });
    expect(printed).not.toContain(FAKE_KEY.slice(7, 27));
    expect(printed).not.toContain(OWN_SECRET);
    expect(SECRET_DETECTED).toBe("hb.secret.detected");
  });
});

describe("a flag's reason", () => {
  it("is a code from a closed list, so there is nothing in one to redact", () => {
    expect([...FLAG_REASONS]).toEqual(["wrong_citation", "missing_citation", "wrong_number", "should_not_refuse", "should_refuse", "other"]);
    for (const reason of FLAG_REASONS) {
      expect(reason).toMatch(/^[a-z_]+$/);
      expect(redactSecrets(reason, processSecrets()).findings).toEqual([]);
    }
  });
});
