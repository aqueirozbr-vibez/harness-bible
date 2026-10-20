-- The gateway's own database on the same PostgreSQL server (feature-specs/11 § 3.1): LiteLLM keeps virtual keys,
-- spend and budgets here and runs its own migrations at start. Idempotent, because CREATE DATABASE has no
-- IF NOT EXISTS: psql runs the statement only when the database is absent.
--
-- The compose `db` service runs this file from docker-entrypoint-initdb.d the first time its volume is created.
-- On any other server (the local cluster before unit 26, a throwaway container): psql -U hb -d postgres -f infra/gateway/init.sql
SELECT 'CREATE DATABASE litellm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')\gexec
