# legacy-migration-agent

TypeScript CLI on the Claude Agent SDK. Points a read-only agent at a legacy repo and writes an
evidence-cited migration and decommission plan.

## Commands

- `npm ci` - install (exact versions are pinned)
- `npm run build` - compile to `dist/`
- `npm test` - vitest; never calls the model
- `npm run lint` - typecheck `src/` and `tests/`
- `node dist/cli.js analyze examples/legacy-invoicing/app --dry-run` - deterministic inventory, no model
- `node dist/cli.js analyze <repo> --out report/` - full agent run (uses the model, costs money)

## Layout

- `src/analysis/` - static detectors (pure functions over a repo snapshot)
- `src/agent/` - read-only guard, MCP tools, subagent prompts, the `query()` call
- `src/plan/` - zod schema for the plan and citation verification
- `src/report/` - Markdown rendering
- `examples/legacy-invoicing/app/` - fictional fixture; `sample-report.md`, `plan.json`, `run.json` are real output

## Rules

- This is a public repo. Never commit secrets, tokens, or `.env` files.
- Nothing about Caleb's employer, its clients, or real systems. Fixtures stay fictional
  (`.example` hosts, fake credentials that do not match real key formats).
- Ask before any run that uses the model. Dry runs and tests are fine without asking.
- Tests must not call the model. Keep detectors deterministic and unit-tested against the fixture.
- Keep the agent read-only. Any change to `src/agent/guard.ts` needs matching allow/deny tests.
- Plain writing in docs. No emojis.
