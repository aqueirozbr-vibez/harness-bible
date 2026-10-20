## What and why

<!-- One unit of work: what changed, and what a reader of the log needs to know. -->

## Spec

<!-- The spec section this implements or restores, e.g. context/feature-specs/48-research-agent.md § 11.
     A change in behaviour needs the spec (new or amended) agreed first. Link the issue. -->

## How it was verified

<!-- The commands you ran and what you opened in the browser. -->

- [ ] `npx tsc --noEmit` and `npm run lint`: zero errors, zero warnings
- [ ] `npm test`
- [ ] `opa check policies && opa test policies -v` (if `policies/` changed)
- [ ] `npm run test:ledger` / `npm run test:rubric` (if `lib/ledger/` or `lib/rubric/` changed)
- [ ] `npm run api:openapi`, with the regenerated `openapi.json` committed (if an API schema changed)
- [ ] `npm run secrets:scan` (if a prompt, a guide or anything a model reads changed)
- [ ] `npm run test:e2e` and `npm run test:layout` (if a page changed), with screenshots in light and dark, EN and PT
- [ ] `npm run build`

## Checklist

- [ ] One unit; a migration, if any, is forward-only and in its own pull request
- [ ] Every new user-visible string is in both `messages/en.json` and `messages/pt.json`
- [ ] The context files (`context/*.md`) still describe the code: updated here where this changes what they state
- [ ] No invariant of `context/architecture.md` § 11 is broken (say which ones this could touch, and why it does not)
- [ ] No key, token or credential anywhere in the diff, the tests or the screenshots
- [ ] Nothing here needs a real model provider to pass
