import { describe, expect, it } from "vitest";

import { ANONYMOUS, subjectOf } from "./input";
import { authorize } from "./opa";

/*
 * The OPA client fails closed (feature-specs/09 § 5.1, § 14.2): timeout, a
 * non-200, a non-boolean result and a missing URL all deny.
 */

const user = { id: "u1", organisationId: null, role: "READER" as const, displayName: "U", locale: "en-GB", identityVerified: false, parts: [], sessionId: "s1" };
const resource = { kind: "bookmark" as const, id: "21.3", ownerId: "u1" };
const silent = () => undefined;

function answering(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("authorize", () => {
  it("allows on result true and denies on false", async () => {
    expect(await authorize(subjectOf(user), "write", resource, {}, { url: "http://opa", fetch: answering({ result: true }), log: silent })).toEqual({ allow: true });
    expect(await authorize(subjectOf(user), "write", resource, {}, { url: "http://opa", fetch: answering({ result: false }), log: silent })).toEqual({ allow: false, reason: "policy_deny" });
    expect(await authorize(ANONYMOUS, "write", resource, {}, { url: "http://opa", fetch: answering({}), log: silent })).toEqual({ allow: false, reason: "policy_deny" });
  });

  it("denies on a non-200, a non-boolean, a timeout, an exception and no URL", async () => {
    expect(await authorize(subjectOf(user), "read", resource, {}, { url: "http://opa", fetch: answering({ result: true }, 500), log: silent })).toEqual({ allow: false, reason: "opa_status_500" });
    expect(await authorize(subjectOf(user), "read", resource, {}, { url: "http://opa", fetch: answering({ result: "yes" }), log: silent })).toEqual({ allow: false, reason: "opa_non_boolean" });
    const slow = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = performance.now();
    expect(await authorize(subjectOf(user), "read", resource, {}, { url: "http://opa", fetch: slow, timeoutMs: 30, log: silent })).toEqual({ allow: false, reason: "opa_unreachable" });
    expect(performance.now() - started).toBeLessThan(250);
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await authorize(subjectOf(user), "read", resource, {}, { url: "http://opa", fetch: failing, log: silent })).toEqual({ allow: false, reason: "opa_unreachable" });
    expect(await authorize(subjectOf(user), "read", resource, {}, { url: null, fetch: answering({ result: true }), log: silent })).toEqual({ allow: false, reason: "opa_unconfigured" });
  });

  it("posts the typed input and logs without the e-mail", async () => {
    let posted: unknown;
    const lines: Record<string, unknown>[] = [];
    const capturing = (async (_url: string, init: { body: string }) => {
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ result: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await authorize(subjectOf(user), "delete", resource, { traceId: "t-1", method: "DELETE", path: "/api/v1/bookmarks/21.3" }, { url: "http://opa", fetch: capturing, log: (l) => lines.push(l) });
    expect(posted).toMatchObject({ input: { subject: { kind: "user", id: "u1", role: "READER" }, action: "delete", resource: { kind: "bookmark", ownerId: "u1" }, context: { traceId: "t-1", method: "DELETE" } } });
    expect(lines[0]).toMatchObject({ traceId: "t-1", subject: "u1", action: "delete", resource: "bookmark", allow: true });
    expect(JSON.stringify(lines)).not.toContain("@");
  });
});
