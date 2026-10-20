import { clean, reportOf, scanForSecrets } from "@/lib/security/scan";

/*
 * npm run secrets:scan (feature-specs/21 § 6.1): scans the prompt templates, the code that assembles a prompt and
 * the data a model reads for anything shaped like a secret. It prints where and what kind, never the match, then
 * `secrets:scan · {files} files · {n} findings`, and exits 1 on any finding or when a folder it should scan is not
 * there. CI runs it as its own step; gitleaks keeps covering the repository as a whole. It reads files and nothing
 * else: no database, no network, no environment.
 */

const result = scanForSecrets(process.cwd());
const lines = reportOf(result);
for (const line of lines.slice(0, -1)) console.error(line);
console.log(lines.at(-1));
if (!clean(result)) process.exitCode = 1;
