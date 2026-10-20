# 37 · Merge and release — feature spec (the book's repository, `MergeWorkflow`, the chapter's check, the curator's merge, the version bump and the release, Chapter-History, a revert)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: PRD requirement 7 ("accepted changes open a branch; the chapter's lab re-runs; the change merges only if the lab still reproduces; the chapter's version bumps by the book's rule"); TRD § 4.5 (the flow back), § 7.6 (the sequence); architecture § 4.5, § 6.3 and invariants 1, 2, 3, 5 and 27; the screens Improve-Record (Version, Lab gate, Source row, Credit) and Chapter-History; Andre's answer A10 of 2026-10-05: a local Git repository of the book, the hosted pull request and the CI webhook deferred.

**What exists**: the book is a folder (`BOOK_DIR`, `../bible`) that is not a Git repository and has no remote; the pipeline only reads it; `Release.gitSha` is a hash of the files' paths and contents, not a commit. Nothing writes to the book.

Prerequisite specs: `04-content-domain-schema.md` (the pipeline, `renderHash`), `12-retrieval.md` § 4.2 (the embedding job), `18-decision-aid-walk.md` (the runner that executes a chapter's script), `33` (§ 4.1, `applyProposal`; § 6, the outcomes), `36` (the curator's signal).

Scope: tracker unit 54 (54a to 54e).

## 1. Purpose

Invariant 3 is the reason this capability exists in the shape it has: content changes only through a branch in the book's repository, a check, a curator's merge, a release and ingestion. Everything before this spec decides whether a change should happen. This spec is the only place where it does, and it must leave the reader exactly as a hand-made release would: new immutable rows, a matching render hash, `Release.current` moved.

## 2. Dependencies and order

| Unit | Delivers |
|---|---|
| 54a | the repository's configuration and the Git adapter |
| 54b | `MergeWorkflow` up to a branch that passed, or failed, the chapter's check |
| 54c | the curator's merge: version, release, ingestion, the `merged` record |
| 54d | Chapter-History |
| 54e | a revert |

## 3. The book's repository (54a)

- **Configuration**: `BOOK_REPO_DIR`, the path of a Git repository holding the book, set by the operator. Unset, every merge refuses with `BOOK_REPO_UNAVAILABLE` and accepted suggestions wait in `MERGING` with that reason shown; nothing else in Improve depends on it.
- **Making it on this machine** is the operator's act, documented in the tracker's session notes: a repository initialised from the book folder, one commit, the tag `release/2026.09` on it. The application never initialises, clones or deletes a repository.
- **The source folder is never written.** `BOOK_DIR` stays what it is. Rules § 2.7 keeps any agent out of `bible/`; the product writes only inside `BOOK_REPO_DIR`.
- **The adapter** (`pipeline/git.ts`): the `git` executable through `execFile` with an argument array (no shell, no dependency). It works in worktrees of its own under the repository, so the operator's checked-out tree is never touched or required to be clean. Operations: read a file at a ref; create `improve/<id>-<slug>` from `main`; write files and commit; fast-forward `main`; tag; diff two refs; delete a merged branch. Commits are authored by the product's own identity, with trailers naming the suggestion, the rubric version, the curator's pseudonym and the record's hash. No name of a contributor is written into the repository by the product: credit lives in the history page, where consent governs it (D2).
- **Identity of a release**: once the repository exists, a release is a tag and `Release.gitSha` is the tagged commit. The tree hash the pipeline computes today stays as a second check that the files ingested are the files tagged.
- **The write key**: architecture § 2.2 gives the pipeline a write-scoped deploy key for a hosted repository. Locally there is no key; the constraint it stood for is kept by construction: only `pipeline/git.ts` writes, only under `improve/*` branches and the fast-forward of 54c, and a lint rule keeps the adapter out of everything but the merge activities.

## 4. From an accepted change to a checked branch (54b)

`MergeWorkflow({ suggestionId })`, id `merge:<id>`, a child of the suggestion's workflow, started when a person's suggestion is accepted by the adjudicator or any suggestion is accepted by a curator.

### 4.1 Prepare

1. Read the chapter's files at `main`. Check the anchor still reads what the suggestion recorded (`contentSha256`); if `main` moved under it, the merge stops and the suggestion returns to the curator with the two texts.
2. `applyProposal` (spec 33 § 4.1). For a source row the edit also sets the row's verification date to the day of the decision ("commit change + source row date", TRD § 7.6).
3. **A shared figure.** If the cross-chapter sensor warned, the edit is applied at every anchor that reads the figure, in every chapter named. If any of those cannot be edited automatically, the merge is not attempted: the curator sees which, and makes that part by hand (§ 4.3).
4. **A derived figure** (invariant 5): refused unless the branch will touch `DeriveLink.filePath`. In this build that means a curator's own commit on the branch, since no lab run can be attached yet.

### 4.2 Branch and commit

The branch `improve/S-36-0198-<slug>` (the slug from the anchor and class, ASCII), one commit with the files `applyProposal` returned. `Merge.branch`, `versionFrom`.

### 4.3 A curator's hand

Some accepted changes cannot be applied by a function: a restructure, a shared figure in a place the parser cannot edit, a derived figure whose script must change. For those the workflow makes the branch empty of content and stops at `needs a manual commit`; the curator commits to that branch in the repository and presses `Re-run check`. The product verifies what it can: the branch exists, descends from `main`, and its diff touches the anchored chapter. This is the build's version of "the curator merges the pull request": the review happens in the repository.

### 4.4 The chapter's check

The PRD's condition: "the change merges only if the lab still reproduces". There is no CI and no sandbox tier yet, so the check is what this machine can run on the branch's tree:

1. **The pipeline's dry run** over the branch: it parses every chapter, links derived figures and computes the render hash a release of that tree would have. A parse failure, an unlinked derived figure in the changed chapter, or a figure whose text no longer matches its derive link fails the check.
2. **The chapter's own lab**, when it has one and a runner is configured: its derive script is run by the runner of spec 18 (a container with no network) and the values it prints are compared with the chapter's derived figures as the branch states them. A difference fails the check and names the figures.

Only the changed chapter's lab is run. The state of every other lab is reported beside the result as the release holds it (`Lab.ciVerdict`), which is the screen's "book suite · 34 / 35 reproduce" and its sentence that an unrelated, pre-existing failure does not block.

`Merge.check` records both results, the hash, and the runner's output key. When no runner is configured the second part is `not run` and the check says so in the record and on the page; it does not pass silently.

### 4.5 After the check

| Result | Then |
|---|---|
| passed | the suggestion appears in the queue's "Ready to merge" group, with the diff |
| failed | the suggestion returns as `REQUEST_MORE` with the check's output (the TRD's "blocked; suggestion returned as request more"); the branch is kept for the curator |
| could not run | `MERGING` with the reason; `Re-run check` |

## 5. The curator's merge (54c)

A curator of the part chooses `Merge` on a "Ready to merge" item (`POST /curation/{id}/decision` with action `MERGE`; the same endpoint, policy and signal as any decision). The workflow then, each step an idempotent activity:

1. **Version.** The chapter's version bumps by the book's rule: patch for wording, figures, a new claim or a new source row; for a restructure the curator chose minor (a new section) or major (structure) when accepting. The version is written where the pipeline reads it and the book's changelog gains its line; 54c reads the pipeline to say where, and reports it.
2. **Fast-forward** `main` to the branch. If `main` moved since the check, the workflow returns to § 4.1 on the new `main` and the check runs again; a curator never merges an unchecked tree.
3. **Release.** A tag `release/<id>` on the new `main`. Every merge is a release, as in the TRD's sequence. The id's form is D1.
4. **Ingestion.** The pipeline ingests the tag into a new release: new rows for every chapter (invariant 1), the render hash compared with the one the check computed for the same tree (invariant 2; with a CI later, with CI's). A mismatch stops here: the release is not published, `Release.current` does not move, the suggestion stays `MERGING` with the alert.
5. **Publish.** `Release.current` moves and the data cache is revalidated, by the pipeline's own release procedure (architecture § 10).
6. **Vectors.** The embedding job runs for the new release (spec 12 § 4.2). Until it finishes, search and the assistant say `indexing` and work lexically, as they are built to.
7. **Record.** The `merged` ledger record, on the new chapter version: branch, commit, versions, releases, render hash, the check, the contributor's and the endorser's pseudonyms, the curator's. Then `MERGED`, then `CLOSED`.

What a new release means for the rest of the product, none of it new behaviour: a conversation pinned to the earlier release answers `RELEASE_CHANGED` (spec 15); open drafts keep working when their anchor's content is unchanged, since intake compares content, not row ids (spec 31 § 5); the golden set is the previous release's until regenerated.

## 6. Where this appears to people

- **The queue**: the "Ready to merge" group; the detail shows the diff of the branch against `main`, the check's two results, the version it will become, and `Merge`. A failed check shows its output and `Re-run check`.
- **The record page's right rail** (spec 35 § 5), now filled: **Version** (`v1.3.2 → v1.3.3`, `patch`, branch, commit, merged by); **Lab gate** (the chapter's lab or `none`, the lint, the book's suite as last known, the sentence about an unrelated failure when there is one); **Source row** (the verification date before and after, the row's age today); **Credit**.

## 7. Chapter-History (54d)

`/[lang]/ch/[n]/history`, public, RSC; `GET /api/v1/chapters/{n}/history`, public. The reader's chapter instrument has linked here since Phase 1; its count becomes the number of rows this page lists.

