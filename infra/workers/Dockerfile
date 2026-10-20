# The workers image (feature-specs/11 § 7.1): one image per service under infra/<service>/ (the tracker's
# first-party-containers question, option A). It runs the same entry point as `npm run workers` on the
# development machine, holds GATEWAY_KEY_SECRET and LITELLM_MASTER_KEY, and publishes no port: compose puts
# it on the internal network alone, where the web container reaches it with the bearer WORKERS_TOKEN.
FROM node:24-bookworm-slim

# Prisma's generated client and the pg driver adapter link against OpenSSL; the slim image carries none.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The development dependencies are installed too, for the `prisma` CLI that generates the client below. tsx, which
# runs workers/main.ts as `npm run workers` does, is a production dependency, so the production audit covers it
# (lib/security/audit.ts).
COPY package.json package-lock.json ./
RUN npm ci

# What the workers process reads: its own folder, the shared lib/ (schemas, db, gateway, env) and the schema
# the client is generated from. Nothing from app/ or components/ (§ 7.1).
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY lib ./lib
COPY workers ./workers

# lib/db/generated is git-ignored, so the client is generated here. The URL is a build-time placeholder for
# prisma.config.ts: generation reads the schema only, and the real DATABASE_URL arrives as an environment
# variable at run time.
RUN DATABASE_URL="postgresql://generate:generate@127.0.0.1:5432/generate" npx prisma generate

USER node
CMD ["npx", "tsx", "workers/main.ts"]
