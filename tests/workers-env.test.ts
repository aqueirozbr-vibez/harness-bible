import { describe, expect, it } from "vitest";

import { checkPrincipalOf, individualCapsOf, listenAddressOf, requireWorkersSecrets, workersEnv } from "@/workers/env";

/*
 * The workers' own variables (feature-specs/11 § 8): read from a map, never from lib/env.ts; the D5 caps null
 * while owed; production boot refuses missing secrets.
 */

describe("workersEnv", () => {
  it("reads the master key and treats an empty value as unset", () => {
    expect(workersEnv({ LITELLM_MASTER_KEY: "sk-master" })).toEqual({ masterKey: "sk-master", individual: null });
    expect(workersEnv({ LITELLM_MASTER_KEY: "" })).toEqual({ masterKey: undefined, individual: null });
    expect(workersEnv({})).toEqual({ masterKey: undefined, individual: null });
  });

  it("gives the individual caps only when both numbers are set, and refuses a value that is not a whole number (D5)", () => {
    expect(individualCapsOf({ INDIVIDUAL_TOKEN_CAP: "200000", INDIVIDUAL_TOKENS_PER_MINUTE: "100" })).toEqual({ tokenCap: BigInt(200_000), tokensPerMinute: 100 });
    expect(individualCapsOf({ INDIVIDUAL_TOKEN_CAP: "200000" })).toBeNull();
    expect(individualCapsOf({ INDIVIDUAL_TOKENS_PER_MINUTE: "100" })).toBeNull();
    expect(individualCapsOf({ INDIVIDUAL_TOKEN_CAP: "", INDIVIDUAL_TOKENS_PER_MINUTE: "100" })).toBeNull();
    expect(() => individualCapsOf({ INDIVIDUAL_TOKEN_CAP: "2e5", INDIVIDUAL_TOKENS_PER_MINUTE: "100" })).toThrow(expect.objectContaining({ code: "WORKERS_ENV_INVALID" }));
    expect(() => individualCapsOf({ INDIVIDUAL_TOKEN_CAP: "200000", INDIVIDUAL_TOKENS_PER_MINUTE: "-1" })).toThrow(expect.objectContaining({ code: "WORKERS_ENV_INVALID" }));
  });

  it("refuses a production boot without GATEWAY_KEY_SECRET or LITELLM_MASTER_KEY, naming what is missing, and tolerates it in development", () => {
    expect(() => requireWorkersSecrets(true, { keySecret: undefined, masterKey: "sk-master" })).toThrow(/GATEWAY_KEY_SECRET required/);
    expect(() => requireWorkersSecrets(true, { keySecret: "0".repeat(64), masterKey: undefined })).toThrow(/LITELLM_MASTER_KEY required/);
    expect(() => requireWorkersSecrets(true, { keySecret: undefined, masterKey: undefined })).toThrow(/GATEWAY_KEY_SECRET and LITELLM_MASTER_KEY required/);
    expect(() => requireWorkersSecrets(true, { keySecret: "0".repeat(64), masterKey: "sk-master" })).not.toThrow();
    expect(() => requireWorkersSecrets(false, { keySecret: undefined, masterKey: undefined })).not.toThrow();
  });
});

describe("listenAddressOf (feature-specs/11 § 7.1)", () => {
  it("binds the port WORKERS_URL names", () => {
    expect(listenAddressOf("http://127.0.0.1:4002")).toEqual({ host: "127.0.0.1", port: 4002 });
    expect(listenAddressOf("http://workers:4002")).toEqual({ host: "workers", port: 4002 });
  });

  it("reads the implied port of a URL without one, never 0 (which would bind a random free port)", () => {
    expect(listenAddressOf("http://workers")).toEqual({ host: "workers", port: 80 });
    expect(listenAddressOf("http://127.0.0.1")).toEqual({ host: "127.0.0.1", port: 80 });
  });

  it("refuses what this surface cannot honour: another protocol, a path, a query, a fragment, a trailing slash, a value that is not a URL", () => {
    for (const value of ["https://workers:4002", "ws://workers:4002", "workers:4002"]) {
      expect(() => listenAddressOf(value), value).toThrow(expect.objectContaining({ code: "WORKERS_URL_INVALID" }));
    }
    expect(() => listenAddressOf("https://workers:4002")).toThrow(/http: URL/);
    for (const value of ["http://127.0.0.1:4002/", "http://127.0.0.1:4002/health", "http://127.0.0.1:4002?a=1", "http://127.0.0.1:4002#f"]) {
      expect(() => listenAddressOf(value), value).toThrow(/without a path, query or fragment/);
    }
    expect(() => listenAddressOf("127.0.0.1:4002 ")).toThrow(/is not a URL/);
  });
});

describe("checkPrincipalOf (feature-specs/11 § 3.6)", () => {
  it("reads the principal npm run gateway:check uses without a flag, or null while it is unset", () => {
    expect(checkPrincipalOf({})).toBeNull();
    expect(checkPrincipalOf({ GATEWAY_CHECK_PRINCIPAL: "" })).toBeNull();
    expect(checkPrincipalOf({ GATEWAY_CHECK_PRINCIPAL: "org:org-1" })).toEqual({ organisationId: "org-1" });
    expect(checkPrincipalOf({ GATEWAY_CHECK_PRINCIPAL: "user:u-1" })).toEqual({ userId: "u-1" });
  });

  it("refuses a value in neither form", () => {
    for (const value of ["u-1", "org:", "user:", "organisation:org-1"]) {
      expect(() => checkPrincipalOf({ GATEWAY_CHECK_PRINCIPAL: value }), value).toThrow(expect.objectContaining({ code: "WORKERS_ENV_INVALID" }));
    }
  });
});
