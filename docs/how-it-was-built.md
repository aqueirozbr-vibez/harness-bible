# How it was built

A short, honest note on the method, for readers who are curious how a project of this size was built by one person
working with an AI coding agent (Claude Code), in about three weeks of commits (from 2026-09-22) and around 300
commits.

## Specs before code

The project started from three documents: a product requirements document, a technical requirements document, and a
UI package of 18 screens with a style guide. The screens are published under [`docs/design/`](design/), and the two
PDFs will follow. Before any code, those were distilled into five files under [`context/`](../context/), which act
as the contract:

| File | Has authority over |
| --- | --- |
| [`project-overview.md`](../context/project-overview.md) | what the product does, the user flows, the scope, the success criteria |
| [`architecture.md`](../context/architecture.md) | the stack, the containers, the folders, the storage, the agents, and the invariants |
| [`ui-context.md`](../context/ui-context.md) | every visual decision: tokens, components, layout |
| [`code-standards.md`](../context/code-standards.md) | how code is written |
| [`ai-workflow-rules.md`](../context/ai-workflow-rules.md) | how the agent works: scope, splitting, what to do when a requirement is missing, verification |

When two of them disagree, the order of precedence is written down: the architecture's invariants first, then the
technical requirements, the product requirements, the UI package, and the context files. The agent reports a
disagreement. It does not resolve one silently.

[`CLAUDE.md`](../CLAUDE.md) at the root tells the agent to read those files, in order, before it implements anything
or makes an architectural decision, and to update them whenever an implementation changes what they say. The
context files describe the code as it is, not as it was planned. A progress tracker that recorded every unit, every
open question and every decision during the build was kept alongside them. It is a working log and is not
published.

## One spec per feature

Each feature got its own spec in [`context/feature-specs/`](../context/feature-specs/), numbered in the order it
was written: 49 of them, from `01-design-system.md` to `49-langfuse.md`. A spec states its sources and its
prerequisite specs, then the design down to the endpoint, the table and the user-visible string. It ends with a
list of **units** and how each one is verified.

Specs record decisions explicitly. A choice the spec makes on a recommendation is a numbered `D` item. An answer
from the owner is an `A` item, dated and quoted. When an answer later changes a rule in another document, the spec
says which rule changed and which unit amends it. Read [`30-rubric.md`](../context/feature-specs/30-rubric.md) or
[`48-research-agent.md`](../context/feature-specs/48-research-agent.md) to see the shape.

## Units, each with one review

Work happens one **unit** at a time. A unit is one route, one endpoint with its schema and contract test, one
component, one migration, one workflow, one sensor or one policy file. The rules for splitting are mechanical:
split when a change crosses more than one top-level folder, needs a migration and the code that reads it, or would
pass about 300 lines.

Every unit ends with the same checklist, run rather than assumed: the type check, the lint, the tests, a grep for
raw colours and forbidden utilities, EN/PT message parity, the build, opening the affected page in a browser and
comparing it to its screen, re-reading the invariants the unit could have broken, and a scope check of the diff.
Then **one small review per unit**, and the review's fixes land in one commit. Early on, reviews were run on parts
of units, and the process grew heavier than the work it protected. The rule became one review per unit.

The history reads like this:

```text
docs(48): spec 48, the research agent — research on request as conversations with reports, …
feat(70): the run on demand — ResearchRunWorkflow on the person's principal, its six activities, live steps, …
feat(72): the Research page — /[lang]/research with its conversations, the run block, the composer …
fix(62): the review of unit 62 — every young turn settled before a delete; …
```

## What the agent is not allowed to decide

The workflow rules draw the line between routine and material choices. A variable name or a fixture value is
routine: the agent decides it and says so in one line. A new table, a threshold, a limit, a role's permission, a
user-visible string, or anything that touches money, tokens, identity, the ledger or a model call is material. The
agent stops and writes a `BLOCKED` note: the decision needed, the spec sections searched, the options, a
recommendation, and what would have to be redone if the recommendation is wrong. Then it waits. It never invents a
number or a string to fill a gap.

Two more rules held throughout:

- **Paid runs are the owner's to start.** Anything that calls the real model provider beyond a single verification
  call (a golden-set run, a curated-suggestions run, the researcher's first real call) is handed over as a command
  with a cost estimate. The suites and the gates run on the stub gateway.
- **Nothing destructive to make a check pass.** No hard reset or force push, no deleted migration or test, no
  skipped hook, no lowered coverage threshold. A mistake is fixed by a new commit.

## What changed along the way

Plans moved, and the specs say where and why. The build order was changed on 2026-10-05, from Reader → Assistant →
IDE → Improve to Reader → Assistant → Improve → Researcher → IDE, so the Labs IDE is still unbuilt. The researcher
first ran automatically after every Assistant answer. On 2026-10-12 it became something a person starts, with its
own page and dock ([spec 48](../context/feature-specs/48-research-agent.md)), and the specs and context files were
amended to match. Some sections of the context files are dense with this history, because they record what was
decided as well as what is.

## If you want to try the method

Copy the shape, not the size: a handful of context files that are the contract, a spec per feature with its
decisions written down, small units with a fixed verification list, one review per unit, and a rule that the agent
asks before deciding anything that matters. Then let the documents change whenever the code does.
