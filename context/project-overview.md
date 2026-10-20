# Harness Bible Interactive — Project overview

Sources: `specs/PRD — Harness Bible Interactive.pdf` (2026-09-21), `specs/TRD — Harness Bible Interactive.pdf` (v0.1), `docs/design/` (18 screens, style guide v0.9.0), `bible/book/` (chapter map, pilot report, chapters 00–40).

## Overview

Harness Bible Interactive is a multi-tenant web application that turns The Harness Bible, a 41-chapter engineering reference on large language models and harness engineering, into a working tool: readers navigate the book by part, chapter and layer with every figure linked to the derive script or source row that produced it; a retrieval-grounded assistant answers questions only from the book and cites chapter and section for every claim; each chapter's lab opens in an ephemeral browser sandbox that re-runs the chapter's code and reports which figures reproduced and which diverged; and contributors propose changes anchored to a section, figure or source row with evidence that an agent grades against a fixed, published rubric, with a human curator deciding what the rubric cannot; and a researcher agent that a person starts, from scratch or from an answer of the assistant, reads the web around the book's sections, writes that person a report with every page it read, and proposes changes the person turns, one at a time, into improvements through that same process, a curator deciding (since 2026-10-12, feature-specs/48; from 2026-10-05 it followed each answer on its own, which unit 75 ended). The product is the book's own harness applied to the book: intake sensors, a model gateway with hard budget caps, a workflow engine, a policy engine, isolated graders, and a hash-chained ledger are the components the chapters describe, and the interface shows all of them (versions, hashes, budgets, scores, run logs) instead of hiding them. Content is authored only in the book's Git repository; the SaaS renders a pinned release and returns accepted improvements as pull requests. Portuguese and English ship at parity.

## Goals

Measured at 12 months after launch unless stated otherwise.

