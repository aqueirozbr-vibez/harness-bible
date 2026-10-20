-- feature-specs/11 § 3.4, § 9: GatewayKey's two foreign keys must agree with GatewayKey_one_principal.
-- 20260923170000_gateway left them at Prisma's default for an optional relation, ON DELETE SET NULL, which
-- the CHECK (exactly one principal) then refuses: deleting an Organisation or a User that holds a key failed
-- with a confusing check-constraint error. RESTRICT is the action the product wants: the GatewayKey row is the
-- only record of `litellmKeyId` and of the ciphertext, so the 30-day account hard delete must revoke the key
-- at the gateway (`/key/delete`, workers/keys.ts) and remove the row first, and the database now says so.
-- Forward-only: the applied migration is not edited.

ALTER TABLE "GatewayKey" DROP CONSTRAINT "GatewayKey_organisationId_fkey";
ALTER TABLE "GatewayKey" ADD CONSTRAINT "GatewayKey_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GatewayKey" DROP CONSTRAINT "GatewayKey_userId_fkey";
ALTER TABLE "GatewayKey" ADD CONSTRAINT "GatewayKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
