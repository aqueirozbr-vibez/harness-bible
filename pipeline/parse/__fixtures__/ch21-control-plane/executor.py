import json, hashlib
from typing import Callable

class History:
    """Append-only event log. In production this is the engine's durable store."""
    def __init__(self, path): self.path = path; self.events = []
    def load(self):
        try: self.events = [json.loads(l) for l in open(self.path)]
        except FileNotFoundError: self.events = []
        return self
    def append(self, ev):
        self.events.append(ev)
        with open(self.path, "a") as f: f.write(json.dumps(ev) + "\n")

class Crash(Exception): pass          # the worker died
class Suspend(Exception): pass        # the workflow is waiting; the caller persists and re-runs it later

class Workflow:
    """Deterministic orchestration over recorded activity results."""
    def __init__(self, history: History, activities: dict, budgets: dict, task_id: str):
        self.h = history; self.acts = activities; self.budgets = budgets; self.task_id = task_id
        self.cursor = 0; self.calls = 0; self.tokens = 0

    def activity(self, name: str, **args):
        """Return the recorded result if this activity already completed; otherwise run it once and record."""
        key = hashlib.sha256(json.dumps([self.task_id, name, args], sort_keys=True).encode()).hexdigest()[:16]
        for ev in self.h.events[self.cursor:]:
            if ev["type"] == "activity_completed" and ev["key"] == key:
                self.cursor = self.h.events.index(ev) + 1
                self.calls += ev["result"].get("calls", 0); self.tokens += ev["result"].get("tokens", 0)
                return ev["result"]                                   # replay: no re-execution
        if self.calls >= self.budgets["calls"] or self.tokens >= self.budgets["tokens"]:
            self.h.append({"type": "escalated", "reason": "budget exhausted", "at": name})
            raise RuntimeError("escalated: budget exhausted")
        result = self.acts[name](idempotency_key=key, **args)       # first execution
        self.h.append({"type": "activity_completed", "key": key, "name": name, "result": result})
        self.cursor = len(self.h.events)
        self.calls += result.get("calls", 0); self.tokens += result.get("tokens", 0)
        return result

    def wait_signal(self, name: str, mailbox: dict):
        """Suspend until a signal is present. No thread is held: the workflow returns and is re-run later."""
        for ev in self.h.events:
            if ev["type"] == "signal" and ev["name"] == name: return ev["payload"]
        if name in mailbox:
            self.h.append({"type": "signal", "name": name, "payload": mailbox[name]}); return mailbox[name]
        raise Suspend(f"waiting for signal {name}")

def run_task(h: History, acts: dict, mailbox: dict, budgets: dict, task_id: str, crash_at: int = None):
    wf = Workflow(h, acts, budgets, task_id)
    plan = wf.activity("plan", task="P-101 seal leak")["steps"]
    results = []
    for i, step in enumerate(plan):
        if crash_at is not None and i == crash_at: raise Crash(f"worker killed at step {i}")
        if step == "submit_work_order":
            approval = wf.wait_signal("approval", mailbox)
            results.append(wf.activity(step, order="WO-48211", approval=approval))
        else:
            results.append(wf.activity(step, n=i))
    h.append({"type": "task_complete"})
    return results
