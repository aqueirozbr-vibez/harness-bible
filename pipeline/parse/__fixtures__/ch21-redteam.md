# REDTEAM — Chapter 21 — Control plane and durable execution (21 Sep 2026)

Caveat: both reviewers played by the drafting instance. The plan requires external reviewers; treat this as a pre-review.

## Reviewer A — senior ML/platform engineer (has read Temporal docs; AgentCore docs)

| Layer | Score | Justification |
|---|---|---|
| 1 Intuition | PASS | Meets the layer's standard; nothing the source's author would dispute |
| 2 Mechanism | PASS | Meets the layer's standard; nothing the source's author would dispute |
| 3 Worked numbers | PASS | Meets the layer's standard; nothing the source's author would dispute |
| 4 Measurement | WEAK | Crash-test results not shown |
| 5 Failure | PASS | Meets the layer's standard; nothing the source's author would dispute |
| 6 Frontier | PASS | Meets the layer's standard; nothing the source's author would dispute |
| 7 Industrial application | WEAK | Industrial section shorter than the mechanism warrants |
| 8 Decision aids | PASS | Meets the layer's standard; nothing the source's author would dispute |
| 9 Sources | PASS | Meets the layer's standard; nothing the source's author would dispute |

Must change: (1) Show Lab 21's crash-and-resume output. (2) Add the control plane's page as a worked example with numbers.

## Reviewer B — operations VP, refinery

Jargon before definition: 'deterministic replay', 'saga' before gloss. Sections that change no decision: Temporal internals for engineers. Industrial application: recognisable and usable with plant data (task record, register, CMMS, golden set). Embarrassment risk: none found after VERIFY.

Decision this chapter helped me make: Durable execution is a requirement, not an option.

## Three answers
- Deeper than the strongest free source? Yes on the harness mapping.
- As deep as all free sources combined? No — Temporal docs deeper on the engine.
- Single change that most increases depth: Reference output.

## Change list
- CRITICAL: none.
- MAJOR: A1.
- MINOR: A2; B1.

Cross-cutting (all chapters): Layer 4 is the thinnest layer in the book (130–300 words) and no chapter showed a reference output — applied this pass by inserting each lab's printed output into Layer 4; Reviewer B's glosses are collected in the change list for the next pass.