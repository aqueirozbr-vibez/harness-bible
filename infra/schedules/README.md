# Nightly schedules

The application has two maintenance jobs, and neither is triggered by the web tier or the workers
(`context/feature-specs/21-assistant-retention-observability.md` § 3.1, decision D1). The schedule is code,
kept here, outside the application, until Temporal replaces it in Phase 4 (`context/code-standards.md` § Data).

| Job | Command | When | What it does |
|---|---|---|---|
| Assistant retention | `npm run assistant:purge` | 03:10 America/Sao_Paulo, nightly | Nulls message text, citation claim text and the model's sentences inside stored mode results after 30 days; marks a conversation purged when no text is left; closes turns abandoned by a crash. Deletes no row and appends no ledger record. |
| Auth sweep | `npm run auth:sweep` | 03:20 America/Sao_Paulo, nightly | Removes expired sessions, idempotency keys past their 24 hours, stale rate-limit buckets, and audit rows past 90 days. |

Each run prints a human line with its counts and one JSON line the collector reads like any span line:

```json
{"kind":"job","traceId":"…","job":"assistant:purge","counts":{"readers":3,"messages":12,"citations":20,"modeResults":2,"conversations":4,"closed":0},"ms":184}
```

A run that throws prints the same line with an `error` field and exits 1. Two consecutive failures of a job, or
no line from the purge for two days, are the alerts of spec 21 § 5.4.

## Linux host

`crontab` holds the two entries. Install it for the account that owns the checkout:

```sh
crontab infra/schedules/crontab
```

It assumes the checkout at `/srv/hb` and a writable `/var/log/hb/`. The time zone is set in the file
(`CRON_TZ`), so the host's own zone does not move the run.

## Development machine (Windows)

`schedules.ps1` registers the same two jobs as scheduled tasks under the current user, at 03:10 and 03:20 in
the machine's local time, logging to `%LOCALAPPDATA%\harness-bible\logs\`.

```powershell
# what it would register, without touching the machine
powershell -ExecutionPolicy Bypass -File infra\schedules\schedules.ps1 -DryRun

# register, and later remove
powershell -ExecutionPolicy Bypass -File infra\schedules\schedules.ps1
powershell -ExecutionPolicy Bypass -File infra\schedules\schedules.ps1 -Unregister
```

The jobs need the database container running and `.env` in place; a night the machine is off is skipped and
made up at the next start (`-StartWhenAvailable`). On a development database the purge is real: a conversation
older than 30 days loses its words.