The screen is the layout: the header with version, verification date and the lab's state; the stat strip (versions, contributed changes in the current text, curator overrides, reverted, the bump rule); the **Version ledger**, newest first (`version · date · change class · anchor · summary · evidence · contributor · curator · record`); the right rail (**Contributor credit**, alphabetical; **What changed, by layer**; the chain check).

- A row is a `merged` record, or a release in which the chapter's version changed with no suggestion (an editorial release: `release`, `editorial`).
- **Credit** lists people in alphabetical order with how many of their accepted changes are still in the text. It is not ordered by that number and no other page ranks anyone (invariant 26). A person appears by name only while their consent stands.
- **A change that began as research** carries the mark `research` in its class cell. Its contributor cell holds the reader who endorsed it, or a dash. "No edit is attributed to the agent" stays printed under the credit list and stays true: the mark says where a change came from; credit is for people (spec 42 § 7).
- `summary` is composed from the proposal by the record's presenter; it quotes the book's own before and after, never a rationale.
- `Export chapter records` is the ledger's export in its `chapter` scope.

## 8. A revert (54e)

A curator of the part may revert a merged change, from its record or from the monthly sample (spec 36 § 7.2), with a note. A revert is a merge in the other direction: `applyProposal` with before and after exchanged against the current text, the same check, the same release steps, its own `curator` and `merged` records, the second with `reverts` naming the first. The history shows the pair as the screen does (`revert · curator`; the reverted row struck, with `reverted in v1.2.2`), and the original counts in adjudication precision (spec 36 § 6.1).

## 9. Deferred until the book has a host

- A branch pushed to a remote, a pull request opened on it, and its review there.
- `POST /webhooks/ci`: the lab suite's results by signed webhook, and with it the full suite on every merge.
- The write-scoped deploy key.

When they arrive they replace § 4.4's second part and § 5's step 2; nothing else in this spec changes.

## 10. Out of scope

- Batching several merges into one release.
- Merging two accepted suggestions that touch the same anchor: the second finds `main` moved (§ 4.1) and returns to the curator.
- Any write to the book outside `improve/*` and the fast-forward.

## 11. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | The id of a release made by a merge | the year and month of the merge, with a serial from the second release of a month (`2026.10`, `2026.10.2`) | today's ids are `2026.09`; the form must stay sortable and say when. The schema that validates release ids is read first, and if it cannot hold the serial that is its own unit |
| D2 | Contributor names in commits | none; a pseudonym in a trailer | a repository is copied and never forgets; consent can be withdrawn (architecture § 4.4) |
| D3 | One release per merge | yes | the TRD's sequence; a reader sees an accepted change the same day |
| D4 | The check without a runner | reported as `not run`, and the merge allowed only for classes that cannot change a derived figure (wording, a new claim, a new row) | a silent pass would break the PRD's condition; blocking every merge on a machine without Docker would make the build untestable |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

Against a repository the test makes in a temporary folder from fixture chapters.

1. The adapter: a branch, a commit and a fast-forward leave the test's own checked-out tree untouched; an argument containing shell syntax is passed literally.
2. The PRD's first example completed: from spec 33's accepted fixture, a branch `improve/S-36-…`, the check passed, the curator's `Merge`, a patch bump, a tag, a new release whose render hash equals the check's, `Release.current` moved, the source row's verification date changed, the `merged` record, `MERGED`. The reader at `/en/ch/36/36.3` shows the new text.
3. The gate's merge criterion: with the changed chapter's lab made to fail, the merge is blocked and the suggestion returns as request more; with another chapter's lab failing and this one passing, it proceeds and the record says the other failure is unrelated.
4. A derived-figure branch that does not touch the derive file is refused (invariant 5).
5. `main` moved between check and merge: the check runs again before anything is tagged.
6. A render hash mismatch (forced in a double): nothing is published and `Release.current` is unchanged.
7. Invariant 3: a grep for writes to content tables finds only the pipeline's ingestion; the workers killed between steps 3 and 4 and restarted produce one tag and one release.
8. Chapter-History for the fixture chapter: the merged row, the credit list alphabetical, the revert pair after a revert; the page against the PNG with each difference listed; zero axe violations; in the truncation suite.
9. A revert restores the text byte for byte, bumps the version, and the original appears in precision's numerator.
10. With `BOOK_REPO_DIR` unset, an accepted suggestion waits in `MERGING` with the reason and no file anywhere was written.

## 13. As built (unit 54a: the book's repository, 2026-10-09)

The configuration and the Git adapter of § 3 are built. The repository itself is the operator's to make, and the product never makes one. Nothing calls the adapter yet: the merge activities that will are 54b's.

- **`BOOK_REPO_DIR`** (`lib/env.ts`, `.env.example`): the repository's folder. `openBookRepo` checks that it is set, exists, is a Git repository and has a `main`; anything else is `BOOK_REPO_UNAVAILABLE`, and the error names what is missing. `.env.example` gives the operator's commands, and the tracker's session notes give them for this machine.
- **The adapter** (`pipeline/git.ts`) runs the `git` executable through `execFile` with an argument array: no shell, no dependency.
  - **Its environment is made, not inherited**: the path; Windows' own root; no system configuration and a user configuration that does not exist (so no line-ending conversion, signing prompt or credential helper of the machine changes what it writes); no prompt; the C locale. The product is author and committer: `Harness Bible <improve@harness-bible.local>`.
  - **Its worktrees are its own**, under the repository's git directory (`.git/hb-worktrees/`), each removed after its operation, and one left by a step that died removed before the next. The operator's checked-out tree is never touched nor required to be clean.
  - **The operations**:
    - `readFileAt` and `listFilesAt`, a file and a folder at a ref;
    - `resolveRef`;
    - `improveBranchOf`, `improve/S-36-0198-<slug>` from the words given, lower-case ASCII, at most six words;
    - `createImproveBranch`, from `main`'s tip with no checkout, the branch already there being the one;
    - `commitFiles`, the files written and committed in a worktree on the branch, with the product's identity, the step's own date and the trailers (`Suggestion`, `Rubric-Version`, `Curator`, `Record`); nothing committed when the branch already holds them;
    - `fastForwardMain`;
    - `tagRelease`, `release/<id>` annotated by the product, the id of D1's form (`2026.10`, `2026.10.2`); the tag already there on that commit is the one, and on another it is refused (`BOOK_REPO_TAG_TAKEN`);
    - `diffRefs`, a unified diff, optionally under some paths;
    - `deleteImproveBranch`, only once `main` holds the branch (`BOOK_REPO_NOT_MERGED` otherwise);
    - `withTreeAt`, a ref's tree written out in a worktree of its own for the chapter's check and an ingestion, and removed after.
  - **The fast-forward** moves `main` with `update-ref` from the `main` the caller saw, so a fast-forward and nothing else is possible:
    - `main` moved since is `BOOK_REPO_MAIN_MOVED`, which sends the merge back to its check (§ 5 step 2);
    - a branch that does not descend from `main` is `BOOK_REPO_NOT_FAST_FORWARD`;
    - `main` checked out in the operator's tree is `BOOK_REPO_MAIN_CHECKED_OUT`, since moving it would leave their checkout behind. So the operator leaves the repository on a detached HEAD.
    - Moved already to that branch (a step run again) gives the same answer.
  - **What it refuses**:
    - any ref but `main`, `improve/*`, `release/*` or a commit id, and anything an option could hide in (`BOOK_REPO_REF_INVALID`);
    - any path that is not relative, forward-slashed and free of `..`, a leading dash or `.git` (`BOOK_REPO_PATH_INVALID`);
    - a subject or trailer of more than one line, and a trailer key not of git's form (`BOOK_REPO_MESSAGE_INVALID`).

    It writes no branch but `improve/*` and no tag but `release/*`. No contributor's name is written (D2).
  - **Git's own failures** are `BOOK_REPO_GIT_FAILED`, with git's first lines and never a file's content.
- **The write key** (§ 3): a lint rule (`BOOK_REPO_WRITER` in `eslint.config.mjs`) refuses an import of `pipeline/git` everywhere but the merge activities, `workers/activities/merge*.ts`: in the web tier, lib, the pipeline, the scripts, the other workers and the test helpers.
- **The release's identity** (§ 3) changes with 54c, which ingests a tag and sets `Release.gitSha` to the tagged commit; 54a gives it `resolveRef` and `withTreeAt`.

Decided here, for Andre to see:
- the operator's repository is left on a detached HEAD, so that `main` can move without the checkout under it moving;
- git runs with none of the machine's configuration;
- the adapter's worktrees live in the git directory;
- a step's own date makes its commit and tag;
- a branch is deleted with `--force` after the adapter's own check that `main` holds it, since git's check is against `HEAD`, which is detached.

Verified:
- **`pipeline/git.test.ts`**, 11 of 11, against a repository the test makes in a temporary folder from fixture chapters:
  - **The operator's tree**: dirty, with a change to a tracked file and an untracked file, on a detached HEAD at the release, it ends exactly as it began (the same `git status`, the same `HEAD`, the same files), with no worktree of the adapter's left (§ 12.1).
  - **Shell syntax** in a file's content, its path, the subject and a trailer (`$(…)`, backticks, `;`, `&&`, `&`) is committed as written, and no file it names is made anywhere.
  - **The rest**:
    - unavailable without the setting, at a folder that does not exist, and at one that is not a repository;
    - a file and a folder at a ref, and the refused refs and paths;
    - a branch made once, and the refused names;
    - a commit by the product with its trailers and its date, no second commit, and the refused messages;
    - the fast-forward refused from a moved `main`, under a checked-out `main` and from a branch off the old `main`, then made, and made again with the same answer;
    - a tag made once by the product, refused on another commit and for ids of no form, and a month's second;
    - a diff under a path, and none between equal refs;
    - a tree read in a worktree inside the git directory;
    - a merged branch deleted, again nothing, an unmerged one refused.
