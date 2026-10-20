import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * npm run ledger:keygen — the development export key pair (feature-specs/14
 * § 7): the Ed25519 private key to infra/ledger/export-private.pem (ignored by
 * git through *.pem) and the public half to infra/ledger/export-public.pem,
 * which the repository keeps for verifyExport and CI. The private key is
 * written to its file and nowhere else (rules § 8.3: no key in a log line);
 * .env.example says how LEDGER_EXPORT_KEY hands it to the export script.
 * Production keys live in the vault, never here. An existing private key is
 * never overwritten.
 */

const dir = join("infra", "ledger");
const privatePath = join(dir, "export-private.pem");
const publicPath = join(dir, "export-public.pem");

if (existsSync(privatePath)) {
  console.error(`${privatePath} exists; delete it first to generate a new pair (every export signed with the old key would then verify only with its public half).`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
mkdirSync(dir, { recursive: true });
writeFileSync(privatePath, privatePem, { encoding: "utf8", mode: 0o600 });
writeFileSync(publicPath, publicPem, "utf8");
console.log(`ledger:keygen wrote ${privatePath} (private, git-ignored) and ${publicPath} (public, committed).`);
console.log(`Set LEDGER_EXPORT_KEY in .env to the contents of ${privatePath} as one double-quoted line with \\n between its lines (see .env.example); the key is not printed.`);
