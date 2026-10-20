-- feature-specs/08-user-auth.md § 4.3 and 09-keycloak-oauth.md § 9 (the User columns unit 21 needs).
-- Additive only.

CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE', 'GITHUB');

ALTER TABLE "User" ADD COLUMN "keycloakSub" TEXT;
ALTER TABLE "User" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "displayNameEdited" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "User_keycloakSub_key" ON "User"("keycloakSub");

CREATE TABLE "Identity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "IdentityProvider" NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSignInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Identity_provider_providerAccountId_key" ON "Identity"("provider", "providerAccountId");
CREATE INDEX "Identity_userId_idx" ON "Identity"("userId");
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Session" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Session" ADD COLUMN "device" TEXT NOT NULL DEFAULT '';
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