- **`lib/env.test.ts`** holds `BOOK_REPO_DIR` to being read.
- **The lint rule** refused a probe importing `@/pipeline/git` from `lib/`.
- **The rest**:
  - the database suite, purge excluded: 209 files and 2,223 tests passed, none failed;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing.

## 14. As built (unit 54b, part 1: the merge up to a checked branch, 2026-10-09)

`MergeWorkflow` is built up to a branch that passed, or failed, the pipeline's half of the chapter's check. The chapter's lab run by spec 18's runner, the queue's "Ready to merge" group with the diff, `Re-run check` and a page for any of it are part 2's. Nothing here merges, tags or ingests: that is 54c.

- **Where it starts**: `SuggestionWorkflow` starts it as a child, under `merge:<id>`, where a decision leaves the suggestion to merge (`mergesAfter`, `lib/schemas/improve.ts`). That is any suggestion a curator accepted, in `MERGING`, and a person's suggestion the adjudicator accepted, which waits in `DECIDED`; the merge's first step moves the latter on to `MERGING`.
  - The run goes on from where the merge leaves the suggestion: back with a curator, it waits for one; returned as a request for more, it waits for a revision.
  - A run that ended at an accept before this replays as it ran (the patch `54b-merge-child`). Their suggestions have no merge (Known defects and limits).
- **The workflow** (`workers/workflows/merge.ts`) prepares, checks, and acts on the check. It returns where `main` moving under the anchor, or a failed check, leaves the suggestion.
  - Where the merge cannot go on, it waits with no timer for `recheck`: the repository unavailable, a curator's hand, the lab not run (D4), passed until the curator's merge (54c), or a step whose attempts are spent.
  - Each recheck prepares and checks again, so a `main` that moved since is met at § 4.1.
  - Its `stage` query says where it is: `PREPARING`, `CHECKING`, `UNAVAILABLE`, `MANUAL`, `NOT_RUN`, `PASSED` or `STEP_FAILED`.
