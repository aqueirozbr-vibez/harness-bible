import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GET as rubricByVersionRoute } from "@/app/api/v1/rubric/[version]/route";
import { GET as rubricCurrentRoute } from "@/app/api/v1/rubric/current/route";
import { getPrisma } from "@/lib/db/client";
import { currentRubricVersion, publishRubricVersion, readRubricVersion } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { loadRubric, RUBRIC_DIR } from "@/lib/rubrics/load";
import { CHANGE_CLASSES } from "@/lib/schemas/improve";

/*
 * Publishing the rubric (feature-specs/30 § 5, § 10.5, § 10.6), against the database: `npm run rubric:publish --
 * v1.2` writes the version's row and its threshold rows once and says so the second time; a file whose bytes
 * differ from its manifest is refused before anything is read; a version published with another hash is refused;
 * and the two endpoints serve the file of what is published.
 *
 * The row this writes is rubric v1.2's real one, the same the command writes on any machine: it is left in place.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `scripts/rubric-publish.ts` as `npm run rubric:publish --` does. */
function rubricPublish(...args: ReadonlyArray<string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, "scripts/rubric-publish.ts", ...args], { cwd: APP_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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

const base = env.APP_URL.replace(/\/$/, "");
const request = (path: string): Request => new Request(`${base}${path}`, { headers: { "x-forwarded-for": `2001:db8:1::${Date.now().toString(16)}` } });
const getCurrent = (): Promise<Response> => rubricCurrentRoute(request("/api/v1/rubric/current"), { params: Promise.resolve({}) });
const getVersion = (version: string): Promise<Response> => rubricByVersionRoute(request(`/api/v1/rubric/${version}`), { params: Promise.resolve({ version }) });

describe.skipIf(!hasDatabase)("publishing rubric v1.2", () => {
  const v12 = loadRubric("v1.2");

  it("writes the version's row and its five threshold rows, or says it is published already, and the second run writes nothing", async () => {
    const first = await rubricPublish("v1.2");
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/rubric v1\.2 (published: applies from 2026-07-01, sha256 d5f00562b63a…, 5 threshold rows|is published already \(sha256 d5f00562b63a…\); nothing written)/);

    const second = await rubricPublish("v1.2");
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("rubric v1.2 is published already (sha256 d5f00562b63a…); nothing written");

    const row = await withSystem(() => readRubricVersion("v1.2"));
    expect(row).toEqual({ id: "v1.2", publishedAt: new Date("2026-07-01T00:00:00Z"), appliesAt: new Date("2026-07-01T00:00:00Z"), sha256: v12.sha256 });
    const byClass = (a: { changeClass: string }, b: { changeClass: string }): number => a.changeClass.localeCompare(b.changeClass);
    const thresholds = await withSystem(() => getPrisma().threshold.findMany({ where: { rubricVersionId: "v1.2" }, select: { changeClass: true, acceptAt: true, floorAt: true } }));
    expect([...thresholds].sort(byClass)).toEqual(
      CHANGE_CLASSES.map((changeClass) => {
        const threshold = v12.rubric.thresholds[changeClass];
        return { changeClass, acceptAt: threshold === null ? null : threshold.acceptAt, floorAt: threshold === null ? null : threshold.floorAt };
      }).sort(byClass),
    );
    const stored = await withSystem(() => getPrisma().rubricVersion.findUnique({ where: { id: "v1.2" }, select: { tiers: true, adjustments: true, examples: true } }));
    expect(stored).toEqual({ tiers: v12.rubric.tiers, adjustments: v12.rubric.adjustments, examples: v12.rubric.examples });
  }, 120_000);

  it("refuses a file whose bytes differ from its manifest, before anything is read, and a version published with another hash", async () => {
    /* The real row first, whatever ran before: the refusal below is of a second hash for a published version. */
    expect((await rubricPublish("v1.2")).code).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "hb-rubric-publish-"));
    cpSync(join(RUBRIC_DIR, "v1.2"), join(dir, "v1.2"), { recursive: true });
    const file = join(dir, "v1.2", "rubric.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"bonus": 10', '"bonus": 11'));
    const changed = await rubricPublish("v1.2", "--dir", dir);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toMatch(/rubric v1\.2 has changed .* never edited in place/);

    await expect(withSystem(() => publishRubricVersion({ id: "v1.2", publishedAt: new Date(), appliesAt: new Date(), sha256: "f".repeat(64), tiers: {}, adjustments: {}, examples: [], thresholds: [] }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await withSystem(() => readRubricVersion("v1.2")))?.sha256).toBe(v12.sha256);
  }, 120_000);

  it("refuses to run without a version, and with a version that is not in the folder", async () => {
    const none = await rubricPublish();
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("usage: npm run rubric:publish -- <version> [--dir <folder>]");
    const missing = await rubricPublish("v9.9");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
  }, 120_000);

  it("is the version in force, and the endpoints serve its file (§ 10.6)", async () => {
    expect((await withSystem(() => currentRubricVersion()))?.id).toBe("v1.2");

    const current = await getCurrent();
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(JSON.parse(v12.text));

    const byVersion = await getVersion("v1.2");
    expect(byVersion.status).toBe(200);
    expect(await byVersion.json()).toEqual(JSON.parse(v12.text));

    const unknown = await getVersion("v9.9");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
