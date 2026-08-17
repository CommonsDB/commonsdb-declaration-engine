# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** using GitHub's private vulnerability
reporting: open this repository's **Security** tab and click **"Report a vulnerability"**. The
maintainer will follow up there.

Please include reproduction steps and affected endpoints/components. We aim to acknowledge
reports within a few business days. Do not open public issues or PRs for undisclosed
vulnerabilities.

## Scope notes for researchers

- The deployed APIs sit behind an API gateway performing key validation; the internal
  `x-api-key` checks in this codebase are defense-in-depth, not the primary customer auth.
- Declaration signatures (ES256 JWT with embedded JWK) and RFC 3161 timestamps are verified at
  ingest — flaws in that validation logic (`packages/functions/src/ingest.ts`,
  `packages/core/src/utils/tsaCryptoUtil.ts`) are of particular interest.
- The customer-keys API returns decrypted private keys by design to authorized internal callers;
  reports about weaknesses in its authorization or the at-rest encryption
  (`packages/core/src/customer-keys/`) are welcome.

## Secrets hygiene

No live credentials are committed to this repository. All runtime secrets are provisioned via
SST/SSM per environment (see docs/configuration.md). If you believe a secret has leaked in the
git history, report it privately immediately.