- **The activities** (`workers/activities/merge.ts`, as `service:merge`): with the adapter, the only code that writes the book's repository (the lint rule's `BOOK_REPO_WRITER`).
  - `prepareMerge`, § 4.1 to § 4.3:
    - the repository is opened; unavailable, the row says why (`BOOK_REPO_UNAVAILABLE`'s words) and the merge waits;
    - the book is read at `main` in the adapter's own worktree;
    - **the anchor**: it must still read what the suggestion recorded, composed as the draft composed it (`lib/improve/anchorText.ts`, now shared with `lib/db/anchors.ts`). If `main` moved, the suggestion goes back to a curator as `CURATOR_REVIEW`, with `main`'s text on the row;
    - **the proposal** is applied as the lint sensor applied it, dated by the decision. A shared figure's other readings, as the cross-chapter sensor named them, are set too;
    - **the branch**, `improve/S-36-0198-<class>-<anchor>`, is made from `main`. One holding only the product's commits from an earlier pass starts over on `main` (`restartImproveBranch`); one holding a person's commits is never moved;
    - **a curator's hand**: what `applyProposal` refuses (a restructure, a derived figure under invariant 5, anything it cannot place or prove), and a branch already holding a person's commits. The branch is left at `main` for them, and the row says why;
    - **otherwise** one commit of the product's, dated by the accept, with the trailers `Suggestion`, `Rubric-Version`, `Curator` (the curator's pseudonym) or `Adjudicator` (`service:adjudicator`), and `Record` (the hash of the accept's record). No person's name (D2).
  - `checkMerge`, § 4.3 and § 4.4:
    - **a curator's branch** is held to what the product can verify, in order: a commit; descent from `main`; a change to the anchored chapter's file; and for a derived figure, a change to the file its derive link names. The first that fails is on the row (`missing`);
    - **then the dry run** (`pipeline/check.ts`, pure) on the branch's tree, against `main`'s:
      - every chapter is built as ingestion builds it, its diagrams held to the reader's vocabulary with no renderer;
      - a chapter that does not parse, and a derived figure the change unlinked, fail it;
      - the book's own unlinked figures, four hundred and more in 2026.09, are not the change's, so the changed chapter is held to `main`'s count in each section.
    - The lab is `NOT_RUN` in this part: the runner is part 2's. By D4, that passes a change that cannot move a derived figure (a text, a claim, a row added) and holds any other, or any branch that changed the lab.
    - The row then holds the verdict, both halves, each chapter's content hash, the tree hash, the bump by the book's rule against `main` (`bumpOf`, split out of `nextVersion`), the lab, and the book's suite as the tree's results state it.
  - `returnMerge`, § 4.5: a failed check returns the suggestion as a request for more (`MERGING → DECIDED`, a researcher's on to `CLOSED`). The branch is kept for the curator.
- **The row** (`Merge.check`, `lib/schemas/merge.ts`): one of five stages, `UNAVAILABLE`, `MOVED`, `MANUAL`, `BRANCHED` and `CHECKED`, each with what a page needs to say it.
  - The door reads and writes `Merge` for `service:merge` alone: `readMerge`, `writeMerge`, `writeMergeCheck`. Its select names no person: `mergedBy` is 54c's.
- **The adapter** gains three operations:
  - `restartImproveBranch`: a branch of the product's own commits moved back to `main`, and a person's kept;
  - `descendsFrom`;
  - `changedPaths`, NUL-separated so that git quotes no name.
- **The worked examples and the development seed** run the merge's real activities with no repository, whatever the environment names: no example and no seed writes the book's repository. Example 1, the adjudicator's accept, now ends in `MERGING`, its merge waiting as `UNAVAILABLE`.

Decided here, for Andre to see:
- **The render hash**: it depends on the release's id, which the merge chooses (D1). So the check keeps each chapter's content hash, from which 54c computes the release's for the id it tags, and compares it with ingestion's.
- **An unlinked derived figure fails the check only where the change made it**: each section of the changed chapter is held to `main`'s count. Held to none, almost every chapter with a lab could never pass.
- **The bump** is the pipeline's mechanical rule read ahead of the release: a retitled chapter or layer major, changed sub-headings minor, anything else patch. Spec § 5 has the curator choose minor or major for a restructure when accepting. No such choice is built, and the rule reads the curator's own commit instead.
- **Every refusal of `applyProposal` is a curator's hand**, not only `manual`: at a merge they are rare, since the lint sensor applied the same change at intake.
- **The commit** is dated by the accept, so a pass run again makes the same commit. An adjudicator's accept signs its trailer as `Adjudicator: service:adjudicator`, beside spec § 3's `Curator`.
- **A failed check's return writes no record of its own**: the check's output is the merge's row, and the merge's one record is `merged` (54c).
- **A step whose attempts are spent leaves the merge waiting for `recheck`**, as a step of the suggestion's waits does; it does not end it.

Verified:
- **`pipeline/check.test.ts`**, 9 of 9, on chapter 21's fixture:
  - an anchor of each kind read as the draft recorded it, and none where there is no anchor, chapter or parse;
  - the chapter's file, its lab folder and a derived figure's derive file named as the repository names them;
  - the tree passes as it is, a wording change applied as a patch, a changed sub-heading as minor, a retitled chapter as major;
  - a chapter that does not parse fails, and a missing chapter;
  - a derived figure the change unlinked (77 % to 78 %) fails, named, while the book's own do not;
  - a lab that did not reproduce is in the suite.
- **`lib/improve/merge.test.ts`**, 6 of 6:
  - what merges and where a merge starts;
  - the branch's and the commit's words, in the adapter's form and the ledger's;
  - D4's verdicts;
  - the returns along the table's moves;
  - the row's reasons in step with the pipeline's, and its stages.
- **`pipeline/parse/versions.test.ts`** gains `bumpOf`.
- **`pipeline/git.test.ts`**, 12 of 12: a branch of the product's commits restarted on `main`, a curator's commit (made without a checkout) kept, descent, and what a branch changed.
- **`tests/workflows/merge.test.ts`**, 5 of 5:
  - a moved anchor and a failed check end the merge where they leave the suggestion;
  - it waits, saying where, as `UNAVAILABLE`, `MANUAL`, `NOT_RUN` and `PASSED`, and prepares and checks again at each recheck;
  - a step whose attempts are spent leaves it waiting;
  - a recheck sent while a pass runs is a pass more;
  - a bad argument asks nothing.
- **`tests/workflows/suggestion.test.ts`**, 20 of 20: an accept starts the merge. A failed check's request for more then waits for a revision; a moved anchor waits for a curator, who may decline.
- **`tests/integration/merge.test.ts`**, 6 of 6, against the database and a repository the suite makes from chapter 21's fixture renumbered 94:
  - **the wording change**: one commit of the product's on `main`, dated by the accept, with its trailers. The same commit a second time. Then checked: passed, its lab not run, a patch, `main` untouched;
  - **the derived figure** (invariant 5): left to the curator's hand at `main`. The branch is held, in turn, to a commit, then to the derive file. Then it passes the dry run, held by its lab not run, and a second preparation never moves the curator's branch;
  - **a moved anchor**: back to a curator with `main`'s text, no branch made;
  - **a claim that unlinks a derived figure**: fails, named, and is returned as a request for more, its branch kept;
  - **no repository**: the suggestion waits in `MERGING` with the reason, and no ref is written (§ 12.10);
  - **the operator's tree**, detached and with their notes, ends as it began.
- **`tests/integration/worked-examples.test.ts`**, 4 of 4, example 1 ending in its merge.
- **Live, on the development engine**: a check contributor's curator-always change was queued with no model asked. The check curator accepted it through the endpoint (S-21-1759).
  - The workflow moved it to `MERGING` and started `merge:S-21-1759` as its child.
  - With no `BOOK_REPO_DIR` here, the merge waits as `UNAVAILABLE`, its row naming the branch it will make, no commit, `v1.0.0`, `2026.09` and the operator's words. A recheck found it unavailable still.
  - The workers logged no failure, and the runs already waiting replayed.
- **The rest**:
  - the database suite, purge excluded: 213 files and 2,253 tests passed, none failed;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document is unchanged at 37 paths and 42 operations.
- **Not run**: `npm run improve:seed`. It replaces the development database's seeded suggestions, which other checks and the pages use. Its new branch is the suite's, which passed.

## 15. As built (unit 54b, part 2: the chapter's lab, the queue's merges and Re-run check, 2026-10-09)

The check is now whole: the chapter's own lab runs beside the dry run, by spec 18's runner, which exists. Nothing here waits for the Labs IDE, which Andre builds last (2026-10-09): a derived figure's change stays the curator's own commit on the branch (§ 4.3), and a saved lab run as evidence stays the IDE's. The queue shows what merges, with the branch's diff, and a curator can have a merge check again.

- **The lab half** (§ 4.4 part 2), in `checkMerge`, where the dry run passed and the chapter's lab has a derive script:
  - **Which lab**: a lab without `derive.py` prints no derived figure and has nothing to reproduce. That lab, or a chapter with none, is `NONE`. Chapter 28's is one, and the PRD's first example is on chapter 28.
  - **The run**: the branch's lab folder is run by `runDerive` (`lib/aids/run.ts`), as a decision aid runs, by `AID_RUNNER`. That is the lab tier's container (no network, read-only root, 2 cpus, 4 GiB, ten minutes), or a local python.
  - **What it printed** is held to what the branch states (`reproductionOf`, `pipeline/check.ts`, pure). The chapter is built again with the run's results in place of the branch's own, by the figure pass's own matching. A derived figure linked before and not now, or to another key, fails the check, named, with the results that moved. Numbers are equal within a part in a billion, and the run's `timestamp` apart.
  - **A run that does not start** — no runner, no image — is the machine's: `NOT_RUN`, with why.
  - **A run that does not end with results** is run again on `main`. Failing there too, the lab cannot be run here: `NOT_RUN`. There alone, the change broke it: `FAIL`.
  - **The verdict** is D4's, as in part 1: a lab not run holds back a change that could move a derived figure, and lets a lab-free one pass, saying so.
  - The run's whole output is kept in the store under `merges/<id>/<commit>.log` (the spec's "runner's output key"; a new root of `ObjectKey`), and its last 8,000 characters on the row.
- **The diff**: the branch against `main` is kept on the row (its first 64,000 characters) as git's porcelain word diff (`diffRefs`' new `words`). A book's paragraph is one line, and a change inside it is a few words of it.
- **A step that fails** writes an `ERROR` stage to the merge's row, with the step, its code and its first words (git's, the runner's or the database's, never a file's content). It is then thrown on for the engine's attempts, and an attempt that succeeds writes over it. A first preparation that fails before the row exists has nowhere to say it; its run still waits for a recheck.
- **Long paths** (found by this part's live run on the book): git runs with `core.longpaths` on. On Windows, a book's file in the adapter's worktree passed the 260 characters git otherwise refuses. Worktree names are shorter too.
- **The suggestion's view** (`GET /suggestions/{id}`) carries its merge: the branch, the versions, the releases, when it merged, and the row's check (`MergeViewSchema`), read by the owner and its curators. Its refresh key includes the check's time, so a page reading a merge redraws once the merge has moved.
- **The queue** (`GET /curation/queue`; 36 § 3.1):
  - **"Ready to merge"**: a passed check.
  - **"Merging · waiting on a hand"**: everything else accepted, in `MERGING`, or a person's in `DECIDED` whose merge has not begun.
  - Each is due seven days after its merge's last word (36 D3). An item carries its merge in a word (`merge`: `READY`, `CHECKING`, `MANUAL`, `NOT_RUN`, `UNAVAILABLE`, `FAILED`, `ERROR`, `NONE`), which the list's class line says.
  - `mergingInParts` reads them through the door: in the caller's parts, never their own.
- **The detail** (`QueueMerge`):
  - where the merge stands, in a word and a sentence;
  - the version it will become, the branch and the commit;
  - the chapter's lint and lab, and the book's suite, with the sentence for a failure elsewhere that is not this change's;
  - why the change is made by hand and what the branch still lacks;
  - the repository's words when it is unavailable, and a failed step's;
  - what the dry run or the lab found, the figures and the results;
  - the diff, by words, struck and underlined;
  - the end of the lab's output.

  The book's, git's and the pipeline's words are marked English. A check under way is read again until it has moved.
- **`Re-run check`**: `POST /api/v1/curation/{suggestionId}/recheck`, held as a decision is (a session, the curator's role, an `Idempotency-Key`, 60 an hour, the policy's `decide`). For an accepted suggestion, it signals `recheck` to `merge:<id>` and answers 202.
  - Where no merge runs — an accept from before 54b, or one whose run ended — it starts one, which nothing waits on (`started: true`).
  - Anything else is 409.
  - The panel keeps its key across retries of one unanswered press, refreshes the router, and reads the page again until the merge's check has moved.

Decided here, for Andre to see:
- **The lab is run for every change** where the chapter's lab has a derive script and a runner is there, not only for those D4 would hold. A lab-free change merely passes without it.
- **A lab that does not run on `main` either** is not the change's: not run, and D4 decides. Four labs' scripts import numpy, which the default image (`python:3.12-slim`) lacks. Until `AID_IMAGE` names an image with it, those chapters' labs are not run here.
- **A second group**, "Merging · waiting on a hand", beside spec 36's "Ready to merge", seven days like it. A curator needs to see a merge that waits on them as much as one that is ready.
- **A merge `Re-run check` starts** for an accept from before 54b has no parent run. If its check fails, the suggestion returns as a request for more with no workflow to take a revision, as a seeded suggestion has none.
- **The diff is by words.**

Verified:
- **`pipeline/check.test.ts`**, 13 of 13:
  - a lab without a derive script counts as none;
  - a run that prints the branch's results reproduces, whenever it ran;
  - one that prints another value names the figure (77 % against 0.78) and the result;
  - one that does not print a result names it.
- **`lib/improve/merge.test.ts`**, 7 of 7: every stage's word, `ERROR` among them, and the version a bump makes.
- **`pipeline/git.test.ts`**, 13 of 13:
  - a tree whose file lies past 260 characters is read; without `core.longpaths` it fails with the live run's "Filename too long";
  - the word diff gives the runs that moved.
- **`tests/integration/merge.test.ts`**, 7 of 7, the lab run by a real local python:
  - the wording change passes with its lab reproduced, its output kept under its key, its diff by words;
  - the derived figure's curator first changes the results by hand: the lab prints 0.769 against the branch's 0.78, and the check fails, naming the figure and the result. Then a script that prints 0.78 passes it;
  - a runner that does not start, and a lab that does not run on `main` either, leave the lab not run, a wording change passing;
  - a lab that runs on `main` alone fails;
  - a step that fails writes `ERROR` to the row, and a good pass writes over it.
- **`lib/api/endpoints/curation.test.ts`** files a passed check under "Ready to merge" and the rest under "Merging", each with its word and its deadline. **`curation-decision.test.ts`** gives `Re-run check`'s declaration, its 202 (told, or started), its 409, its 404 and a contributor's 403.
- **Live, on the development server and engine**:
  - the queue filed S-21-1759 (no repository) and the accepts from before 54b (none begun) under "Merging";
  - the detail drew the merge, and axe found nothing in EN or PT;
  - `Re-run check` on S-21-1759 was a pass more, and the page redrew;
  - on S-21-1560 it started a merge, which waits as `UNAVAILABLE`, and the page redrew without a reload.
- **Live, on the real book** (all 41 chapters): the workers were pointed for one check at a temporary repository made in the scratchpad from the book folder, whose tree hash is release 2026.09's. That is not Andre's repository; it is now removed.
  - The first attempt failed on Windows' path length, which the fix above answers.
  - Then `Re-run check` on S-21-1759 branched its curator-always wording change with the product's commit, and checked it in four seconds: the dry run passed, and chapter 21's lab reproduced in the Docker runner in about half a second.
  - The book's suite was 34 of 34. It was a patch, filed under "Ready to merge", its diff by words; the operator's tree was untouched, and axe found nothing.
  - The workers then went back to no repository, and S-21-1759 to waiting as `UNAVAILABLE`.
- **The rest**:
  - the database suite, purge excluded: 213 files and 2,264 tests passed, none failed;
  - the browser spec `improve`: 8 of 8;
  - the truncation suite passed;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document now has 38 paths and 43 operations: `Re-run check` added, the queue's item and the suggestion's view widened.

## 16. As built (unit 54b, part 3: the merge on the contributor's page and the record's rail, 2026-10-09)

The merge is now where the person who made the change reads it. Their outcome page shows the merge as the queue's detail does, without `Re-run check`. A change the check returned says that the check returned it. The record page's rail fills Version and Lab gate from the merge's row.

- **A variant for a returned change** (`checkFailed`, `lib/improve/outcomeView.ts`):
  - An accepted change whose chapter's check failed comes back as `REQUEST_MORE` (§ 4.5). Its page says it was accepted and the check failed it: the badge "Check failed", the line "… accepted · the chapter's check failed", and a sentence that points to Merge below.
  - That holds while no decision came after the check. A revision decided again is the adjudicator's own request for more, or whatever else it decides.
- **The outcome page** (`ImproveOutcome`) shows `QueueMerge` for an accepted suggestion, or one with a merge, under the Decision and the Anchor:
  - there is no `Re-run check` there;
  - a failed check shows its figures, the results that moved, the diff and the lab's output, above `Revise with new evidence`;
  - a check under way reads itself again, as in the queue.
- **The record's rail** (`RecordRail`; the Improve-Record screen):
  - **Version**: the version the branch leaves, faint, `→` the one it makes, `patch` (or minor, major), and the book's rule. Then the branch, the commit, and "merged by · not yet" until 54c. The header says the merge's word, or `not merged` before one began.
  - **Lab gate**: the chapter's lab (`ch21 lab · does not reproduce · lab-21`, or `none`), the chapter lint, and the book's suite (`34 / 34 reproduce`) with its meter. Then the sentence for a failure elsewhere that is not this change's. Before a check, a sentence says the check has not run.
  - **Source row** and **Credit** are unchanged: they are filled at the merge, by 54c and 54d.
- **The version it will become** comes from the check alone. Until a check has read the branch's bump, the queue and the rail give only the version the branch leaves, not a guess at the next.
- **The operator's words stay the curator's.** A step's error and the repository's absence are in words that name the server's folders (`BOOK_REPO_DIR names C:\…`). The suggestion's view (`mergeViewOf`) gives them to a curator. Any other reader — the contributor on their own page — gets the step, its code and the state's sentence, with the words blank.
- **The states' sentences** now read for both audiences: "a curator's Re-run check" where the curator's own panel said "Re-run check".
- **A class a curator always decides has no acceptance.** The decision's lines for an accept, a merge, a returned change and a request for more no longer say `accept 0` for it. This part's live run found it; the accepted lines had said it since 52b.

Decided here, for Andre to see:
- **The contributor sees the check's output whole**: the figures, the results, the diff and the lab's output. That is § 4.5's "returns as `REQUEST_MORE` with the check's output". The repository's and a step's words are not shown, as above.
- **A result the chapter does not print does not fail the check.** This part's first live attempt moved `extra_tokens_per_1000_tasks_no_checkpoint`, which chapter 21 states as no figure, and the check passed. The moved result is kept on the row; the page names moved results only when the lab fails. Only a figure the chapter prints fails the check (§ 4.4 part 2, as part 2 built it).

Verified:
- **`lib/improve/outcomeView.test.ts`**: the check's request for more, with a decision row and without one (a curator-always change the router queued); the adjudicator's own after a revision is decided again; a passed check, or none; and an accepted change merging again.
- **`lib/api/endpoints/suggestions.test.ts`**: the owner reads a step's error and the repository's absence with the words blank; a curator of its part reads the words.
- **Live, with no repository**, S-21-1759 waiting as `UNAVAILABLE`:
  - the contributor's page shows Merge as "no repository" with its sentence, no folder and no `Re-run check`; the curator's view has the words;
  - the record's rail shows the version the branch leaves, the branch, "not yet", and that the check has not run;
  - axe found nothing on either page.
- **Live, on the real book**: a temporary repository again, made in the scratchpad from the book folder. It is not Andre's, and it is now removed.
  - Its `main` took one commit, made with git's plumbing so its HEAD stayed put, putting Lab 21's scenario at 14 calls a task.
  - `Re-run check` on S-21-1759 made the branch again on the new `main`, and the dry run passed. Chapter 21's lab, run in Docker in half a second, no longer printed the chapter's 77 %, 51 %, 99.5 % and 96.8 % (F-21-06, -08, -09, -11).
  - The check failed, and the merge returned the suggestion as a request for more, four seconds after the press.
  - **The contributor's page**: "Check failed" and "score 0 · accepted · the chapter's check failed". Merge shows the four figures, the five results that moved, the diff and the output. `Revise with new evidence` is there, `Re-run check` is not.
  - **The record's rail**: `v1.0.0 → v1.0.1 · patch`, the branch, the commit, `ch21 lab · does not reproduce · lab-21`, lint pass, and the suite 34 / 34 with its meter.
  - axe found nothing on either page. In PT the badge reads "Verificação falhou". No page scrolls sideways at 390 px.
  - The workers then went back to no repository. On the development database, S-21-1759 stays a request for more, its merge's check failed.
- **The rest**: the database suite, purge excluded, passed 213 files and 2,266 tests, none failed.

## 17. As built (unit 54c, part 1: the curator's merge, to a published release, 2026-10-09)

Andre decided four things before it (2026-10-09), each on the recommendation:
- **D1**: a release's id is the merge's month, with a serial from the month's second release on (`2026.10`, then `2026.10.2`).
- **The vectors**: the unchanged sections' vectors are carried forward, and the changed ones wait for the operator's `npm run embed:release`.
- **The changelog**: the book's changelog gains one line per merge.
- **The live check**: it runs on a copy of the development database (part 2).

What part 1 built:
- **`MERGE`** is the decision endpoint's fourth action (`POST /curation/{id}/decision`, with the same declaration, policy and rate).
  - It applies to a suggestion whose merge's check passed. It takes a note at most, and no override's code or criterion (400).
  - The action is written by `writeMergeAction`: the suggestion merging, its check passed, in the caller's parts and not their own, one merge per check. Anything else is 409.
  - The merge's workflow is told the action's id (`merge({ actionId })`). The answer is the `curator` record's `seq` once the workflow writes it, as a decision's is, or 202 while it records.
  - A merge whose workflow has ended is 409 (`Re-run check` starts one); a seed is never merged (409).
- **The workflow** keeps every `merge` signal and takes one once the check passed: the action recorded, `main` moved, the release published, the record written.
  - If `main` or the branch moved since the check, or the check no longer passed, it prepares and checks again at once. The curator's merge stands, and it merges then.
  - A step that fails waits for `Re-run check`. Once `main` is tagged, a recheck runs the release and the record alone.
  - An action that is none of this check's is dropped, and the next taken.
- **The activities**, each idempotent, as `service:merge`:
  - `recordMergeAction`: the `curator` record of action `MERGE` under the step key `curator:<actionId>` of the merge's workflow, naming the part the curator's roster met. There is no calibration event: a merge decides nothing the adjudicator did.
  - `mergeMain`: holds the tree to the one checked (its commit, or that commit with the changelog's line after it), and `main` to where the check found it.
    - The version follows the book's rule (04 D4), which the ingestion applies.
    - The release's id is D1's: the first that no release and no tag holds, kept across a step run again.
    - The changelog's line is a commit of the product's on the branch: `- ch21 v1.0.1, release 2026.10: edit the text at 21.3 (S-21-1759).`
    - Then `main` is fast-forwarded from where the check found it, and tagged `release/<id>`.
  - `publishMerge`: the tag's tree is ingested by the pipeline as its own process under `PIPELINE=1` (`pipeline/publish.ts`).
    - `--git-sha` is the tagged commit, which is then the release's `gitSha` (§ 3). `--expect-hash` is the render hash the check computed for that tree under this id (invariant 2).
    - A different hash publishes nothing: the step fails as `RENDER_HASH_MISMATCH`, and the merge waits.
    - The ingestion publishes the release in its one transaction, and the reader's data cache shows it within its minute (`REVALIDATE_S`).
    - Then the embedding job's carry runs as its own process under `EMBED=1` (`carryEmbeddings`, in the raw SQL register). Each section whose embedded text is unchanged from the release the merge started from keeps that vector. The changed ones wait for `npm run embed:release`, searched lexically until then.
  - `recordMerged`: the `merged` record, on the chapter's new version.
    - It holds the branch, the tagged commit, the versions, the releases, the render hash, and the check's two results.
    - It names the contributor and the endorser as the chain does, from their own `submitted` and `endorsed` records, and the curator who merged.
    - Then the merge's row is done (`mergedAt`, the version the release gave), the suggestion is `MERGED`, and the branch is deleted.
  - A failed step of the merge keeps the check it came after beside its `ERROR` (`checked`), so the steps still to run can read it; the record puts it back.
- **Release ids** (`ReleaseIdSchema`, `RELEASE_ID`): `2026.10.2` and on now parse. The adapter's tag already took D1's form (54a), and `releaseTagsOf` lists the tags taken.
- **The ingestion** takes `--git-sha` and `--report-dir` (`pipeline/ingest.ts`).
- **The embedding job**: `npm run embed:release -- --release <id> --carry-from <id>` carries alone. It asks no model, and so needs no principal.

Decided here, for Andre to see:
- **A merged suggestion rests at `MERGED`.** § 5 step 7 says "then `MERGED`, then `CLOSED`". But spec 33 § 6.5 ends the workflow at `MERGED`, and the monthly sample (53e) and a revert (54e) find merged suggestions there. The merge leaves it `MERGED`.
- **A curator's merge is told to the merge's workflow**, not the suggestion's: the suggestion's run waits on its merge then, and cannot take a signal. The endpoint, the policy and the record are a decision's.
- **The release's `gitSha` is the tagged commit** (§ 3). The second check § 3 names, the tree hash against the tag's files, is not made: the ingestion reads a worktree of the tag, so its files are the tag's by construction, and the render hash is held to the check's.
- **A curator's merge stands across a re-check**: when `main` moves since the check, the merge checks again and merges then, without a second press.
- **The changelog's line is committed after the check.** No chapter's render hash covers `book/CHANGELOG.md`, so the check still holds, and the merge holds the tree to the checked one plus that file alone.

Verified:
- **`lib/improve/merge.test.ts`**:
  - D1's ids: the month, then its serial, a gap first, the month in UTC;
  - the changelog's line, appended once in the file's own line ends, or a file made where there is none;
  - the check a merge goes by, its own or the one an error kept.
- **`lib/schemas/ids.test.ts`** takes `2026.10.2` and `2026.10.12`, and refuses `2026.10.1` and `2026.10.02`. **`pipeline/git.test.ts`** lists the tags taken, each with its commit.
- **`lib/api/endpoints/curation-decision.test.ts`**:
  - `MERGE` writes the action with its note and tells the merge, answering the record's `seq`, or 202;
  - 400 for a code or a criterion, 409 for a suggestion not merging or not ready;
  - an ended merge is 409 and the engine down 503, each with the action taken back;
  - a seed is never merged, and a contributor is refused.
- **`tests/workflows/merge.test.ts`**, 11 of 11. The six new cases:
  - a merge after the check passed;
  - one sent while the check ran;
  - `main` moved: checked again, then merged;
  - a failed publication waiting, then the release and the record alone on a recheck;
  - a failed fast-forward: prepared and checked again on a recheck;
  - an action none of this check's dropped, and the next taken.
- **`tests/integration/merge.test.ts`**, 10 of 10. Its three new cases run against a database the suite makes, migrates, gives the fixture's release 2026.09 with vectors, and drops; the development database's release never moved.
  - **A merge**: the curator's record, the changelog's commit, `main` tagged `2026.10`, the ingestion under the check's render hash, every section but the changed one carrying its vector, the `merged` record, and `MERGED`. Each step run again changes nothing.
  - **`main` moved by an editor's commit**: nothing tagged. Checked again, it merges as `2026.10.2`, its version `v1.0.2`, starting from `2026.10`.
  - **A render hash that is not the check's**: nothing published, the error on the row beside the check it kept. A recheck's publication goes on from that check, and the record puts it back.

## 18. As built (unit 54c, part 2: the merge on the pages, and its live check, 2026-10-10)

- **`Merge` in the queue's detail** (`QueueMergeButton`): on a suggestion whose check passed, for a curator whose suggestion it is not, beside `Re-run check`.
  - A merge publishes a release, so it takes a second press, which the button asks for in words ("Press Merge again to merge into main and publish a release."), with `Cancel`. The first press lapses after ten seconds.
  - It posts `MERGE` with an `Idempotency-Key`, kept across the retry of a press that went unanswered, and reads the suggestion again until the merge has moved.
- **Two more words for a merge** (`MERGE_STATES`):
  - `MERGING`: a passed check whose release is set aside, a curator's merge under way ("merging into main").
  - `MERGED`: the row's `mergedAt` set.
  - The detail drops its buttons while it merges and once merged, and names the release ("Merged into main and published in release 2026.10."). While it merges it reads itself again, for thirty minutes, many times what an ingestion of the whole book with its diagrams takes.
  - The refresh key now moves with the release set aside and with the merge's time, which no new check carries.
- **The contributor's outcome page**: a merged suggestion's decision says `Merged` (as since 52b), and its merge panel names the release.
- **The record's rail**:
  - Version gains its release, and "merged by": the curator, named as the timeline names them (by name to the owner and the part's curators, else the ledger's pseudonym), from the `curator` record of action `MERGE`.
  - For a source row's change, Source row gives the row's verification date before and after the merge, and its age today.
  - Credit reads "{who} is credited for this change in the chapter's history."
  - The timeline shows the curator's `MERGE` and the `merged` record: 52c's presenter already read both.

**The live check, on a copy of the development database** (Andre's answer of 2026-10-09):
- **The setup**: the dev server and the workers ran on `harness_bible_54c`, a copy made by `CREATE DATABASE … TEMPLATE harness_bible` with both stopped, and on an engine namespace of their own, `harness-bible-54c`. The workers' `BOOK_REPO_DIR` was a temporary repository, made in the scratchpad by the operator's commands. It is not Andre's.
- **The merge**: S-21-1560, the curator-always wording change in 21.3, accepted on 2026-10-08.
  - `Re-run check` started its merge in the new namespace, and the check passed in seven seconds.
  - `Merge` asked for the second press and merged on it. The release `2026.10` was set aside within a second, and the page said "merging into main".
- **The first merge found a defect**: the ingestion refused the release with `Unique constraint failed on the constraint: ChapterVersion_chapterNumber_version_key`.
  - The content schema had a key on a chapter and its version. That key refuses every second release, since each re-inserts its unchanged chapters at their version (invariant 1; 04 § 6.10). Only one release had ever been ingested, so nothing had met it.
  - The key is dropped by migration `20261009190000_chapter_version_per_release`, a relaxing one. `(chapterNumber, releaseId)` still holds one row per chapter per release.
  - The merge suite now ingests a second chapter that no merge changes. With the old key put back for one run, its three merge cases failed with the live run's words; without it, they pass.
- **The merge resumed**: it had waited on that failure, its row saying `INGEST_FAILED` beside the check it kept, `main` tagged. After the migration, `Re-run check` ran the release and the record alone, and the suggestion was `MERGED` fifteen seconds later.
- **What it left**:
  - in the repository, `main` with the product's changelog commit, tagged `release/2026.10`, and the branch deleted;
  - release 2026.10 current, its `gitSha` the tagged commit, its render hash the check's, its sixty-nine diagrams rendered with none failed, in 6.4 s;
  - only chapter 21 moved, to `v1.0.1`; 361 of 362 sections carrying their vectors, 21.3 waiting for the job;
  - the curator's `MERGE` record, then the `merged` record;
  - the reader showing the new sentence once its data cache had refreshed. The first read after its minute serves the release before and refreshes it, so the new release shows a read later;
  - the suggestion out of the queue.
- **The pages**: the contributor's outcome ("Merged", the release) and record (`v1.0.0 → v1.0.1`, release 2026.10, merged by the curator's name, credited), and the queue asking and merging. axe found nothing on any; the record reads in PT, with no sideways scroll at 390 px.
- **Then**: the copy dropped, the namespace deleted and the repository removed. The dev server and the workers are back on the development database, whose release is still 2026.09; the migration is applied there too.

Decided here, for Andre to see:
- **A merge takes two presses**, the second asked for in words: it publishes a release, which no other button of the queue does.
- **A merge under way is filed under "Merging"**, saying "merging into main", until it is merged and leaves the queue.

Verified, besides the live check:
- **`lib/improve/merge.test.ts`**: `MERGING` once the release is set aside, and `MERGED` once merged, whatever the check.
- **`lib/improve/outcomeView.test.ts`**: the refresh key moves with the release set aside and with the merge's time.
- **`tests/integration/merge.test.ts`**, 10 of 10, its database's release now with a chapter the merges leave unchanged.

## 19. As built (unit 54d, part 1: the history's data, its API and the record made public, 2026-10-10)

The data under the Chapter-History page, and its two reads; the page itself is part 2.

- **The chapter's merged suggestions** are a public read of the one door (`mergedOfChapter`): the suggestion, where it was anchored, its proposal, its merge, what the adjudicator said, and its graded items' tiers and scores, oldest merge first. It takes no caller: a merged suggestion is anyone's (35 D2). A reverted one (54e) is still there, its merge saying so.
- **The ledger's chapter scope** is now a chapter's history: the records of its merged suggestions. `LedgerView` takes a set of suggestions, the export's `chapter` scope names the chapter by its number (`"21"`) and carries the set, and `npm run ledger:export -- --scope chapter --id 21` resolves the set itself. One chapter version's records had been the scope before; no caller used it but its tests.
- **The presenter** (`lib/improve/history.ts`, pure) tells the history from those rows, the chapter's records, its version in every release and the people as the viewer may name them:
  - the version ledger, newest first: a `merged` row per merged suggestion — the version, the bump, when and in which release, the class and kind, the anchor, the summary in the book's own words (`changeOf`), the strongest tier and the score, the curator's override and whether the accept was on inspection, the contributor, the curator who merged, the `merged` record's place and hash, a revert either way — and an `editorial` row for a release in which the version moved with no merge, the first release among them;
  - the stat strip: versions and their span, contributed changes still in the text, overrides with the latest, reverted;
  - credit: alphabetical by how each person is named, and nothing else (invariant 26), with accepted changes still in the text and reverted ones; a researcher's change credits the reader who endorsed it, or nobody, and carries its mark (spec 42 § 7);
  - what changed by layer: each section of the current version with its merged changes by kind (wording, figure, claim, rows, section), reverted and overridden;
  - the chain check over the chapter's records, made on each request.
  - A person is named only while their consent stands and their account is there (invariant 27), else by the ledger's pseudonym, shortened; a curator by name. A restructure's description — the contributor's words — is left out.
- **`GET /api/v1/chapters/{n}/history`**, public, decided as the chapter's own read is, 120 a minute by address, never cached.
- **`GET /api/v1/chapters/{n}/history/export`**: the chapter scope's signed JSONL, for anyone signed in, ten a minute, which appends its `EXPORT` record under the person's pseudonym; `NOTHING_TO_EXPORT` for a chapter with no merged change; no key, no export, as a suggestion's.
- **The record is public once merged** (35 D2, built here as spec 35 § 14 left it): `GET /api/v1/suggestions/{id}/record` and `/[lang]/improve/[id]/record` answer anyone, signed out included, for a merged suggestion. The policy is told `merged` on the resource only where the reader's own read did not give the suggestion, and the new rule reads it; everything else on a suggestion stays its audience's.
- **The reader's count** (`historyCount`, the chapter instrument's link) is now the history's rows: one per version the chapter has had, never a release that re-inserted it unchanged.

Decided here, for Andre to see:
- **The chapter scope names the chapter**, and its records are its merged suggestions', which are public; one chapter version's records were the scope before, with no caller.
- **The export asks for a session**: a record names who exported, and a visitor has no pseudonym to name. The page is public; its export button is for the signed-in (part 2).
- **A merge's row goes under the version it made**, an editorial release's under the version it published; a release that re-ingested a chapter unchanged is no row.

Verified:
- **`lib/improve/history.test.ts`**, 7 cases: the ledger's order and the first editorial major; the summary, the evidence, the people and the record of a merged row; names by consent and the alphabetical credit; the override, the inspection and the figure under its layer; a reverted change and its revert; a researcher's change and its endorser, and a restructure's words kept out; editorial rows where the version moved and none where it did not; the small rules.
- **`lib/ledger/export.test.ts`**: the chapter scope as a set of suggestions, carrying predecessors and verifying alone; empty for a chapter of none.
- **`lib/api/endpoints/history.test.ts`**: the history public and not found for a chapter the release has not; the export's declaration, its file and its record, 401 signed out, nothing to export, no key.
- **`lib/api/endpoints/record.test.ts`**: the record public in its declaration, the policy told `merged` only where the own read gave nothing; a merged suggestion's record to a stranger and signed out, and nothing else.
- **`policies/tests/improve_test.rego`**: anyone reads a merged suggestion and nobody writes it; an unmerged one stays its audience's. 66 of 66.
- **`tests/integration/ledger.test.ts`**: the script's exports moved to a window and to the chapter scope of a chapter no book has.
- **Live, on the development server**: chapter 21's history answers its one editorial row, the chain empty; chapter 99 is not found; a record signed out is not found where nothing is merged; the export signed out is 401; the reader's count is 1.
- The full suite: 215 files and 2,300 tests, none failed; lint and build exit 0; the OpenAPI document has 40 paths and 45 operations.

## 20. As built (unit 54d, part 2: the Chapter-History page, 2026-10-10)

`/[lang]/ch/[n]/history`, public, rendered per request, as the Chapter-History screen draws it (`ChapterHistory`, `lib/db/chapterHistory.ts`):

- **The header**: the chapter's cap with its part, the title in the edition's language, its version and verification date, and the lab's state as a block (`lab 21 reproduced`), with the screen's lede.
- **The strip**: versions and their span; contributed changes in the current text; curator overrides with the latest code and version; reverted, counted in precision; the bump rule.
- **The version ledger**, newest first, in a table that scrolls in its own box where it must: version and bump; the date; the class — the kind's word with `curator` for a curator-always change, an override or an accept on inspection, `research` for a researcher's, `revert` for a revert, `release` for an editorial release; the anchor; the summary in the book's own words, before struck and after in bold, with the override's and the revert's marks under it; the evidence's tier and score, with "accepted on inspection"; the contributor and the curator, named by consent or by pseudonym; the record — the suggestion's id linking to its record, now public, and the `merged` record's hash. An editorial row says what the release published and names the release.
- **The footer**: the screen's sentence and `Export chapter records` for the signed-in, a plain anchor since following it records an export; signed out, a line says to sign in.
- **The rail**: Contributor credit, alphabetical, with accepted and reverted counts and the two sentences of the screen, or that nobody is credited yet; What changed, by layer, as the screen's tree, a layer's changes by kind with reverted and overrides, unchanged layers grey; the chain check, with its head.
- **The status bar**: where, the version and its verification, the pinned release, the load time.
- The reader's chapter instrument links here with the history's rows.

Decided here, for Andre to see:
- **An editorial row's people**: "editorial" and a dash. The product knows no editor's identity; the screen's name there was the screen's.
- **A chapter with no merged change** shows its one editorial row, an empty credit list with its sentence, every layer at zero, and "no records yet" for the chain; the reader's count is 1.

Verified:
- **Live, on the development server**, chapter 21: the header, the strip, the one editorial row, the export for the signed-in alone and `NOTHING_TO_EXPORT` from its link, the rail's three parts; the chapter instrument's link with its count; in PT; at 390 px with no sideways scroll; axe found nothing signed out, signed in or in PT.
- **The PT truncation suite** holds the page signed out and in.
- A merged row is drawn by the same component from the presenter's data, which `lib/improve/history.test.ts` holds to the screen's rows; the development database merges nothing, so the page's merged rows wait for a merge to show live (the copy of 54c's check showed one in the data alone).