1. **Readers use the book as a working reference.** At least 40% of accounts active in a month are also active in any given week (weekly active / monthly active).
2. **Labs are run, not just read.** At least 60% of the 35 lab chapters have one or more runs per active account per quarter.
3. **Questions are answered from the book.** At least 90% of assistant answers carry a chapter citation on every claim; fewer than 2% of answers are flagged wrong by users or by sampled audit.
4. **The book improves from evidence.** At least 200 accepted improvements in the ledger; zero accepted on weak evidence alone (tier E or below as the strongest item, with no curator override recorded).
5. **Adjudication is precise.** Fewer than 3% of accepted suggestions are later reverted by a curator.
6. **Content stays current.** Every fast-moving figure (prices, deadlines, model versions, benchmarks) has a verification date 90 days old or less; the reader flags any figure older than that.
7. **The harness stays calibrated.** Curator override rate per rubric criterion is below 10%; adjudicator agreement (Cohen's κ) against curators is at or above 0.7 each quarter; any criterion below 0.6 is retired.
8. **Cost is bounded by construction.** Per-organisation model token caps and IDE-minute caps are enforced at the gateway and orchestrator, never by application code or discipline; no overage is possible.

## Core user flow

The flow below follows one builder on chapter 21 from sign-in to a merged improvement, then the curator and admin steps that complete it. Route names are from the TRD route map.

1. **Sign in.** The user opens the app, picks their organisation, and is sent through Keycloak to the customer's SAML or OIDC identity provider. Keycloak returns an id token with organisation and role claims; Auth.js sets the session cookie.
2. **Land on Book Home** (`/en`). The page shows the pinned release stamp (`release 2026.09 · sha 7f3a9c1e`), a "Continue reading" card, a chapter grid per part with each chapter's version, days since verify, VERIFY and REDTEAM squares, and lab state, the grid's legend, and the verify and lab counts in the status bar. The Book status instrument (41/41 chapters pass verify, 34/35 labs reproduce, 2 chapters stale > 90 days, open red-team findings) is on Book management, the account's page for curators and organisation admins (Andre, 2026-10-12; feature-specs/47).
3. **Open a chapter section** (`/en/ch/21/21.3`). The reader shows a left outline rail (the chapter's nine layers: Intuition, Mechanism, Worked numbers, Measurement, Failure, Frontier, Industrial application, Decision aids, Sources), the section prose, and a right instrument rail with version, verification date, redteam status, lab verdict, derived-figures-linked count, and the figures table for the section.
4. **Follow provenance.** Every figure in the prose carries a chip: a source-tier chip (`pri`, `ven`, `anl`, `pra`, `ill`, `ƒ der`, `opn`), a derive chip (`ƒ L38`) that opens a code pane showing `lab-21/derive.py` lines 36–47 with line 38 highlighted, or an illustrative mark. Clicking a cross-reference such as `26.3` opens a peek panel beside the text (intercepting route `(.)ref/[id]`); `esc` closes it.
5. **Ask the assistant** (`a` key on any page, or "Ask about 21.3"). The assistant dock opens beside the chapter, or over the page when the reader is anywhere else, with mode set to Explain and the context line `context · the book · 34 of 41 chapters verified`; "Ask about 21.3" opens it with `About 21.3: ` already in the ask box (since Assistant 2.0, units 40 and 41: a conversation is about the book, not about the chapter it was opened beside). The user types a question (800-character cap) and submits. A scope sensor classifies it first; out-of-scope questions (vendor pricing today, operating a control system) are refused before retrieval with a refusal code and a pointer to the chapter's measurement protocol.
6. **Receive a cited answer.** Tokens stream over Server-Sent Events. The final event carries citations (`21.2`, `21.3`, `Lab 21 · README`) and sensor verdicts: citation sensor (every quoted figure exists at the cited location), scope sensor, grounding grader (isolated context, score ≥ 0.7 or one repair pass), edition sensor, latency. Any claim without a citation is replaced by "the book does not cover this". The user can Copy with citations or Flag this answer; flags feed the grader's calibration set. The answer is a ledger record.
7. **Open the lab** (`g l`, or "Run Lab 21"). `POST /labs/21/sessions` creates one Firecracker microVM from a warm snapshot (ready < 5 s), mounts the pinned lab files read-only with the user's saved edits overlaid, and opens a WebSocket. The IDE shows the file tree (`README.md`, `derive.py`, `run.py`, `workflow.py`, `activities.py`, `env.lock`, `data/`), a CodeMirror 6 editor, the chapter text in a side panel, run history, and a two-row sandbox status bar: session clock of 30:00, 2 vCPU, 4.0 GiB, `egress default-deny` with denial count, allow-list `pypi.org, files.pythonhosted.org`, the organisation's token budget meter, and `user code has no provider access`.
8. **Edit and run.** The user edits `activities.py` line 19 and presses Run (`ctrl ↵`). The sandbox executes `python derive.py && python run.py`. A watchdog kills the run at the 10-minute wall clock or 4 GiB memory and records `KILLED` with the message. The diff engine, running outside the sandbox, compares the printed figures to the chapter's Figure rows and renders the verdict as the largest element on screen: `NOT REPRODUCED · 5 of 6 figures match · 1 diverges · 1 new`, followed by the diff table (figure, chapter value, run value, Δ, match/diverge/new), the log tail, and a diagnosis naming the line.
9. **Save and attach.** "Save run" writes the edited files and log to object storage via a signed PUT (nothing persists in the sandbox). "Attach as evidence" makes the run a tier-A evidence item. "Reset to v1.5.0" restores the pinned files. Closing the IDE destroys the microVM.
10. **Suggest a change** (`/en/ch/21/improve/new?anchor=21.3`). Requires a contributor role with verified identity and provenance consent. The four-step form: pick an anchor (Section, Figure, or Source row; free-text suggestions are rejected at intake); the change class is auto-detected from the anchor and value type and shows its accept threshold and floor; enter the proposed text or number (before → after); add evidence items (`+ Link`, `+ DOI`, `+ Upload`, `+ Saved lab run`), each fetched and graded on add (base score × relevance × recency × independence, plus 10 once for a second independent item at tier D or above); write a rationale of at most 200 words. The right rail shows the live score, the strongest item, and the predicted outcome ("request more · short by 4 · a tier D item ≤ 90 days old would suffice"). Submit.
11. **Automatic adjudication.** A Temporal SuggestionWorkflow runs: intake sensors (schema, anchor exists at the current version, evidence parses, rationale length) → evidence grader (small model tier, source opened) → score = strongest adjusted item + corroboration, recomputed in code → if below the floor, declined at intake with no frontier-model call (a tier-G screenshot never costs an adjudication) → consistency sensors (derive.py consistency, cross-chapter shared figures, chapter lint) → change-class router: safety, OT-boundary, scenario-parameter, structure, rubric and new-source-tier changes go straight to the curator queue; everything else goes to the adjudicator (frontier model, isolated context: suggestion, graded evidence, sensor verdicts and anchored text only; identity visible only as `verified: true`). The adjudicator emits accept, request more (naming the tier that would suffice), or decline (naming the failing sensor), with one reason per rubric criterion. Every step writes a hash-chained ledger record.
12. **See the outcome** (`/en/improve/S-21-xxxx`). The contributor sees the score against floor and accept, the decision, the reasons table (tier, relevance, recency, independence, corroboration, threshold), the sensor verdicts, "what would suffice", and a "Revise with new evidence" action. Three declines for unverifiable (tier U) evidence in a rolling 30 days throttle the contributor for 30 days, with the reason shown.
13. **Curator review** (`/en/improve/queue`). A curator for the chapter's part sees the queue grouped by change class with an SLA per item (24-hour completion target), seeded known-answer items indistinguishable until decided, and a detail pane with the change, the evidence table, and the adjudication. The curator accepts, keeps request-more, or declines; an override requires a coded reason (`OV-IND-02 · Independence waived: sole authoritative source`) and a note. OPA checks that the curator's roster covers the part before the decision is accepted. The override is a signal to the running workflow, which writes the ledger and updates the calibration store; the queue's rail shows override rate per criterion against the 10% target and 20% review line, adjudicator κ, and adjudication precision.
14. **Merge to release.** On accept, a MergeWorkflow opens branch `improve/S-21-xxxx` in the book repository, commits the change, and waits for CI to run the lab suite. The chapter's own lab must reproduce (an unrelated pre-existing failure elsewhere does not block). The curator merges the PR; the chapter version bumps by the book's rule (patch for wording and figures, minor for a new section, major for structure); the release tag re-runs the content pipeline, which computes a render hash and blocks publication if it differs from CI's; `Release.current` switches and the data cache revalidates.
15. **History and credit** (`/en/ch/21/history`, `/en/improve/S-21-xxxx/record`). The chapter's version ledger lists every change with its class, anchor, evidence tier and score, contributor and curator, and record hash; contributors are credited alphabetically, never ranked, and no edit is attributed to the agent. The record page shows the full hash-chained timeline (submitted, graded, sensors, decided, curator, merged) with a chain-integrity check and a JSONL export.
16. **Organisation administration** (`/en/account`). An org admin sees the monthly token budget meter with a breakdown by consumer (assistant, Lab 23, Lab 27), IDE minutes and sandbox kill causes, seats by role (reader, builder, contributor, admin) with SSO status, the LGPD retention policy with a "Request deletion" action, the data-residency setting (Brazil · São Paulo; EU shown disabled), and the read-only sandbox policy. The audit export form (per account or per chapter, JSONL with hash chain, delivered by signed URL) and the curator roster are on Book management (`/en/account/book`), with Book status, for curators and organisation admins (Andre, 2026-10-12; feature-specs/47).

### The researcher's road (Capability 5, added 2026-10-05; feature-specs 40 to 43; research on request since 2026-10-12, feature-specs 48)

It begins on the Research page, from scratch, or at step 6 of the flow above, from an answer, and joins the flow at step 11. It never changes an answer of the assistant. Until unit 75 (2026-10-12) a run followed every answered turn on its own, on the platform's budget; nothing runs on its own now, and those earlier runs keep their line under their answers.

1. **A person asks.** On the Research page (`/[lang]/research`), or from an answer's `Start a research`, which opens the page seeded with that answer — its question, the answer and the sections it cited — and spends nothing until the person presses Start. A question with nothing to do with the book is refused, as the assistant refuses; a person starts at most 30 runs a day, on their own budget.
2. **A planner reads the question and never the web.** A small model reads the redacted question (and, seeded, the answer, the sentences the book did not cover and its sections) beside the book's sections retrieval found, and either refuses, says there is nothing to research, or writes a brief of at most 200 words. Code checks the brief: no secret, no address, no run of the question's own words.
3. **A reader searches the web and never sees the question.** A frontier model reads the brief and the book's sections, with the model provider's own web search and web fetch (at most 10 of each), and returns at most 3 findings, each anchored to a section, a figure or a source row, each with the pages it opened, and a note on each page. Code checks every finding: the anchor exists, the change is well formed, every source is a page that run really opened. The person watches each step as it happens.
4. **A writer reports.** A frontier model with no tool reads the question and the reader's notes and writes the report, which code checks and shows only to the person who asked, with every page read, labelled as from the web and not checked by Improve.
5. **One button a finding.** A verified contributor drafts a finding as a suggestion of their own; anyone else sends it to Improve as a researcher's proposal with no contributor: the product's own fetcher opens every source again, the evidence grader assigns each its tier, the score is computed in code, the sensors run, and the adjudicator recommends, on the platform's research principal. There is no list of trusted sites: the rubric decides what a source is worth. What Improve declines is closed, its records in the ledger, and reads `sent · not proposed`; what it accepts reads `sent · proposed` under the finding, with the control `Add my name`, and is in the curator queue of the chapter's part.
6. **A curator decides.** Nothing a machine proposed is merged without a curator's own accept. On accept the change is merged, versioned and released like any other; the chapter's history marks it `research` and credits the reader who added their name, if one did, or the contributor whose draft it was. No edit is attributed to the agent.

## Features

### Reader (Capability 1)
- Book Home: release stamp, book-status instrument (verify count, labs reproducing, stale chapters, open red-team findings), continue-reading card, chapter grid per part with version, days since verify, V/R status squares and lab state.
- Chapter reader with a persistent outline of the nine layers, section prose pre-rendered to HTML in the content pipeline, and a right-rail chapter instrument (version, verified date, verify/redteam/lab status, derived-figures-linked count, cited-figures count, oldest check, word count, improvement-history link, content hash).
- Provenance on every figure: seven source-tier chips (primary, vendor, analyst, practitioner, illustrative, derived, open), derive chips linking to the exact `derive.py` line and expression, illustrative marks in ochre with a dotted rule, and a per-section figures table (figure, value, tier).
- Cross-reference peek panel for `chNN`, `NN.N`, and `Lab NN` targets, with "open in place" and "open side by side".
- Mermaid figures rendered server-side to SVG with alt text; code blocks labelled with file and lines, with Copy and Open in Labs.
- Search across chapter sections, lab READMEs and registry rows: hybrid tsvector + pgvector rank in one SQL statement; filters by part, layer, source tier, verification age (≤ 30 d, ≤ 90 d, > 90 d stale) and type; sort by relevance, book order or recently verified; query-time instrument; "Ask about this" and "Open Lab" actions.
- Reading paths (Executive 8 stops, Builder 14 chapters, Foundations 15 chapters) with per-account progress, minute estimates at 230 words per minute, and resume buttons.
- Bookmarks and notes per account, synced across devices.
- Stale-figure flags in the reader for any fast-moving figure verified more than 90 days ago.
- Improvement history per chapter (version ledger, contributor credit, changes by layer, chain check).
- Render-check footer: content hash matches the pinned release.

### Assistant (Capability 2)
- Opened from any page with `a`: docked beside a reader section, or over the right edge of every other page. It also has a page of its own, `/assistant`, with three regions: every conversation the reader has had (the open one unfolded into its turns), the dock as the main column, ready for a question about the book, and the reader's own statistics (citation rate, refusal rate by cause, first-token p95, grounded score, flag rate, cache-read share, the budget meter), counted from their own turns and held to the operator's series by a parity test. On screens narrower than 768 px it does not render and the page says so: the modal sheet of `feature-specs/20-mobile-assistant.md` was skipped on 2026-10-03 (Andre's decision), so the assistant is a tablet and desktop feature in this build.
- Five fixed modes: Explain (a question about anything the book covers; since Assistant 2.0, unit 40, a conversation has no chapter and the question's own references say what it is about), Compare two chapters, Walk a decision aid with the user's inputs, Explain a lab run, Executive brief from Part III. Compare, walk and lab pick their chapters, aid or lab for the turn, from the whole release.
- Scope: the book, its labs, its registries and the cookbook map. Refusal causes: out of scope, control-system operation, recomputation request, unverified chapter. Refusals happen before retrieval, cost no model call, carry a code (`R-SCOPE-OT`) and point to what the book does cover.
- Every claim cites chapter and section; uncited claims are replaced by "the book does not cover this" from the final SSE event only, never from the token stream.
- Numbers are copied from the chapter text or derive script, never recomputed; the citation sensor verifies each quoted figure exists at the cited location.
- Decision-aid walk runs the chapter's `derive.py` at the user's inputs in a read-only sandbox with no egress; the model explains the result, it does not compute it.
- Sensor verdicts panel per answer: citation, scope, grader (grounded score, isolated context), edition, latency; hash and previous hash of the answer record.
- Conversation log rail with per-turn verdict, earlier conversations, and JSONL export.
- Flag this answer and Flag this refusal; flags enter the grader's calibration set.
- Answers in the user's language citing the matching edition; 20 messages per minute per user; budget-gated at the gateway (402 at the cap).
- Message text purged after 30 days; citations, verdicts and metrics retained.
- Each answered turn ends with `Start a research`, a link to the Research page seeded from it, which spends nothing until Start (Capability 5; since unit 75). A turn from before 2026-10-12 that the automatic research followed keeps its line, and any proposal that came of it beneath the answer, never inside it.

### Labs IDE (Capability 3)
- One Firecracker microVM per session, snapshot-restored (ready < 5 s target), destroyed on close; 2 vCPU, 4.0 GiB, 10-minute wall clock; one active session and six per hour per user.
- Egress default-deny at host nftables with an allow-list of `pypi.org` and `files.pythonhosted.org` plus per-lab README additions; denials counted and shown in the status bar; no route to the data tier, gateway or customer networks.
- File tree, CodeMirror 6 editor with modified markers and a diff strip against the pinned version, chapter text side panel with the figures the lab checks, README facts (expected runtime, run order, model calls declared, allow-list, editable reference implementation).
- Run (`derive.py` then `run.py`), Reset to the pinned version, Save run, Share link, Attach as evidence.
- Output pane: `REPRODUCED` / `NOT REPRODUCED` / `KILLED` verdict computed outside the sandbox, diff table per figure (chapter value, run value, Δ, match/diverge/new), log tail, diagnosis.
- Run history saved to the account with edited files and logs in object storage.
- Model-calling labs (ch23 routing comparison, ch27 grader) receive a session-scoped gateway sub-key with a per-run allowance; other sandboxes receive no key; a user-supplied provider key lives only in that session's environment and is never stored or logged.
- Sandbox-abuse rule: two kills for egress attempts end the session; three such sessions in 30 days suspend IDE access and notify the org admin.
- Desktop and tablet only; mobile shows a notice.

### Improve — contributor (Capability 4)
- Suggestion form anchored to a section, figure or source row; anchor-less suggestions rejected at intake.
- Change classes with thresholds from rubric v1.2: wording/clarification/typo (accept ≥ 40, floor 5); cited figure, date, price, deadline (70 / 25); derived figure (100, tier A only, and the derive script must change with it); new claim or source row (85 / 40); safety, OT-boundary, scenario parameter, structure, rubric, new source tier (curator always).
- Evidence tiers and base scores: A Reproducible 100, B Primary published 85, C Primary vendor 70, D Independent analyst 60, E Practitioner 40, F Reported 25, G Opinion 5, U Unverifiable 0. Multipliers: relevance 1.0 / 0.6 / 0.2; recency for fast-moving figures only 1.0 / 0.7 / 0.3; independence 1.0 / 0.8 (vendor concerned) / 0.7 (contributor's employer); corroboration +10 once. Score = strongest item's adjusted score + corroboration, never a sum.
- Evidence kinds: link, DOI, upload, saved lab run; each fetched or opened and graded on add; an unreachable link is graded U, not weak.
- Live score instrument, predicted outcome, and the named tier that would suffice, before submission.
- Rationale of at most 200 words with a live counter; drafts autosaved; 20 submissions per day.
- Adjudication page: score against floor and accept, decision, one reason per criterion, sensor verdicts, what would suffice, revise action.
- Full record page: hash-chained timeline, version bump, lab gate status, source-row verification update, credit, chain-integrity check, JSONL export.
- Contributor identity is passed to the adjudicator only as verified/unverified; name and employer never reach the model.
- Throttle: three tier-U declines in a rolling 30 days → 30-day throttle with the reason shown.
- Public rubric page (`/en/rubric`) with tiers, adjustments, thresholds, four worked examples, changelog, and JSON download; rubric changes are curator-only and announced 30 days before they apply.

### Improve — curator
- Queue per part plus shared items, grouped by change class, with tier, score, age and SLA (red when overdue).
- Seeded known-answer items at a fixed share, revealed after decision; they measure curator consistency.
- Detail pane with change, evidence table, adjudication and sensor verdicts.
- Decision actions: accept on inspection, keep request more, decline; override requires a coded reason from the adjudicator guide (`OV-IND-01`, `OV-IND-02`, `OV-REC-01`, `OV-REL-01`) and a note of at most 400 characters.
- Calibration rail: override rate per criterion against 10% target and 20% review trigger; adjudicator κ against the 0.6 retirement floor and 0.7 gate; adjudication precision against the 3% target; monthly sample of accepted tier-B items.
- Curators merge PRs and release versions; OPA restricts decisions to curators whose roster includes the chapter's part.

### Researcher (Capability 5)
- Started by a person, on the Research page or from an answer's `Start a research`; at most 30 runs a day a person; a question not about the book refused before anything is spent. Since unit 75 nothing runs on its own: until then it followed every answered turn, deduplicated. Never delays or alters an answer.
- Three model calls that share no context but what code passes between them: a planner (small model, no tools) that reads the question, a reader (frontier model, the provider's web search and fetch, 10 uses each) that reads only the planner's checked brief and the book's sections, and a writer (frontier model, no tools) that reads the question and the reader's notes and writes the report. At most 3 findings a run, of any change kind a person may propose.
- No registry of trusted sources: the open web, with the rubric as the judge. A source counts only once the product's own fetcher has opened it and the evidence grader has graded it.
- A finding is a suggestion of origin `research` with no contributor. It passes the same intake sensors, grader, score, consistency sensors and adjudicator as a person's; the adjudicator may only recommend.
- Refuted by Improve: closed and logged in the ledger; nothing is proposed. Curators can read the refuted findings as a research log; the reader who asked cannot.
- Accepted by Improve: shown to the person who sent it as a proposal, beneath their finding; they may add their name to it, giving provenance consent on the spot; a curator of the part decides within 7 days. A verified contributor's draft from a finding is theirs, through the same review as any of theirs.
- Paid for by the person who asks: their organisation's or their individual budget, a `research` row on their meter, about US$ 0.60 a run on the real provider (feature-specs/48 A3). The platform's research principal, one gateway key with a hard monthly cap (US$ 20 to begin with), pays only Improve's vetting of the findings people send, and a send waits for its reset at the cap.
- Since 2026-10-12, research on request (feature-specs/48): the Research page (`/[lang]/research`, unit 72) holds a person's researches, a column where a question about the book is asked, from scratch or seeded from an Assistant answer, and each run's steps as they happen, its report written from the web with every page it read, and the findings that passed the checks. The report is labelled as from the web and not checked by Improve. The statistics, flags, delete and export came in unit 73, the findings' buttons in unit 74, the answer's `Start a research` in unit 75, and in unit 77 the Research dock on every page, as the Assistant's: `r`, or `?research=` on the page's URL, opens the open research's runs and the composer over the page, one dock at a time.
- Privacy: the question goes, redacted, to the model provider in the planner's and the writer's calls and nowhere else; curators never see who asked or what; the link between a question and a proposal lives only in the asker's own rows and holds no text, so it outlives the purge of the message text after 30 days and the asker keeps seeing the proposal (spec 43 § 6; until 2026-10-11 this line said the link was purged with the text, which the code never did, spec 45 § 7); an organisation can switch research off for its members (feature-specs/48 D2); a person's own switch went with the automatic research in unit 75, since nothing of theirs is researched unless they start it.

### Account and administration
- Organisational accounts with SSO (SAML or OIDC via Keycloak) and seats; individual accounts with a fixed small cap.
- Roles: reader (reads, searches, asks; may add their name to a research proposal that came from their own question), builder (+ lab sessions, runs, saves, shares), contributor with verified identity (+ suggestions, evidence, own records), curator per part (+ queue, decisions, overrides, metrics, rubric changes), org admin (+ org, members, budget, exports, residency). The adjudicator acts under a service identity that may write only adjudication rows.
- Model budget meter: monthly token cap enforced at the LiteLLM gateway, breakdown by consumer, projected cap date; at the cap the assistant returns 402, model labs run without model calls, and adjudication queues until reset.
- IDE minutes meter with sessions, mean duration, kill count and causes, sandbox-ready p50.
- Audit export: per account or per chapter, date range, record kinds (adjudications, overrides, merges, assistant answers), JSONL with hash chain and signed trailer, delivered by signed URL, itself a ledger record; four per day.
- LGPD retention: conversation text 30 days then metadata only; contributor identity kept for provenance with consent; saved runs until deleted; account deletion 30 days after request with the ledger keeping a pseudonym.
- Data residency: Brazil · São Paulo for all containers, storage, backups, observability and the gateway; EU shown as disabled.
- Curator roster with chapters, queue size and median decision time, on Book management for curators and organisation admins (feature-specs/47).

### Editions, accessibility, keyboard
- Portuguese and English editions of every chapter with the source language marked; figures come from the same rows in both editions; locale number and date formatting (`1.000,5`, `12 set 2026`, `US$ 0,25`); ids, versions, hashes and code never localise.
- PT strings budgeted 30% longer than EN; labels wrap, never truncate; a CI layout snapshot fails on truncation.
- WCAG 2.2 AA as a release gate: text contrast ≥ 4.5:1, 2 px focus ring never removed, targets ≥ 24 px desktop and ≥ 44 px touch, text alternatives on every figure with numbers and source tier, state never conveyed by colour alone, reduced-motion support, `lang` per edition.
- Global keyboard map (`?`): `/` search, `j` `k` next and previous section, `[` `]` previous and next chapter, `g l` open this chapter's lab, `a` ask about this section, `esc` close panel or dock. Single-key shortcuts are off while focus is in a field and can be disabled in settings.
- Light and dark themes following the system, with 23 colour tokens; radius 0, no shadows, no gradients, no cards.

### Platform and harness
- Content pipeline: Git tag → parse chapters, labs, registries → immutable rows per release (ChapterVersion, Section, Figure, SourceRow, Lab) → embeddings and tsvector → render hash compared with CI's; idempotent per git SHA; instant rollback by repointing `Release.current`.
- Stack: Next.js App Router with React Server Components and TypeScript; PostgreSQL via Prisma with pgvector and tsvector; REST under `/api/v1` with an OpenAPI 3.1 contract generated from shared zod schemas; next-intl; SSE for the assistant; one WebSocket per sandbox session.
- LiteLLM gateway, self-hosted in region: per-organisation virtual keys with hard budgets, provider routing and version pinning, OTel export; the only path to a model, called by agent workers, never by the web tier.
- Temporal for suggestion, answer, merge and export workflows; curator decisions as signals; timers for the 24-hour target; idempotent activities.
- OPA as a sidecar policy decision point: default deny, Rego policies versioned in Git with the rubric, decision logs to the ledger; unreachable OPA denies.
- Three versioned agent guides in this repository under `guides/` (`guides/assistant/v1.12`, `guides/grader/v1.3`, `guides/adjudicator/v2.1`; moved from the book repository 2026-09-23) with byte-stable prefixes for prompt caching, structured output schemas, sensors before and after, and caps (one repair pass; one grading attempt, failure = tier U; one adjudication attempt, failure = curator queue). Score arithmetic and threshold routing are recomputed in code, never taken from a model.
- One hash-chained ledger for the whole product (RFC 8785 canonical JSON, SHA-256, genesis hash), with per-suggestion and per-chapter views as filters; records never deleted; payloads carry hashes of free text.
- Observability: OTel GenAI semantic conventions on every model call, sandbox session and adjudication; Langfuse for model spans and cost; Grafana, Loki and Tempo for the rest; one dashboard per headline metric.
- Secrets: provider keys only in the gateway vault; per-account virtual keys only in workers; user lab keys only in that sandbox's environment; a secret scanner on every prompt template in CI and every logged prompt, required count zero.
- Tenant isolation by `organisationId` on every account-scoped row, a Prisma client extension adding the tenant filter to every query, OPA denying cross-tenant reads, and per-object signed URLs.

## In scope

Five capabilities in five phases, each shippable, each adding one capability on the components before it. A phase must not pull forward components a later phase owns.

**Build order, since 2026-10-05 (Andre): 1, 2, 4, 5, 3.** Improvement and the researcher are built before the IDE. Two things in Improvement take their input from the IDE and wait for it: a saved lab run as evidence (tier A), and so any accepted change of a derived figure. The numbers below are the phases' names, not their order.

1. **Phase 1 — Reader.** Content pipeline from a Git release to rows with a render hash; PostgreSQL with full-text and vector index; Next.js reader, search, reading paths, bookmarks and notes; accounts, seats and SSO; PT and EN editions; Book Home, Reader-Chapter, Book-Search, Book-Paths, Chapter-History (read-only), Rubric page, Mobile-Reader (responsive, read-only). Does not need the gateway, workflow engine, sandboxes or adjudicator.
2. **Phase 2 — Assistant.** LiteLLM gateway with per-account hard caps; retrieval by section id with release filter and cross-encoder re-rank; scope sensor, citation sensor, edition sensor; grader in isolated context; five modes including the decision-aid walk; conversation log with sensor verdicts; flags; Assistant-Answer, Assistant-Refusal-Walk, Mobile-Assistant screens. Does not need sandboxes, the workflow engine or the curator queue.
3. **Phase 3 — IDE.** Sandbox orchestrator with a Firecracker microVM pool, egress default-deny, caps and watchdog; run, diff and reset; saved runs and shared links in object storage; metered model labs through the gateway; Labs-IDE screen. Does not need the adjudicator, ledger or curator queue.
4. **Phase 4 — Improvement.** Temporal workflows for suggestion state; intake and consistency sensors; evidence fetcher and grader; adjudicator; OPA policy engine for curator-only classes; hash-chained ledger; curator queue with seeds, overrides and calibration meters; versioned merges via pull request; audit export; Improve-Suggest, Improve-Adjudication, Improve-Record, Curator-Queue, Account-Admin screens. As planned on 2026-10-05 (feature-specs 27 to 39): the merge runs on a local Git repository of the book, with the hosted pull request and the CI webhook deferred until the book has a host; notifications are in the product, with e-mail deferred until a mail service exists; the seeded share of the queue starts at zero; the parts of Account-Admin that describe an organisation wait for organisational accounts.
5. **Phase 5 — Researcher.** The hand-off from an answered turn (removed in unit 75, 2026-10-12, when research became a person's to start: feature-specs/48); the research workflow on the platform's budget; the planner and the reader with the provider's web tools through the gateway; findings as suggestions in the improvement flow; endorsement by the reader who asked; the research line and the proposal in the assistant's dock; the researcher's group in the curator queue and the research log (feature-specs 40 to 44). Needs everything of Phase 4.

Also in scope across phases: the 18 screens in the UI package as responsive web pages; the style guide's tokens and rules (`hb.css` v0.9.0); Brazil data residency; LGPD retention and deletion; the test pyramid in the TRD (Vitest unit and contract tests, OPA policy tests, Testcontainers integration tests, Playwright end-to-end in PT and EN with axe, golden-set runs, the 35-lab CI matrix, k6 load tests); dev, staging and prod environments with a fixture release of chapters 21, 28 and 37.

## Out of scope

- **Native mobile apps.** The mobile Reader and Assistant screens are responsive web pages. On screens narrower than 768 px only the chapter reader renders; the assistant (its phone sheet was skipped, 2026-10-03), the lab and the suggest form's edit page show a "desktop or tablet" notice; step 1 of the suggest form and the Rubric page render at every width.
- **Offline mode.** No service worker, no downloaded editions.
- **Customer-hosted or single-tenant deployment.** One multi-tenant deployment in São Paulo; isolation is by row and policy, not by deployment.
- **A second region.** The EU option exists in the admin screen as a disabled radio button and in no infrastructure.
- **Suggestions that add chapters, or user-generated chapters outside the book's structure.** Structural changes to an existing chapter go to a curator; new chapters are not a suggestion class.
- **GPU labs in the browser.** Heavy variants of chapters 10 and 11 ship as downloads with instructions; the sandbox tier is CPU only (2 vCPU, 4 GiB).
- **Sandbox network access to the user's own systems, or inbound connections to a sandbox.** Egress is limited to package registries and a signed PUT to object storage.
- **A general AI chat product.** The assistant has five fixed modes, refuses by construction outside the corpus, and does not answer about vendor pricing today, the user's own system, or operating control systems. The researcher does not change this: it researches only questions about the book, refusing the rest as the assistant does; it never changes an answer of the assistant, and nothing it writes is presented as the book — its report is shown only to the person who asked, labelled as read from the web and not checked by Improve, and a finding reaches the book only through the improvement process (architecture invariant 31, as feature-specs/48 A1 reworded it).
- **A registry of trusted or blocked sources for the researcher**, and research on a schedule or of sections nobody asked about. The first was decided against (the rubric judges sources); the second was not asked for. Research on request was, on 2026-10-12, and is built (feature-specs/48).
- **Recomputing the book's figures on the user's behalf.** The model never computes; a decision-aid walk runs the chapter's own derive script.
- **A hosted agent platform for customers' own use cases, or a marketplace.**
- **Editing content in the SaaS outside the improvement flow.** Content rows are immutable per release; every change is a pull request to the book repository merged by a curator.
- **Leaderboards, time on page, messages per session, or per-contributor counts as a ranking.** The credit list is alphabetical and the schema has no leaderboard query.
- **Contributor payment.** Credit in the chapter's improvement history only; no finance integration.
- **A print pipeline.** Releases are Git tags; a print edition would consume the same release outside this product.
- **Per-user usage metering and billing.** Budgets are per organisation (tokens and IDE minutes) with a fixed small cap for individual accounts; usage-metered pricing is an open question and would be additive.
- **tRPC, Monaco, OpenSearch, Portkey, Cedar, gVisor, Step Functions.** Each was considered and rejected in the TRD component decisions.
- **Storing user-supplied provider keys, or any credential in model-visible text.**

## Success criteria

Done means every item below can be demonstrated, not asserted.

### Phase 1 — Reader
- A signed-in user of a pilot organisation can open any of the 41 chapters at `/[lang]/ch/[n]/[section]` in EN and PT, and the rendered content hash equals the release's `renderHash` computed by CI.
- The book is at 41/41 chapters passing VERIFY; the Book status instrument (on Book management since 2026-10-12) and the home's status bar show the same counts as the CI nightly check.
- Every derived figure in the rendered content resolves through `GET /figures/{id}/derive` to a lab id, file path, line and expression; every cited figure links to a source row with a verification date; every illustrative figure carries the `ill` chip. A crawl of all sections reports zero bare numbers in figure positions.
- Every cross-reference (`chNN`, `NN.N`, `Lab NN`) opens a peek panel without leaving the section, and `esc` returns focus to the reading position.
- Search for a term returns results in under 500 ms at p95 with filters by part, layer, source tier, verification age and type applied as WHERE clauses; the query instrument shows the measured time.
- The three reading paths track progress per account; resuming from another device lands on the same section.
- Chapter load is under 1 s at p95 for 20 pilot accounts × 10 concurrent users under k6, with an RSC payload under 150 KB per chapter.
- A PT label truncation snapshot suite passes with every string at least 30% longer than its EN counterpart in the fixture.
- Playwright runs the reader's primary flows in PT and EN with zero axe WCAG 2.2 AA violations; the global keyboard map works on every reader page.
- 20 pilot accounts are onboarded via SSO.

### Phase 2 — Assistant
- On the golden set (300 questions generated from the release, and what curators add: 301 in release 2026.09), at least 90% of answers carry a chapter citation on every claim, and the grounding grader reaches κ ≥ 0.7 against curator labels.
- Each of the four refusal causes produces a refusal before retrieval with zero gateway calls, a refusal code and a pointer to the covering section, verifiable in the ledger.
- A question whose draft contains an uncited claim ships with that claim replaced by "the book does not cover this", and the substitution is visible only after the final SSE event.
- A decision-aid walk on 37.8 with the book's P-101 inputs (2,000 queries a day, 400 output tokens and 4,000 cached input tokens a query, 10% escalated to reasoning, 90% routed to the small model) returns the chapter's own figure (3.4×: configuration A at $810 a month against C at $237.60) with a derive chip to line 24 and the source verification date.
- First token arrives in under 2 s at p95; the guide prefix is byte-stable across requests (cache hit visible in gateway usage).
- A flagged answer appears in the calibration set; message text is null after 30 days while citations and verdicts remain.
- Every answer is a ledger record with citations, verdicts, guide version and model id, and the chain verifies.

Amended 2026-10-04 with the Phase 2 gate (feature-specs/22 D1; 18 D5). The fourth criterion had carried the design screen's illustration (11 steps, a 36.5% review share, a 62% cache hit; 13× at line 142); it now states the inputs, the figure and the line of the release's own script, which is what "the chapter's own figure" means and what the gate computes. The first had said "the 300-question golden set"; the set is the 300 generated questions and one a curator added, and the rate is taken over the questions that expect an answer (251 of the 301).

### Phase 3 — IDE
- All 35 labs reproduce in the sandbox tier from the pinned files (the CI matrix reports 35/35 `REPRODUCED`; today 34, Lab 23 open).
- A sandbox is ready in under 5 s at p50 from a warm snapshot; the session ends and the microVM is destroyed on close, verified by the orchestrator's record.
- Editing one line of `lab-21/activities.py` and running produces `NOT REPRODUCED` with a diff table naming the diverging figure; Reset restores the pinned files and a rerun produces `REPRODUCED`.
- A run exceeding the 10-minute wall clock or 4 GiB is killed, recorded as `KILLED` with the message shown in the IDE, and counted in the account's kill metric; the sandbox kill rate is under 1% of sessions in staging.
- An attempt to reach a non-allow-listed host from user code is dropped, logged with the session id, and shown in the status bar denial counter; a sandbox has no route to the data tier or gateway (integration test).
- A sandbox for a lab that declares no model calls has no gateway key; a model lab's per-run allowance is refused at the gateway once exhausted; a user-supplied key never appears in any log (secret scanner count zero).
- A saved run's edited files and log are in object storage, shareable by link, and attachable to a suggestion as a tier-A item.
- Cost per session stays within the per-organisation IDE-minute budget in staging.

### Phase 4 — Improvement
- The four PRD worked examples run end to end as fixtures and produce the documented outcomes: Annex III date (B, 85) accepted and merged with a patch bump; social-media screenshot (G, 5) declined at intake with zero model tokens and tiers B or D named; Lab 22 repair cap on the contributor's own set (A × 0.6 = 60) returns request more naming a tier-A run on the chapter's lab; vendor cached-input price (C × 0.8 = 56, + 10 = 66) returns request more and is accepted only by a curator override recorded with `OV-IND-02`.
- Unit tests cover 100% of rubric branches: score is the maximum adjusted item plus at most one +10, never a sum; thresholds route by change class; derived-figure changes require a derive script diff in the branch.
- A suggestion without an anchor, with a rationale over 200 words, or whose anchor does not exist at the current version is rejected at intake with the sensor named.
- Curator-always classes (safety, OT-boundary, scenario parameter, structure, rubric, new source tier) never reach the adjudicator; OPA policy tests confirm `service:adjudicator` is denied `decision` on those classes and a curator outside the part is denied.
- The adjudicator's input, assembled by the workflow from ledger rows, contains no contributor name, employer or other suggestions (contract test on the prompt payload).
- On 100 curated suggestions, adjudication precision (accepted then reverted) is under 3% and curator override rate is under 10% overall; the override-rate meter shows per-criterion values and triggers a rubric review record when any criterion exceeds 20%.
- An accepted change opens a branch in the book repository, CI runs the lab suite, the merge is blocked when the chapter's own lab fails and proceeds when an unrelated lab fails, the version bumps by class, and the next release ingests with a matching render hash.
- Every ledger record from submission to merge verifies: recomputing hashes from `seq = from` to `to` matches each `prevHash`, and the exported JSONL trailer's head hash matches; a per-chapter export includes chain neighbours from other chapters.
- Three tier-U declines in 30 days set `throttledUntil` and new submissions return 429 with the reason.
- The rubric is published at `/[lang]/rubric` with tiers, factors, thresholds and examples, downloadable as JSON, and its version is recorded on every adjudication.
- An org admin can export an audit pack per account and per chapter, see the token budget by consumer, and the gateway refuses calls at the cap with no overage recorded in `BudgetLedger`.

Added 2026-10-05 with the plan (feature-specs/27, 39): of these, the sixth needs the hundred suggestions labelled by curators and one paid run, the seventh's "CI runs the lab suite" needs a host and a runner for the book, and the last's organisation admin needs organisational accounts; the gate reports each as blocked until then, and the rest are measurable on a development machine. The third worked example runs on a tier A fixture until the IDE can save a run.

### Capability 5 — Researcher
- An answered turn starts no research run and its answer is unchanged by research; a refusal starts none (until unit 75: an answered turn started a run and was neither changed nor slowed by it).
- A person's research obeys its limits: 30 runs a day, and none where their organisation switched research off.
- A marker word placed in a question appears in the planner's and the writer's requests and in no byte of the reader's request, of any search query or of any address fetched; the writer's request holds no tool.
- A page written to instruct the agent cannot make it act: whatever it proposes is validated in code and graded like any other, and nothing is written to a content table.
- Every evidence item of every researcher suggestion was opened by the product's own fetcher and has its graded text stored with its hash.
- No researcher suggestion is merged without a curator's accept, verifiable in the ledger.
- A finding Improve refutes leaves its records in the ledger, no item in any queue, and nothing shown to the reader but "nothing to propose".
- The whole road runs once end to end, from the Research page: an answer's `Start a research`, the run, its report, a finding sent to Improve and accepted, the proposal shown, a name added, a curator's accept, the merge, the history's `research` mark and the endorser's credit.
- A run spends the person's own budget and stops at their cap; Improve's vetting of a sent finding spends the platform's research principal, and at its cap the gateway refuses and nothing exceeds it.
- After 30 days a reader's words are gone from the research rows and were never in a workflow's history.
- The provider's web tools pass through the gateway and their cost is recorded.

No criterion sets a quality bar for the proposals themselves. The gate reports what a run costs, what it yields, what Improve does with it and how often a curator accepts, and a target is set after the first month of real runs.

### Cross-cutting
- Availability: 99.5% for reading and search, 99% for the IDE and assistant, measured monthly; adjudication completes within 24 hours for automatic classes (decision under 10 minutes) and within the SLA shown in the queue for curator classes.
- All data, backups, observability and the gateway run in São Paulo; a deletion request is fulfilled within 30 days and the ledger retains only a pseudonym.
- OTel spans exist for every model call, sandbox session, adjudication and policy decision with the attributes in TRD section 9, and one dashboard exists per headline metric (weekly return rate, lab run rate, citation and flag rate, adjudication precision) plus one for leading indicators.
- Fail-closed is demonstrated: OPA unreachable returns 403, gateway unreachable refuses the model call, orchestrator unreachable refuses the session, and a CI webhook with a bad signature is discarded.
- No leaderboard query exists in the schema or API; the credit list is alphabetical.
