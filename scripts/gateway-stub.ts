import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aliasesFromConfig, startStub, STUB_PORT } from "@/infra/gateway/stub/server";

/*
 * npm run gateway:stub — the stub gateway on port 4001 (feature-specs/11 § 4, § 8: GATEWAY_URL=http://localhost:4001).
 * It stands in for LiteLLM in development and CI: the same aliases (read from infra/gateway/litellm.yaml), the
 * same key routes under LITELLM_MASTER_KEY, the same budget refusal, deterministic answers, no provider. The
 * master key is read here, the stub's own environment, as the gateway container reads it; it never joins
 * lib/env.ts (spec § 8: gateway and workers only).
 */

const masterKey = process.env.LITELLM_MASTER_KEY;
if (masterKey === undefined || masterKey === "") {
  console.error("LITELLM_MASTER_KEY is not set: the stub mints virtual keys under it, as the gateway does (see .env.example).");
  process.exit(1);
}

const aliases = aliasesFromConfig(readFileSync(join("infra", "gateway", "litellm.yaml"), "utf8"));

startStub({ masterKey, aliases, port: STUB_PORT })
  .then((stub) => {
    console.log(`stub gateway listening on ${stub.url} (aliases: ${[...aliases.keys()].join(", ")}; no provider behind it)`);
    const stop = (): void => {
      void stub.close().then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  });