## 21. As built (unit 54e, part 1: the revert, 2026-10-10)

A revert is a merge in the other direction (§ 8): a suggestion of a curator's own, merging from the start, through the same check and the same release steps, with its own records.

- **`REVERT`** is the decision endpoint's fifth action (`POST /curation/{id}/decision`), on a merged suggestion in one of the curator's parts, not their own, with a note (`REVERT_NOTE_REQUIRED` without one; no override's code or criterion, 400).
  - The proposal that undoes the original is made from its proposal and the text it read (`lib/improve/revert.ts`, pure): a passage's edit with before and after exchanged; a value set back to the one the figure's text had, in the original's unit. A claim or a row added, a row edited, a restructure, or a proposal that is gone are the curator's hand: a restructure of the product's own words ("Revert of S-21-0001: the claim added is taken out by hand"), which `applyProposal` refuses as one (§ 4.3), so the branch waits for their commit and `Re-run check`.
  - The revert's anchor is the original's as the release reads it now, which its merge holds `main` to (§ 4.1 step 1). An anchor the release no longer has is 409.
  - The door writes it in one transaction (`createRevert`): the original must be merged, not reverted or being; the curator's `REVERT` action goes on the original, with the note, which counts in adjudication precision from then (36 § 6.1; precision already read that action); the revert is a suggestion of the chapter's next serial, origin `CURATOR`, no contributor, `MERGING` with `ACCEPT`, the original's parts, class and rubric, the undoing proposal, the anchor as it reads now; and the original's merge names it (`revertedBy`).
  - Then `MergeWorkflow` is started under `merge:<revertId>` with the action in its input, and the answer is 202 with the revert's id. The record is the merge's to write (invariant 17).
- **The merge of a revert**:
  - It records the curator's action first — the revert's `curator` record, of action `REVERT`, on the revert itself — since the revert's commit follows from that record (§ 3's trailers, `Curator:` and `Record:`, and `Reverts: S-21-0001`); its subject is `S-21-0010: revert S-21-0001 at 21.3`.
  - It prepares and checks as any merge does, and merges once the check passes, with no second press: the action is its own, made before any check.
  - Its `merged` record names what it reverts (`reverts`), has no contributor, and the curator as `mergedBy`; the original's merge names the revert.
  - A failed check leaves a revert merging, waiting as `FAILED` for the curator's hand and `Re-run check`: a return moves nothing, nobody being there to revise it.
