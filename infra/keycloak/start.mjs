// Starts the local Keycloak with the realm as code (infra/keycloak/README.md). `npm run auth:kc`.
// `node infra/keycloak/start.mjs --render-only` writes the rendered realm to infra/keycloak/.rendered/
// (for docker compose and CI) without starting anything.
//
// Keycloak's import substitutes nothing inside URLs, so the `${env.NAME}` placeholders of the realm
// file are rendered here from the process environment; `${vault.*}` stays for Keycloak's file vault.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const renderOnly = process.argv.includes("--render-only");

const values = {
  APP_URL: process.env.APP_URL ?? "http://localhost:3000",
  HB_WEB_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET ?? process.env.HB_WEB_CLIENT_SECRET ?? "dev-hb-web-secret",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "unset",
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "unset",
};

const template = readFileSync(join(here, "realm-harness-bible.json"), "utf8");
const rendered = template.replace(/\$\{env\.([A-Z_]+)\}/g, (match, name) => {
  const value = values[name] ?? process.env[name];
  if (value === undefined) throw new Error(`realm placeholder ${match} has no value`);
  return value;
});
const renderedDir = join(here, ".rendered");
mkdirSync(renderedDir, { recursive: true });
writeFileSync(join(renderedDir, "realm-harness-bible.json"), rendered);
console.log(`rendered realm → ${join(renderedDir, "realm-harness-bible.json")} (APP_URL=${values.APP_URL})`);
if (renderOnly) process.exit(0);

const home = process.env.KEYCLOAK_HOME;
if (home === undefined || !existsSync(home)) {
  console.error("KEYCLOAK_HOME must point at an extracted Keycloak 26 distribution (needs a JDK 21: JAVA_HOME or java on PATH).");
  process.exit(1);
}
const importDir = join(home, "data", "import");
mkdirSync(importDir, { recursive: true });
writeFileSync(join(importDir, "realm-harness-bible.json"), rendered);

const vaultDir = resolve(here, "vault");
if (!existsSync(vaultDir)) {
  console.error(`Create ${vaultDir} with the vault files named in infra/keycloak/README.md.`);
  process.exit(1);
}
const kc = join(home, "bin", process.platform === "win32" ? "kc.bat" : "kc.sh");
const args = ["start-dev", "--http-port", process.env.KEYCLOAK_PORT ?? "8081", "--import-realm", "--vault", "file", "--vault-dir", vaultDir];
const env = {
  ...process.env,
  /* Development bootstrap admin; the private admin hostname and named operators replace it later (09 § 8.9). */
  KC_BOOTSTRAP_ADMIN_USERNAME: process.env.KC_BOOTSTRAP_ADMIN_USERNAME ?? "admin",
  KC_BOOTSTRAP_ADMIN_PASSWORD: process.env.KC_BOOTSTRAP_ADMIN_PASSWORD ?? "admin",
  ...(process.env.JAVA_HOME === undefined && process.env.KEYCLOAK_JAVA_HOME !== undefined ? { JAVA_HOME: process.env.KEYCLOAK_JAVA_HOME } : {}),
};
const child = spawn(kc, args, { stdio: "inherit", shell: process.platform === "win32", env });
child.on("exit", (code) => process.exit(code ?? 0));
