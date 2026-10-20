# AI Workflow Rules

These are rules for any AI coding agent working in this repository. They are commands, not advice. Read them before the first edit of every session.

The spec is the four companion files in `context/` plus the sources they cite:

| File | Authority over |
|---|---|
| `context/project-overview.md` | what the product does, the user flow, scope, success criteria |
| `context/architecture.md` | stack, containers, folders, storage, auth, agents, invariants |
| `context/ui-context.md` | every visual decision: tokens, components, layout, icons |
| `context/code-standards.md` | how code is written: TypeScript, Next.js, API, data, tests |
| `specs/PRD — Harness Bible Interactive.pdf`, `specs/TRD — Harness Bible Interactive.pdf`, `docs/design/` | the primary sources the four files summarise |

When two of these disagree, the order of precedence is: architecture § 11 invariants → TRD → PRD → UI package → the four context files. Report the disagreement; do not resolve it silently.

## 1. Approach

1. Build from the spec, not from memory of similar products. Before writing code for a unit, open the section of the context file that governs it and quote the rule you are implementing in your plan.
2. Build incrementally. Every change leaves the repository in a state that type-checks, lints, and passes the tests that existed before the change plus the tests the change adds.
3. Follow the build order: Phase 1 Reader → Phase 2 Assistant → Phase 4 Improvement → Phase 5 Researcher → Phase 3 IDE (Andre, 2026-10-05; architecture § 3.3; until that date the order was 1, 2, 3, 4). Do not create a component, table, route or dependency of a phase that comes later in that order while working in an earlier one, even as a stub. Inside Improvement and the researcher the order is the unit list of `feature-specs/27-improve-and-researcher-plan.md` § 7.
4. Implement exactly what the unit asks. Do not add a feature, option, flag, abstraction, configuration key or "nice to have" the unit did not name.
5. Treat the four context files as the contract. If the code you are about to write would violate a rule in them, stop and report; do not write it and note it as tech debt.

## 2. Scope

1. Work on one unit at a time. A unit is one of: one route and its page component; one API endpoint with its schema and contract test; one component and its test; one query module; one workflow or activity; one sensor; one migration; one policy file; one documentation update. Finish it, verify it (section 7), then start the next.
2. Do not combine units. A prompt that asks for "the reader" is a request to propose the unit list, not to build everything. Propose the list, get it confirmed, then build the first unit.
3. Touch only the files the unit requires. Do not reformat, rename, reorder imports in, or "clean up" a file you are not changing for the unit's purpose. If you find a defect elsewhere, record it in your report and leave the file alone.
4. Make no speculative changes. Do not add a helper because a future unit might need it, a prop because a design might use it, or an index because a query might be slow. The third real caller earns the abstraction, not the first imagined one.
5. Do not install a dependency the architecture does not list without stating the package, its size, its licence, the rule that permits it, and getting confirmation. The forbidden list is explicit: no icon library, no chart library, no UI kit, no CSS-in-JS, no ORM other than Prisma, no state library, no tRPC, no Monaco.
6. Do not change a public contract (an API schema in `lib/schemas/api/`, a Prisma model, a Rego policy, a ledger record kind, a message key) inside a unit that was not scoped to change it. Propose a separate unit.
7. Stay inside the repository. Do not edit `specs/`, `bible/`, or anything outside the app folder. Do not modify system settings, global git config, or files under the user's home directory.

## 3. When to split

Split a unit into smaller units, and say so before starting, when any of these holds:

1. The change touches more than one of: `app/`, `components/`, `lib/`, `workers/`, `pipeline/`, `sandbox/`, `policies/`, `prisma/`.
2. The change needs a migration and code that reads the new column. Ship the migration first as its own unit (forward-only, additive), then the code.
3. The change needs a new schema in `lib/schemas/` and a consumer of it. Ship the schema with its unit test first.
4. The change adds a new hb.css component class. Ship the `globals.css` and `ui-context.md` update first, then the component that uses it.
5. The estimated diff exceeds about 300 lines excluding tests and generated files.
6. The change requires a decision listed in architecture § 12 (open decisions) or a rule that does not yet exist in the context files.
7. You cannot write the verification steps for the unit in advance. If you cannot say how you will prove it works, the unit is too large or too vague.

Never split by layer across time in a way that leaves an unwired piece: a schema with no consumer is fine for one unit; a route handler that returns a hard-coded object is not.

## 4. Missing or ambiguous requirements

Do exactly this, in order, when something the unit needs is undefined:

1. **Search the spec first.** Grep the four context files, then the TRD text, then the PRD text, then the 18 screens in `docs/design/screens/`, for the term. Most "missing" requirements are in the TRD's endpoint catalogue (architecture § 3.4), the schema (§ 4.2), the sequence flows (§ 6.3) or a screen's status bar.
2. **If the spec answers it, cite the location** (`architecture § 5.6`, `TRD § 6.1`, `Labs-IDE.html status bar`) in your plan and proceed.
3. **If the spec is silent and the choice is routine** (a variable name, a file name that follows the naming rules, the order of two independent fields, a test fixture value drawn from the specs' named ids), decide it, state the decision in one line in your report, and proceed.
4. **If the spec is silent and the choice is material** (a new table or column, a new endpoint or response field, a threshold or limit, a role's permission, a user-visible string's meaning, anything that touches an invariant, money, tokens, identity, the ledger, the sandbox or a model call), stop. Write the question in this form and wait:

   ```
   BLOCKED · <unit name>
   Needs: <the single decision required>
   Spec searched: <files and sections checked, none answered>
   Options: A <…> / B <…>
   Recommended: <A or B> because <one line citing a rule>
   Impact if wrong: <what would have to be redone>
   ```

   Do not implement the recommendation while waiting. Finish every part of the unit that does not depend on the answer, verify that part, and report.
5. **Never invent a number.** No default threshold, cap, timeout, rate limit, page size, retry count or price that the spec does not state. If the TRD does not give it, it is a material decision under rule 4.
6. **Never invent a user-visible string.** Every label, error, status and empty-state text comes from a screen in the UI package or from the voice rules in ui-context § 11. If neither has it, write the EN and PT candidates in your report and mark the key `TODO(#issue)` in `messages/`; do not ship placeholder text like "Lorem" or "Something went wrong".
7. **Never widen scope to resolve ambiguity.** "The spec does not say, so I built both" is a violation. Build neither and ask.
8. **Do not assume a later phase's answer.** If a Phase 1 unit seems to need the gateway, the workflow engine or the sandbox, the unit is mis-scoped; report it. The same holds in the order of rule 1.3: an Improvement or researcher unit that seems to need a sandbox or a saved lab run is mis-scoped, because the IDE comes after both.

## 5. Files you do not modify without explicit instruction

Do not edit these unless the unit names the file and the instruction says to change it:

| File or folder | Reason |
|---|---|
| `context/*.md` | The contract. Change only in a unit scoped to documentation, or as the paired update rule 6 requires, and say what changed and why. |
| `app/globals.css` token block (`:root`, dark theme, `@theme inline`) | Tokens mirror hb.css v0.9.0 exactly. A token change is a design change and needs the UI package updated first. |
| `app/globals.css` `@layer components` | Ported hb.css classes. Add a class only in a unit scoped to it, with the matching `ui-context.md` edit. Never restyle an existing class. |
| `prisma/schema.prisma`, `prisma/migrations/` | Schema changes are their own unit; migrations are forward-only and never edited after commit. |
| `lib/schemas/api/`, the generated OpenAPI document, `lib/api/client.ts` | Public contract. Regenerate the document and client in the same unit as any schema change; never hand-edit generated output. |
| `lib/rubric/`, `lib/ledger/` | Score arithmetic and the hash chain. Any change needs the four PRD worked examples still passing and 100% branch coverage. |
| `lib/api/handler.ts` | The fixed handler pipeline. It has no opt-out flags; do not add one. |
| `lib/db/client.ts` | The tenant-filter extension. Do not bypass it; raw SQL goes in the two permitted files and `RAW_SQL.md`. |
| `policies/*.rego` | Authorisation. Every change ships with the deny-case tests. |
| `rubric/<version>/`, `guides/<agent>/<version>/` | Pinned by hash. Never edited in place: a change is a new version in a unit scoped to it. |
| `lib/db/improve.ts` | The one door to the improvement rows, which sit outside the tenant filter. Every read takes the caller; do not add a function that returns a `User` field to a service or that reaches a research run from a suggestion. |
| `workers/fetch/guard.ts` | The only thing between a stranger's URL and the deployment's network. Any change ships with a test for the address range or redirect it concerns. |
| `workers/agents/researcher/` | The planner's and the reader's may-read lists are the product's privacy boundary (architecture invariant 33). Adding a field to either is an architecture change. |
| `workers/agents/*/assemble.ts` | Prompt assembly and the may-read lists. Adding a field to an agent's input is an architecture change. |
| `messages/en.json`, `messages/pt.json` | Edit both or neither; never delete a key another file still uses. |
| `package.json` dependencies, lockfile, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs` | Toolchain. Change only when a unit is scoped to it and the reason is stated. |
| `.gitignore`, CI workflow files | Repository policy. |
| `specs/`, `bible/`, anything outside this repo | Read-only sources. |
| Anything under `node_modules/`, `.next/`, generated types | Never. |

If a unit cannot be completed without touching a protected file, stop and report under section 4 rule 4.

## 6. Keep documentation in sync

1. The context files describe the code as it is, not as it was planned. When a unit changes something a context file states, update that file in the same commit. The pairs are fixed:
   - `app/globals.css` ↔ `context/ui-context.md`
   - a new folder, module, container, route or endpoint ↔ `context/architecture.md` § 3
   - a new rule you had to decide under section 4 rule 3 ↔ `context/code-standards.md` if it is a code convention, `context/architecture.md` § 12 if it is an assumption
   - a changed scope, flow or success criterion ↔ `context/project-overview.md`
2. Every decision made under section 4 rule 3 or rule 4 is recorded in architecture § 12 (assumptions) with the date and the unit that made it, so the next agent does not re-decide it.
3. Do not document what the code already says. No file-by-file narration, no API docs that repeat the OpenAPI document, no comments that restate the line below. Document the why and the rule.
4. Never leave a context file describing a file, function or flag that no longer exists. When you delete or rename, grep `context/` for the old name and fix every reference.
5. `README.md` at the repo root is the public project page (since 2026-10-14, when Andre decided to publish the project on GitHub): what this is, why it is interesting, how to run it, and links to `docs/`. Keep it a page, not a manual.
6. The documentation set is the context files, the feature specs, and the public set Andre asked for on 2026-10-14: `README.md`, `docs/` (the walkthrough, getting started, the public architecture overview, how it was built, `docs/images/`), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` and `.github/`'s templates. The public set explains the project to visitors; the context files remain the source of truth for building it. Do not create other documentation files: if something does not fit, it belongs in one of these or it is not documentation. When a unit changes what the public set shows (a screen, a command, a setting), update it in the same unit.

## 7. Verification before moving on

Run this list at the end of every unit. Report each item with the actual command output, not a summary. A unit is not done until every applicable item passes.

1. **Type check.** `npx tsc --noEmit` exits 0. No new `@ts-ignore`, `@ts-expect-error`, `as any` or `!`.
2. **Lint.** `npm run lint` exits 0 with zero warnings.
3. **Unit tests.** `npx vitest run` passes; the unit added at least one test for every new pure function and every new branch. `lib/rubric/` and `lib/ledger/` stay at 100% branch coverage.
4. **Contract, policy, integration tests** where the unit touched an endpoint, a Rego file or a workflow: the corresponding suite passes in its container.
5. **Token grep.** Searching the diff for `#[0-9a-fA-F]{3,6}`, `rgb(`, `hsl(`, `rounded`, `shadow-`, `truncate`, `line-clamp`, `transition-`, `animate-` returns matches only in `app/globals.css`.
6. **Message parity.** Every key added to `messages/en.json` exists in `messages/pt.json` and vice versa; no string literal was added to JSX except ids, versions, hashes, code and glyphs.
7. **Build.** `npm run build` succeeds when the unit touched `app/`.
8. **Run it.** Start the dev server, open the route the unit affects, and confirm the behaviour the unit specified. State what you opened and what you saw. If the unit is a component, render it in the screen that uses it; a component nobody renders is not verified.
9. **Screen match.** For a UI unit, compare against the PNG in `docs/design/png/` for structure, labels, states and status-bar cells. List every deliberate difference.
10. **Invariant check.** Re-read architecture § 11 and state which invariants the unit could have violated and how you confirmed it did not (for example: "§ 11.3: no write to a content table; grep for `prisma.section.update` returns nothing").
11. **Scope check.** `git status` shows only the files the unit named plus their tests and the paired documentation. Anything else is reverted or explained.
12. **Documentation.** The paired context file edits from section 6 are in the same commit.
13. **Report.** End with: what was built, the verification output for items 1 to 11, decisions made under section 4 rule 3, anything BLOCKED under rule 4, defects noticed outside scope, and the proposed next unit. Do not claim a step passed that you did not run. If a step failed, show the failure and stop; do not move to the next unit.

## 8. Things you never do

1. Never run a destructive git command (`reset --hard`, `push --force`, `checkout -- .`, `clean -f`) or delete a migration, a ledger-related file or a test to make something pass.
2. Never skip hooks, disable a lint rule inline, lower a coverage threshold, or mark a test `skip` or `todo` to get green.
3. Never put a secret, a token, a key or a real credential in code, config, a test fixture, a log line or a prompt template. Use `lib/env.ts` and the vault placeholders.
4. Never call a model provider directly, add a provider SDK, or add code that could reach one outside `lib/gateway/client.ts` in `workers/`.
5. Never write to a content table, update or delete a ledger record, or bypass `lib/ledger/append()`.
6. Never let a model output set a score, threshold, decision or figure. Recompute in code.
7. Never render a figure without its provenance mark, a status by colour alone, a truncated label, a spinner, a toast, an icon library or a rounded corner.
8. Never invent a number, a string, a role permission or a phase-ahead component to fill a gap. Stop and ask under section 4 rule 4.
9. Never report work as done that you did not run and verify. "Should work" is a failure report.
10. Never continue past a failed verification step, a BLOCKED question, or a protected-file conflict.
11. Never request a URL that a user or a model supplied except through `workers/fetch/`, and never from the web tier.
12. Never give the researcher's reader anything of a reader's turn, never give the planner a tool, and never pass a person's or a model's text as a workflow or activity argument.
13. Never move a suggestion of origin `RESEARCHER` to `MERGING`, or write to the book's repository for one, without a curator's accept on record.
14. Never start a run against a real model provider on your own initiative: the golden runs, the curated-suggestions run and the researcher's first real call are Andre's to start. Give him the command and the estimate.