- **`SuggestionOrigin` gains `CURATOR`** (an additive migration): a curator's own change, with no contributor and no run of the suggestion's workflow. The history marks nothing for it but the row's `revert`.
- **The history** (54d) shows the pair as the screen does: the revert's row with `reverts`, the original's with `reverted` and the version, both from the rows and the payloads it already read.

Decided here, for Andre to see:
- **A revert is a suggestion of its own**, of a new origin `CURATOR`, with no contributor: the history credits nobody for it, and its record and its merge are its own, as § 8 says.
- **What a function can undo**: a passage's edit and a value set; the rest is the curator's hand through the merge's own path for a hand-made branch. A claim added is the common case among them; its removal by hand is a commit of one line.
- **The curator's `REVERT` action is written on the original** and recorded on the revert: precision reads the action, as 53d built it; the revert's workflow follows from the record.
- **The revert's action is recorded before its merge prepares**, the one order in which the commit's trailers can name the record.
- **A revert whose check fails waits**, and is never returned as a request for more.

Verified:
- **`lib/improve/revert.test.ts`**: the exchanged edit; the value set back in the original's unit, as a proposal the schema takes; a value the figure's text does not give, a claim, a row, a row's edit, a restructure and a proposal gone, each the curator's hand in the product's words; the commit's subject; a revert's return path.
- **`lib/api/endpoints/curation-decision.test.ts`**: the revert written with the exchanged proposal on the anchor as it reads now and the merge started with the action, 202 with the revert's id; a claim's revert as the hand; the refusals (no note, a code, not merged, reverted already, the anchor gone, the door's); a seed never reverted; a contributor refused.
- **`tests/workflows/merge.test.ts`**: a revert's action recorded first, then the merge with it once the check passed, with no signal; a failed check waiting as `FAILED`, then merged on a recheck.
- **`tests/integration/merge.test.ts`**: a merged change of 94.4 reverted through the door — the action on the original with its note, the revert merging with the exchanged edit, the original's merge naming it, a second revert refused, another part's refused; then its merge: the `curator` record of action `REVERT` with the note's hash, the commit `revert … at 94.4` with `Reverts:`, the release `2026.10.4`, the `merged` record naming the original with no contributor; the section's line restored byte for byte to the first release's; the version `v1.0.4`; and the original in precision's numerator from the action on (§ 12.9).

## 22. As built (unit 54e, part 2: the revert on the pages, and its live check, 2026-10-10)

- **The record page** of a merged suggestion offers `Revert` to a curator of one of its parts whose suggestion it is not, until it is reverted (`RevertPanel`, a client island): a note, required, with its counter; `Revert` asks for a second press, as `Merge` does, since it publishes a release; `Cancel`. Once sent, the panel says the revert has begun and names it, linking to its record, and the page reads again — which takes the panel away, the change now reverted. The rail's Version gains "reverted by". A viewer who reads the record as anyone's (35 D2) sees no link to the suggestion's own page, which is not theirs.
- **The revert's own record** page: the curator's `REVERT` as the timeline names it, and the `merged` record that "Reverts S-21-1561." The suggestion's view carries `revertedBy`.
- **The queue's sampled item** (36 § 7.2, D12): the detail shows the month's verdict once given — stands, or reverted, by whom and when, with the revert's id — and until then the same panel with `Stands` beside `Revert`, for a curator whose suggestion it is not. `Stands` is `ACCEPT` on a merged suggestion through the decision endpoint: the action alone, once since it merged, no workflow told and no record; 200 with no `seq`.
- **The history** shows the pair as the screen does, from part 1's rows: the revert's row (`revert · curator`, "Reverted S-21-1561.", the summary with before and after exchanged, no contributor, the curator), the original's with `reverted in v1.0.2 · counted in precision`; the strip's reverted count; credit with `0 accepted · 1 reverted`; the layer with `1 wording, 1 reverted`.

**The live check, on a copy of the development database** (as 54c's): an engine namespace of its own, a temporary repository of the book, both removed after.
- The check curator merged S-21-1561 — `Re-run check`, `Merge` twice; merged 15 s after the press as release 2026.10, v1.0.1. The history then drew its first merged row live: the summary, "U 0 · accepted on inspection", the two names, the record's link and hash; the rail's credit and layer; two records in the chain. axe found nothing.
- From the original's record page: `Revert` without a note was refused in words; with a note, the first press asked for the second; the second started S-21-1926. The original's merge named it at once.
- The revert merged on its own within a second of the press, as release 2026.10.2, v1.0.2: its `curator` record of action `REVERT`, then its `merged` record naming the original. The chapter's file on `main` was byte for byte release 2026.09's (48,208 bytes). Three releases, 2026.10.2 current. The original's `REVERT` action, precision's.
- The pages after: the original's rail "reverted by S-21-1926" and no panel; the revert's record with "Curator · reverted" and "Reverts S-21-1561. patch. v1.0.1 → v1.0.2"; the history's pair, the strip (3 versions, 0 contributed, 1 reverted in precision), the credit (0 accepted · 1 reverted) and the layer (1 wording, 1 reverted); in PT, "reversão · curador". axe found nothing on any. The reader no longer showed the reverted sentence once its minute had passed.
- **Not exercised live**: the sampled item's panel, which needs the sample's setting and a merged suggestion whose strongest item is tier B; the endpoint's cases and the panel, the same island as the record page's, stand for it.

Decided here, for Andre to see:
- **`Revert` takes two presses**, the second asked for in words, as `Merge` does: it publishes a release.
- **"Stands" is an action and no record**: the month's verdict that a change stands is a curator's action on the merged suggestion, as a seed's decision is; nothing in the chain changes for a change that did not.

Verified: `lib/api/endpoints/curation-decision.test.ts` (an accept of a merged change as the verdict that it stands, refused once judged); the full suite, lint and build; the PT truncation suite; the live check above.

## 23. Review of unit 54 (2026-10-10)

One review of the whole unit, three lenses (the merge's correctness, authorisation and exposure, the pages and the house rules), each finding checked by one skeptic. Nineteen findings were raised, three of the merge lens's lowest set aside unverified, fifteen confirmed and one refuted; all fifteen are fixed in one commit.

- **A merge that changed nothing looped for ever** (high). A proposal whose applied file reads as `main`'s — an `EDIT_ROW` whose only effect is the Verified cell set to the month the row already says, a `SET_VALUE` printing the figure's existing text — was committed as nothing, checked as `PASSED` with no bump, filed under "Ready to merge" with an empty diff, and at the curator's merge `mergeMain` answered `AGAIN` on the missing bump, which the workflow took as "check again at once": prepare, check, record, merge, `AGAIN`, with no wait, until the engine's history limit.
  - **Fix**: the dry run fails a branch whose chapter reads as `main`'s (`unchanged`, a reason of its own in EN and PT), so the check is `FAILED` and returned, and `Merge` is never offered; `mergeMain` throws `NO_BUMP` for a row that still says so, which waits as a failed step; and the workflow checks again after an `AGAIN` at most twice in a row before it waits for a hand (`AGAIN_LIMIT`).
- **A revert whose merge the engine did not take was lost** (medium). The revert, the `REVERT` action and the original's `revertedBy` were written before the workflow start, and a start that failed left a `MERGING` revert no `Re-run check` could repair, since the restart carried no action: `NO_ACCEPT_RECORD` at every attempt, the original marked reverted for good.
  - **Fix**: `Re-run check` starts a revert's run with its action (`revertActionOf` at the door), so it records and merges as the first start would; and the decision's failure says the revert is written and names the path.
- **Every automatic revert of a figure with a unit fell to the curator's hand** (medium). The anchor's text is `label · valueText unit` and the pipeline's `valueText` already carries the unit (`77% %`, `1 s s`), which `parseValue` refuses.
  - **Fix**: the unit is taken off once before the value is read; four such cases are in `revert.test.ts`.
- **A reverted value lost its printed digits** (medium). `String(0.3)` for a `$0.30` price: the reverted file was not the original's byte for byte.
  - **Fix**: the reversed value keeps the digits as the book printed them (`decimalOfPrinted`); the test expects `0.50`.
- **Two merges close together could version against the wrong release** (medium, medium confidence). The versions were read from the current release at preparation while `main` might already hold a merge whose publish had not landed; and an ingestion that finished last could make its release current over a newer one.
  - **Fix**: `mergeMain` answers `AGAIN` when the current release is no longer the one the branch was prepared against, so the versions are read again; and the ingestion retires exactly the release it versioned against, failing with the conflict exit (3) when that release is not current any more.
- **A revert whose anchor moved went to a queue where nothing could decide it** (low). `MOVED` sent it along the moved path like a person's suggestion, and a revert has no workflow to take a decision.
  - **Fix**: a revert's moved anchor is written on its row and the run waits (stage `MOVED`), merging, for the curator's commit and `Re-run check`.
- **A hand-made revert waited for a lab the change it undoes merged without** (low, medium confidence). Its form is `RESTRUCTURE`, and D4 held it at `NOT_RUN`.
  - **Fix**: a revert's D4 is decided by the original's change kind.
- **Two reverts of one change could both be written** (medium). The guard reads ran before the writes under the default isolation; the loser's revert was a `MERGING` suggestion nothing could move.
  - **Fix**: the original's merge row is claimed with `revertedBy IS NULL` as the condition; a second writer updates nothing and its rows roll back (`written: false`). The integration suite races two reverts and expects one.
- **The public record offered an export the endpoint refuses** (low). **Fix**: no `Export` for the public audience; the rail takes `exportHref: null`.
- **The queue's panels kept their state across a change of item** (medium). A confirmation given for one item could be spent on the next. **Fix**: `QueueMerge` and `RevertPanel` are keyed by the suggestion, as `QueueDecision` was.
- **A moved anchor read as "checking" and was polled for ten minutes** (medium). **Fix**: `MOVED` is a merge state of its own, named in both languages, with `main`'s text beside the recorded one; nothing polls it.
- **The contributor's page stopped re-reading at an accept before the merge began** (medium, medium confidence). **Fix**: the "merge about to begin" refresher mounts for any accepted suggestion that merges after its decision (`mergesAfter`), bounded to a minute as before.
- **A merged revert's rail said "merged by · not yet" and credited "—"** (low). **Fix**: the merger is the last `MERGE` or `REVERT` curator record; a revert's credit box says nobody is credited, and its head says it has no contributor.
- **A revert whose check failed showed the contributor's request-for-more sentence** (low). **Fix**: `FAILED_REVERT`, in EN and PT.
- **The revert panel's counter was not announced and not tied to its field** (low). **Fix**: a label of its own, the counter a polite live region the textarea is described by, `aria-invalid` past the limit, as the decision panel has since the 53 review.

Refuted: `recordMergeAction` outside `noting()` — the step's failure is held by the workflow as `STEP_FAILED`, and the row's `READY` is the check's truth, not the step's.

Verified: `pipeline/check.test.ts` (the unchanged tree fails, a changed one passes with its hashes), `lib/improve/revert.test.ts` (seven reversed values), `lib/improve/merge.test.ts`, `tests/integration/merge.test.ts` (the race), the policy's suite, the full suite, lint and build.
