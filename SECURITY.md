# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately through GitHub's private
vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. Only the
maintainers see the report, and the fix and the advisory are coordinated with you there.

Include what you can of:

- the component and the file or route (for example `workers/fetch/guard.ts` or `POST /api/v1/suggestions`);
- the steps to reproduce, from a clean checkout on the stub gateway if possible;
- what an attacker gains: whose data, which action, which budget;
- the commit you tested.

**Never send a key, a token, a password or a real credential, yours or anyone else's**, in a report, an issue, a
log excerpt or a screenshot. If you found an exposed secret, tell us *where* it is and *what kind* it is, and leave
the value out. Redact e-mail addresses and anything personal in what you paste.

We will acknowledge the report, keep you informed while we work on it, and credit you in the advisory unless you
ask us not to.

## Supported versions

The `main` branch. There are no maintained release branches.

## In scope

The code in this repository, and especially the boundaries it is built to hold:

- **Authorisation and tenancy**: a route that acts without the OPA decision it should ask for, a policy that allows
  what its tests say it denies, a read across organisations, a session or sign-in flaw.
- **The evidence fetcher** (`workers/fetch/`): any way to make the product request an internal address, a
  non-public network, a non-HTTPS URL, or to escape its size and time limits (SSRF).
- **Prompt injection with an effect**: a fetched page, an uploaded file or a web result that makes an agent *act*
  (write, escalate, change a score or a decision) rather than merely say something wrong.
- **The researcher's privacy boundary**: any path by which the person's question, or anything identifying them,
  reaches the reader that browses the web, a search query, or a fetched address.
- **The adjudicator's blindness**: any path by which a contributor's identity beyond `verified: true`, or a curator's
  note, reaches the adjudicator.
- **Ledger integrity**: changing, deleting or forging a ledger record without the chain check failing, or an audit
  export whose signature verifies over altered content.
- **Secrets**: a key or a credential that reaches a prompt, a log line, a span, a client bundle or a response.
- **Budgets**: a model call that escapes the gateway, or spends past a principal's cap.
- **Signed storage URLs**: reading or writing an object without a valid, unexpired token for that object and method.

## Out of scope

- The **development sign-in provider** (`/api/v1/auth/dev`) and the development defaults in `docker-compose.yml` and
  `.env.example` (for example the local database password). They exist for a local machine and are refused or
  replaced in production. A way to reach the dev provider in production *is* in scope.
- The **stub gateway** (`infra/gateway/stub/`), which is a development and CI stand-in.
- A model's answer that is wrong but triggers no action. Use **Flag this answer** in the app, or open an issue.
- The book's content: report that in the book's repository.
- Vulnerabilities in dependencies with no demonstrated impact on this app. Please report those upstream.
- Denial of service by volume, social engineering, and physical attacks.
