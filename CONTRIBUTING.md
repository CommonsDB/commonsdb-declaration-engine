# Contributing

Thanks for your interest in CommonsDB!

## Before you start

- Read [docs/architecture.md](docs/architecture.md) for the system overview and
  [docs/development.md](docs/development.md) for conventions and workflows.
- For anything non-trivial, open an issue first to discuss the approach.

## Development setup

```bash
pnpm install
npx sst build --stage staging   # generates SST type declarations
pnpm typecheck                   # must pass with 0 errors
```

Deploying or running `sst dev` requires an AWS account and stage secrets — see
[docs/setup.md](docs/setup.md). Pure code contributions can usually be validated with
`pnpm typecheck` plus unit tests.

## Ground rules

- TypeScript, ES modules, no `process.env` in runtime code (use SST `Config`).
- New DynamoDB/S3 access goes through a helper module in `packages/core`, not inline in handlers.
- Errors in the Kinesis consumer path must propagate — never swallow exceptions there.
- Prettier formatting (2 spaces, 120 cols); run it before committing.
- Keep `pnpm typecheck` green — it is the CI gate.
- Never commit credentials, `.env` files, private keys, or AWS account identifiers
  (`cdk.context.json` is gitignored for this reason).

## Pull requests

1. Fork / branch from `main`.
2. Make the change with tests where practical (Vitest for core logic, Jest integration test for
   new routes).
3. Describe **what** and **why** in the PR; link the issue.
4. A maintainer reviews and deploys to staging before merging to `main` (there is no automated
   pipeline; see docs/operations.md).

## Reporting security issues

Please do **not** open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
