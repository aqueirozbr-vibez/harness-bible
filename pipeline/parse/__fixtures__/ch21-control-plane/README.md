# Lab 21 — Control plane and durable execution

Runs the chapter's event-sourced executor (`executor.py`, extracted verbatim from Chapter 21). 300 tasks are each killed at a random step, resumed by a fresh worker, suspended at the approval signal with no process held, then resumed again after the signal. Reproduces: activity executions equal an uninterrupted run (no re-spend), exactly one write per task with a unique idempotency key, and budget escalation on a 100-step runaway plan. Also reproduces the derive.py figures. CPU, seconds. `python run.py`; exit 0 = reproduced.

Lab 21b (not included; needs a Temporal server): the same protocol against `temporalio` — kill the worker container mid-task and count writes in the CMMS stub.
