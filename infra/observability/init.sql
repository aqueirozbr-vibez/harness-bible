-- The dashboard's database role (feature-specs/21 § 5.2, D4): hb_metrics reads what the assistant's series need and
-- nothing else. Run by the compose `observe-init` service against the application database, and safe to run again:
-- every statement is idempotent. The password is not here; the service sets it from HB_METRICS_PASSWORD.
--
-- The grants are by column, not by table. Grafana runs any SQL a signed-in editor types, so the role is what keeps
-- a reader's words out of a dashboard: it cannot select Message.text, Citation.claimText, a mode result, a verdict's
-- detail, or any account table. The columns below are exactly the ones the statements of lib/metrics/sql read
-- (tests/observability.test.ts compares the two; tests/integration/observability.test.ts runs each statement as
-- this role). A new statement that needs another column adds it here in the same change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hb_metrics') THEN
    CREATE ROLE hb_metrics LOGIN;
  END IF;
END
$$;

-- Read-only by default, whatever is granted later by mistake.
ALTER ROLE hb_metrics SET default_transaction_read_only = on;

-- The schema itself. A database whose `public` schema was recreated (a restore, a migration reset) grants its use
-- to nobody but the owner, and a role without it is told the tables do not exist rather than that it may not read
-- them: Grafana's own connection test passes all the same, so this line is what the first real query needs.
GRANT USAGE ON SCHEMA public TO hb_metrics;

-- Start from nothing, so a column dropped from this file is a column the role loses.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hb_metrics;

GRANT SELECT (id, role, "userId", "conversationId", "createdAt", "refusalCause", "modelId", substituted, "firstTokenMs", grounded, "citesEdition") ON "Message" TO hb_metrics;
GRANT SELECT ("messageId", sensor, verdict) ON "SensorVerdict" TO hb_metrics;
GRANT SELECT ("messageId", reason) ON "Flag" TO hb_metrics;
GRANT SELECT (id, locale, "textPurgedAt") ON "Conversation" TO hb_metrics;
GRANT SELECT ("createdAt", alias, outcome, "costUsd", "inputTokens", "cacheReadTokens", "cacheWriteTokens") ON "BudgetLedger" TO hb_metrics;

-- The researcher's series (feature-specs/44 § 4; unit 61a) read three views and no table of research: what the RESEARCH
-- records say of each run and the curators' decisions on researchers' proposals; what research spends, by the run it
-- served and by who paid, the platform's research principal or the person (feature-specs/48 § 7; unit 70c); and the
-- flags people put on their research, by day, kind and reason (48 § 11.7). Each row is dated to its day (migrations
-- 20261011090000_research_metrics, 20261012180000_research_views and 20261012200000_research_principal, whose
-- CREATE OR REPLACE keeps these grants: the views read "Organisation" as their owner, and the role is granted nothing
-- on it). Never "ResearchRun", which names who asked, and
-- never "LedgerRecord", whose payloads hold the hashes of readers' words.
GRANT SELECT (day, kind, planned, ended, code, searches, "pageReads", findings, action) ON "ResearchFact" TO hb_metrics;
GRANT SELECT (day, kind, alias, outcome, "costUsd", run, payer) ON "ResearchSpend" TO hb_metrics;
GRANT SELECT (day, kind, reason) ON "ResearchFlag" TO hb_metrics;
