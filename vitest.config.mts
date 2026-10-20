import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // A test that doubles the database, the gateway or Temporal lives beside its module (code-standards § Testing),
    // so workers/ carries its own; tests/ keeps the ones that read the repository and the container-backed suites.
    include: ["lib/**/*.test.ts", "pipeline/**/*.test.ts", "workers/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      // `npm run test:ledger`: lib/ledger/ holds 100 % branch coverage (code-standards § Testing; feature-specs/14 § 9.1).
      // `npm run test:rubric` holds lib/rubric/ to the same threshold, naming its own folder on the command line
      // (feature-specs/30 § 7).
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["lib/ledger/**"],
      thresholds: { branches: 100 },
    },
  },
});
