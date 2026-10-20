#!/usr/bin/env python3
"""Lab 21 — Control plane and durable execution.
Runs the chapter's event-sourced executor (executor.py, extracted verbatim). For each of 300 tasks: kill the worker at a
random step, resume from the history file, then deliver the approval signal and resume again. Reproduces: (1) zero repeated
model/tool calls after resume — total activity executions equal an uninterrupted run's; (2) exactly one write per task,
same idempotency key on any retry; (3) the wait for approval holds no process; (4) budget escalation halts a runaway plan.
Also reproduces derive.py's compounding-failure and retry figures."""
import os, random, json, subprocess, sys, tempfile, datetime
from executor import History, Workflow, Crash, Suspend, run_task
subprocess.run([sys.executable, "derive.py"], check=True, capture_output=True)
d = json.load(open("results/derived.json"))
random.seed(21); N = 300; STEPS = 11
executions = {"model": 0, "tool": 0, "write": 0}; write_keys = set()
def acts_factory():
    def plan(idempotency_key, task):
        executions["model"] += 1; return {"steps": [f"read{i}" for i in range(3)] + ["draft","validate","permit","preview","submit_work_order","notify","report","summary"][:STEPS-3], "calls": 1, "tokens": 800}
    def generic(idempotency_key, n):
        executions["tool"] += 1; return {"ok": True, "calls": 1, "tokens": 500}
    def submit(idempotency_key, order, approval):
        executions["write"] += 1; write_keys.add(idempotency_key); return {"created": order, "key": idempotency_key, "calls": 1, "tokens": 300}
    a = {"plan": plan, "submit_work_order": submit}
    for s in ["read0","read1","read2","draft","validate","permit","preview","notify","report","summary"]: a[s] = generic
    return a
tmp = tempfile.mkdtemp(); ok = True; budgets = {"calls": 60, "tokens": 200_000}
uninterrupted = 1 + STEPS   # plan + 11 activities per task
for t in range(N):
    path = os.path.join(tmp, f"t{t}.jsonl"); acts = acts_factory(); mailbox = {}
    crash_at = random.randint(1, STEPS-1)
    try: run_task(History(path).load(), acts, mailbox, budgets, f"t{t}", crash_at=crash_at)
    except (Crash, Suspend): pass                   # worker killed mid-task, or reached the approval wait first
    try: run_task(History(path).load(), acts, mailbox, budgets, f"t{t}")          # new worker resumes; blocks at approval
    except Suspend as e: assert "waiting for signal" in str(e)
    mailbox["approval"] = {"by": "supervisor-S", "reason": "ok", "expires": 9e9}
    run_task(History(path).load(), acts, mailbox, budgets, f"t{t}")               # resumes after signal; completes
    evs = [json.loads(l) for l in open(path)]
    assert evs[-1]["type"] == "task_complete"
total_exec = executions["model"] + executions["tool"] + executions["write"]
print(f"{N} tasks, crash at random step, resumed twice each: activity executions {total_exec} vs uninterrupted {N*uninterrupted}")
ok &= total_exec == N*uninterrupted
print(f"writes executed {executions['write']} (expected {N}); distinct idempotency keys {len(write_keys)}")
ok &= executions["write"] == N and len(write_keys) == N
# runaway: plan with 100 steps must escalate on the call budget, not run to completion
def big_plan(idempotency_key, task): return {"steps": [f"s{i}" for i in range(100)], "calls": 1, "tokens": 0}
acts = acts_factory(); acts["plan"] = big_plan
for i in range(100): acts[f"s{i}"] = lambda idempotency_key, n: {"ok": True, "calls": 1, "tokens": 0}
path = os.path.join(tmp, "runaway.jsonl")
try: run_task(History(path).load(), acts, {}, {"calls": 20, "tokens": 200_000}, "runaway"); halted = False
except RuntimeError as e: halted = "escalated" in str(e)
print("runaway plan halted by call budget:", halted); ok &= halted
# derived checks
checks = [("p_no_failure_f0.02", d["p_no_failure_13calls_f0.02"], round(0.98**13,3)), ("task_success_f0.05_r1", d["task_success_f0.05_retries1"], round((1-0.05**2)**13,4)),
          ("redo_fraction", d["expected_redo_fraction_no_checkpoint"], 0.455), ("backoff_total", d["backoff_total_worst_s"], 61.0)]
for n, got, exp in checks:
    m = abs(got-exp) < 1e-3; ok &= m; print(f"{n:22s} chapter {exp}  derived {got}  {'OK' if m else 'MISMATCH'}")
json.dump({"tasks": N, "executions": executions, "uninterrupted_equiv": N*uninterrupted, "distinct_write_keys": len(write_keys), "runaway_halted": halted,
           "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()}, open("results/run.json","w"), indent=2)
print("Lab 21:", "REPRODUCED" if ok else "NOT REPRODUCED"); sys.exit(0 if ok else 1)
