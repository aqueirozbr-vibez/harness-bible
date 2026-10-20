# Contributing

Thank you for wanting to improve Harness Bible Interactive. This repository is the app. **The book's content
(chapters, figures, source rows, labs) lives in its own repository.** Propose content changes there, or run the app
and propose them through Improve, which is what it is for.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), as the rest of the
app is, and that you will follow the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

Follow [docs/getting-started.md](docs/getting-started.md). The whole development loop, including every test suite,
runs on the stub gateway with **no model key**. Please keep it that way: a test or a script that needs a real
provider to pass is not mergeable.

## Specs first

Behaviour is specified before it is built. The contract is the set of files in [`context/`](context/):

1. [`context/project-overview.md`](context/project-overview.md): what the product does, its scope, its success
   criteria.
2. [`context/architecture.md`](context/architecture.md): the system, and in § 11 the **invariants**. A change that
   breaks one is a defect, whatever its tests say.
3. [`context/ui-context.md`](context/ui-context.md): tokens, components, layout. Radius 0, no shadows, no icon
   library.
4. [`context/code-standards.md`](context/code-standards.md): TypeScript, Next.js, API, data, tests.
5. [`context/ai-workflow-rules.md`](context/ai-workflow-rules.md): scoping, splitting, verification. It is written
   for AI agents, and it is a good checklist for people too.

Each feature has a spec in [`context/feature-specs/`](context/feature-specs/). So:

- **A bug fix** that restores what a spec already says needs no spec change. Cite the section it restores.
- **A change in behaviour** starts as an issue, then a new spec or an amendment to an existing one, agreed before
  the code. Write decisions down as the specs do: the options, the choice, and why.
- **When the code changes something a context file states**, update that file in the same pull request. The context
  files describe the code as it is.

[docs/how-it-was-built.md](docs/how-it-was-built.md) explains the method in more detail.

## Small units

Keep a pull request to one unit of work: one route, one endpoint with its schema and contract test, one component,
one migration, one workflow, one sensor, or one policy file. Split it if it crosses more than one of `app/`,
`components/`, `lib/`, `workers/`, `pipeline/`, `policies/` and `prisma/`, needs a migration and the code that reads
it, or goes past about 300 lines without tests. A migration is forward-only, additive, and ships in its own pull
request.

## Branches and commits

Branch from `main` and open the pull request against `main`. Name the branch for the change, for example
`fix/queue-row-focus` or `feat/research-export`.

Commit subjects follow the history's form, `type(scope): what changed`, with the spec section in parentheses when
there is one:

```text
feat(research): the export of a research as signed JSONL (spec 48 § 16)
fix(queue): an item's row selects it wherever it is clicked
docs(48): spec 48, the research agent
```

The types in use are `feat`, `fix`, `docs`, `test` and `chore`. The scope is the area, or the spec or unit number.
Write the subject in plain words: what a reader of the log needs to know. Keep fixes in new commits rather than
rewriting shared history.

## What to run before you push

What CI runs (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)), at least for what you touched:

```bash
npx tsc --noEmit && npm run lint            # zero errors, zero warnings
npm test                                    # Vitest: unit, contract, integration, workflows
opa check policies && opa test policies -v  # if you touched policies/
npm run test:ledger                         # if you touched lib/ledger/ (100 % branch coverage)
npm run test:rubric                         # if you touched lib/rubric/ (100 % branch coverage)
npm run api:openapi                         # if you touched an API schema: commit the regenerated openapi.json
npm run secrets:scan                        # if you touched a prompt, a guide or anything a model reads
npm run test:e2e && npm run test:layout     # if you touched a page: EN and PT, axe, no truncation
npm run build
```

Also:

- Every user-visible string goes in **both** `messages/en.json` and `messages/pt.json`. Portuguese runs longer, and
  layouts must not truncate.
- For a UI change, attach screenshots in light and dark, and in EN and PT where the strings changed.
- Guides (`guides/<agent>/<version>/`) and rubric versions (`rubric/<version>/`) are pinned by hash and never edited
  in place. A change is a new version.

## Things a pull request must not do

- Call a model provider, or add a provider SDK, anywhere but through the gateway client in `workers/`.
- Put a key, a token or any secret in code, configuration, a fixture, a log line or a prompt.
- Let a model's output set a score, a threshold, a decision or a figure. Recompute it in code.
- Write to a content table, or update or delete a ledger record.
- Invent a number (a limit, a timeout, a price) or a user-visible string that no spec gives. Ask in the issue
  instead.
- Add a dependency without saying in the issue what it is, its size, its licence and why the architecture allows it.
  An icon library, a UI kit, CSS-in-JS, a state library or a second ORM will not be accepted.

## Working with an AI agent

Welcome. [`CLAUDE.md`](CLAUDE.md) and [`context/ai-workflow-rules.md`](context/ai-workflow-rules.md) are the agent's
instructions. Point your agent at them, and review its work as you would a colleague's: you are the author of what
you submit.

## Questions

Open a [question](.github/ISSUE_TEMPLATE/question.yml) issue. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead.
