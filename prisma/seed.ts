import "dotenv/config";

import { spawnSync } from "node:child_process";

import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";

/*
 * Development seed (feature-specs/04 § 7, 05 § 5.1). `prisma db seed` runs this
 * file through tsx. It creates the development user the session seam returns,
 * then ingests the fixture release (chapters 21, 28 and 37) when the database
 * holds no release yet; a full `npm run ingest` is left alone.
 */

/** The development reader; sign in as it through GET /api/v1/auth/dev?email=dev@harness-bible.local (feature-specs/08 § 5.7). */
export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

async function main(): Promise<number> {
  const prisma = getPrisma();
  await withTenant({ userId: DEV_USER_ID, organisationId: null }, () =>
    prisma.user.upsert({
      where: { id: DEV_USER_ID },
      create: { id: DEV_USER_ID, email: "dev@harness-bible.local", displayName: "Development reader", role: "READER", locale: "en-GB" },
      update: {},
    }),
  );
  console.log(`seed: development user ${DEV_USER_ID} (dev@harness-bible.local)`);

  const releases = await prisma.release.count();
  if (releases > 0) {
    console.log(`seed: ${releases} release(s) present; ingestion skipped`);
    return 0;
  }
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "pipeline/ingest.ts", "--only", "21,28,37", "--skip-invalid"], {
    stdio: "inherit",
    env: { ...process.env, PIPELINE: "1" },
  });
  return result.status ?? 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
