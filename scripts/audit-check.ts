import { spawnSync } from "node:child_process";

import { auditVerdict, type AuditReport } from "@/lib/security/audit";

/*
 * npm run audit:check (feature-specs/09 § 8.8): the dependency gate CI runs. It asks npm audit twice, the production
 * tree and the whole one, and fails on any high or critical advisory, except in the development tree an advisory
 * that lib/security/audit.ts names with its reason and a review day. It prints the package, the severity and the
 * advisory's id, then `audit:check · …`. It needs the registry, as npm audit does; nothing else.
 *
 * Both calls say `--offline=false`, and the whole tree's says `--include=dev`: an `offline` setting would make npm
 * answer with an empty report, and `NODE_ENV=production` or an `omit=dev` setting would leave the development tree
 * out, and either would pass the gate without an audit.
 */

/** npm itself: the CLI this script was started by when it runs as `npm run`, else `npm` on PATH. */
function audit(args: ReadonlyArray<string>): AuditReport {
  const cli = process.env.npm_execpath;
  const all = ["audit", "--json", "--offline=false", ...args];
  const result =
    cli !== undefined && cli.endsWith(".js")
      ? spawnSync(process.execPath, [cli, ...all], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      : spawnSync(`npm ${all.join(" ")}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true });
  /* npm audit exits 1 when it finds anything; its JSON is the answer either way */
  try {
    const report = JSON.parse(result.stdout) as AuditReport | null;
    if (report !== null && typeof report === "object") return report;
  } catch {
    /* not JSON: reported below */
  }
  const said = [result.error?.message, result.stderr, result.stdout].find((text) => typeof text === "string" && text.trim() !== "");
  return { error: { code: `exit ${String(result.status)}`, summary: said?.trim().split("\n")[0] ?? "no output" } };
}

const verdict = auditVerdict(audit(["--omit=dev"]), audit(["--include=dev"]), new Date().toISOString().slice(0, 10));
for (const line of verdict.notes) console.log(line);
for (const line of verdict.failures) console.error(line);
console.log(verdict.summary);
if (!verdict.passed) process.exitCode = 1;
