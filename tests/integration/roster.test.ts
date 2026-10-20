import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveUserFor } from "@/lib/auth/link";
import { createSession, sessionFromToken } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { currentParts } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { subjectOf } from "@/lib/policy/input";
import type { ProviderProfile } from "@/lib/schemas/auth";

/*
 * What a session knows of its person, and the roster (feature-specs/29 § 6.1, § 6.3, § 10.7; tracker unit 46d),
 * against the database. A session says whether its person is verified, which the policy had never been told; a
 * curator's session carries the parts the roster gives them, read for each request; and the roster is written by
 * one command, run here as `npm run roster:set` runs it.
 *
 * The suite's two people are its own, made as a sign-in makes them and removed after with their sessions, their
 * roster rows and the audit rows the command wrote.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

const CURATOR_EMAIL = "roster-curator@harness-bible.local";
const READER_EMAIL = "roster-reader@harness-bible.local";
const profile = (email: string, sub: string, name: string, role: ProviderProfile["role"], verified: boolean): ProviderProfile => ({ provider: "google", providerAccountId: sub, email, emailVerified: true, name, role, verified, idpSessionId: null });

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `scripts/roster-set.ts` as `npm run roster:set --` does. */
function rosterSet(...args: ReadonlyArray<string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, "scripts/roster-set.ts", ...args], { cwd: APP_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const ids = (await prisma.user.findMany({ where: { email: { in: [CURATOR_EMAIL, READER_EMAIL] } }, select: { id: true } })).map((user) => user.id);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.identity.deleteMany({ where: { userId: { in: ids } } });
    await prisma.authEvent.deleteMany({ where: { userId: { in: ids } } });
    /* The roster rows go with the person: the foreign key cascades (feature-specs/29 § 11). */
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

describe.skipIf(!hasDatabase)("a session's person and the curator roster, against the database", () => {
  let curator = "";
  let reader = "";
  let curatorToken = "";
  let readerToken = "";

  beforeAll(async () => {
    await cleanup();
    curator = (await resolveUserFor(profile(CURATOR_EMAIL, "kc-roster-sub-curator", "Roster Curator", "CURATOR", true), "en")).userId;
    reader = (await resolveUserFor(profile(READER_EMAIL, "kc-roster-sub-reader", "Roster Reader", "READER", false), "en")).userId;
    curatorToken = await createSession(curator, { device: "unknown", idpSessionId: null });
    readerToken = await createSession(reader, { device: "unknown", idpSessionId: null });
  });

  afterAll(cleanup);

  it("says whether its person is verified, and so does the subject the policy is given", async () => {
    const ofTheCurator = await sessionFromToken(curatorToken);
    const ofTheReader = await sessionFromToken(readerToken);
    expect(ofTheCurator).toMatchObject({ id: curator, role: "CURATOR", identityVerified: true, parts: [] });
    expect(ofTheReader).toMatchObject({ id: reader, role: "READER", identityVerified: false, parts: [] });
    expect(subjectOf(ofTheCurator)).toMatchObject({ verified: true, parts: [] });
    expect(subjectOf(ofTheReader)).toMatchObject({ verified: false, parts: [] });
  });

  it("puts a curator on the roster by the command, and their next request carries the part with no new sign-in", { timeout: 60_000 }, async () => {
    const run = await rosterSet("--email", CURATOR_EMAIL, "--part", "P3");
    /* The environment loader says on stderr what it loaded; a refusal of the command's own would be there too. */
    expect(run.stderr).not.toContain("usage:");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Roster Curator");
    expect(run.stdout).toContain("is on the roster for P3 since ");
    expect(run.stdout).toContain("with no end");
    expect(run.stdout).toContain("parts in force for them now: P3");
    expect(run.stdout).toContain("the roster is shown to curators and organisation admins");
    expect(run.stdout).not.toContain(CURATOR_EMAIL);
    expect(run.stdout).not.toContain("this account's role is");

    expect((await sessionFromToken(curatorToken))?.parts).toEqual(["P3"]);
    expect(subjectOf(await sessionFromToken(curatorToken))).toMatchObject({ role: "CURATOR", verified: true, parts: ["P3"] });

    const logged = await withSystem(() => getPrisma().authEvent.findMany({ where: { userId: curator, kind: "roster_set" }, select: { detail: true, traceId: true } }));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.detail).toMatchObject({ part: "P3", until: null });
    expect(logged[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(logged)).not.toContain("@");
  });

  it("gives a second part, and ends a row at the day the command names", { timeout: 60_000 }, async () => {
    const run = await rosterSet("--email", CURATOR_EMAIL, "--part", "P1", "--until", "2099-01-01");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("is on the roster for P1 since ");
    expect(run.stdout).toContain("until 2099-01-01T00:00:00.000Z");
    expect(run.stdout).toContain("parts in force for them now: P1, P3");
    expect((await sessionFromToken(curatorToken))?.parts).toEqual(["P1", "P3"]);
    /* The same roster read a moment after that row ends: the part is no longer theirs. */
    expect(await currentParts(curator, new Date("2099-01-01T00:00:00.001Z"))).toEqual(["P3"]);
  });

  it("writes a row for an account that is not a curator, says it decides nothing yet, and the session carries no part", { timeout: 60_000 }, async () => {
    const run = await rosterSet("--email", READER_EMAIL, "--part", "P2");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("this account's role is READER");
    expect(await currentParts(reader)).toEqual(["P2"]);
    expect((await sessionFromToken(readerToken))?.parts).toEqual([]);
  });

  it("refuses an account nobody has, a part the book has not, a date that is none, and an end before the beginning; and writes nothing", { timeout: 120_000 }, async () => {
    const before = await withSystem(() => getPrisma().authEvent.count({ where: { kind: "roster_set", userId: { in: [curator, reader] } } }));
    const unknown = await rosterSet("--email", "nobody@harness-bible.local", "--part", "P3");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no account has that e-mail");
    const noPart = await rosterSet("--email", CURATOR_EMAIL, "--part", "P9");
    expect(noPart.code).toBe(1);
    expect(noPart.stderr).toContain("name one part of the book");
    const noDate = await rosterSet("--email", CURATOR_EMAIL, "--part", "P3", "--until", "next spring");
    expect(noDate.code).toBe(1);
    expect(noDate.stderr).toContain("--until is a date");
    const past = await rosterSet("--email", CURATOR_EMAIL, "--part", "P3", "--until", "2020-01-01");
    expect(past.code).toBe(1);
    expect(past.stderr).toContain("a roster row ends after it begins");

    expect(await currentParts(curator)).toEqual(["P1", "P3"]);
    expect(await withSystem(() => getPrisma().authEvent.count({ where: { kind: "roster_set", userId: { in: [curator, reader] } } }))).toBe(before);
  });
});
