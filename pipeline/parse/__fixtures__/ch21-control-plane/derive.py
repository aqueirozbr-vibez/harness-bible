#!/usr/bin/env python3
"""Lab 21 / derive.py — every derived number in Chapter 21."""
import json, datetime
out = {}
steps, calls_per_task = 11, 13                     # scenario (ch16, ch22)
# P(task completes with no transient failure) at per-call transient failure rate f
for f in (0.01, 0.02, 0.05):
    out[f"p_no_failure_13calls_f{f}"] = round((1-f)**calls_per_task, 3)
# with retries: per-call success after r retries at failure f = 1 - f^(r+1)
for f in (0.02, 0.05):
    for r in (1, 3):
        out[f"task_success_f{f}_retries{r}"] = round((1 - f**(r+1))**calls_per_task, 4)
# re-execution cost without checkpoints: crash uniformly in step k of 11 → redo k-1 steps; expected redo fraction
out["expected_redo_fraction_no_checkpoint"] = round(sum((k-1) for k in range(1, steps+1))/steps/steps, 3)   # E[(k-1)]/steps
# if a crash happens once per 500 tasks (illustrative), extra token cost per 1000 tasks at 7,500 tokens/step (ch22 compacted)
tokens_per_step = 7500
out["extra_tokens_per_1000_tasks_no_checkpoint"] = int(1000/500 * out["expected_redo_fraction_no_checkpoint"] * steps * tokens_per_step)
# approval wait: 14h20m held open vs durable; process cost of a held worker slot (illustrative 0.5 vCPU-h at $0.05)
out["approval_wait_hours"] = 14.33
out["held_worker_cost_usd_per_approval_at_0.05_per_vcpu_h"] = round(14.33*0.5*0.05, 3)
# duplicate-write risk: without idempotency, P(at least one duplicate write per 1000 tasks) if 2% of writes are retried after an ambiguous timeout, 1 write per task
out["duplicate_writes_per_1000_tasks_no_idempotency_2pct_ambiguous"] = 20
# backoff schedule: base 1 s, factor 2, jitter full, cap 30 s → attempt delays
delays = []; d = 1.0
for i in range(6):
    delays.append(min(d, 30.0)); d *= 2
out["backoff_schedule_s"] = delays; out["backoff_total_worst_s"] = sum(delays)
out["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump(out, open("results/derived.json","w"), indent=2)
for k,v in out.items(): print(k, v)
