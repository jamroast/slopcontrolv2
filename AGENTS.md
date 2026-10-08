# SlopControl development rules

Rules for developing and fixing SlopControl (this repo: `slopconrolV2`).

## Development boundary

When the task is **developing or fixing SlopControl** (this repo: `slopconrolV2`):

- **Only edit** paths under `slopconrolV2/` (and SlopControl rules/skills).
- **Do not** create, edit, or delete files in managed project trees such as:
  - `basic-web-agent/` (JamPress)
  - `light-weight-crm-and-invoicing/`
  - any other app registered as a SlopControl project
- That ban includes managed projects' `.slopcontrol/` artifacts, `src/`, tests, env, and Docker files.
- Fixes for managed projects must go through **SlopControl runs** (`ask` → promote → research → develop → verify), not hand patches.
- Use **fixtures** under `slopconrolV2/packages/artifacts/fixtures/` for Intent / Blueprint reconcile / UI-gate smoke tests.
- Read-only inspection of a managed project is allowed when diagnosing SlopControl behaviour.
- **Exception:** the operator explicitly asks to edit a named managed project directly (e.g. "hotfix JamPress").

### Build-process configurator exception

The LLM build-process configurator (`POST /projects/:id/build-process/configure` and import-time onboarding) is **allowed** to write in a managed project's tree, but only through the guardrailed apply layer (`applyBuildProcessChanges`):

- **Allowed paths:** `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `Dockerfile*`, `docker-compose*.yml`, `.github/workflows/*.yml`, `Makefile`, `pyproject.toml`, `Cargo.toml`, `.nvmrc`, `.tool-versions` — build plumbing only.
- **Commands:** only binaries in the run-command allowlist (the resolved toolchain's bins + `corepack`/`node`).
- **Never:** application source, product `.env*` values (the deterministic `writeProjectRegistryEnv` helper is the only env writer), or anything outside the allowlist.

Rationale: build-process onboarding is SlopControl configuring *its own infrastructure contract* inside the project — like `ensureProjectNpmrc` and the canonical runtime env already do. Product changes still go through SlopControl runs. As the operator's agent, prefer calling the configurator over hand-editing build files in managed projects.

## Do not modify node_modules

- **Never** create, edit, delete, or patch files under any `node_modules/` directory (root or package-local).
- **Never** hand-edit `.pnpm` store paths or nested dependency trees.
- Dependency changes must go through package managers only (`pnpm add` / `pnpm update` / `package.json` + install).
- Reading type definitions or docs inside `node_modules` for API discovery is allowed when needed; treat that as **read-only**.
- If a dependency needs a fix, prefer: upgrade/downgrade the package, wrap it in our own package code, or contribute upstream — do not patch `node_modules` in place.

## Classification rules

- **No regex** for any judgment/intent/conflict/dependency-intent classification. Use LLM classifiers (`chatJson`, `*-llm.ts`) for: intent-vs-research flags, review routing, env/config transforms, project-name resolution, dependency intent, conflict classification.
- Regex **only** for structural markdown extraction (`extractSection`).
- LLM classifiers must be deterministically validated and **fail closed** — surface an error, never silently fall back to regex.

## Generic code

- SlopControl must stay fully generic. Never embed managed-project identifiers (`@jam/service-token`, `jamauth`, `jamroast`, `JamPress`, `burntjam`) in SlopControl code, packages, prompts, tool descriptions, playbooks, test fixtures, or doc examples — not even as examples.
- Domain knowledge lives in the managed project's own artifacts (`INTENT.json`, `RESEARCH.md`, `LEARNINGS.md`, knowledge cards) and is surfaced generically.
- When auditing, proactively scan for hardcoded project lists/names and replace with generic slug-based discovery.

## Fix the pipeline, not the errno

- Resolve failures via the full **classify → investigate → review → bounded-execute** pipeline, NOT per-instance/deterministic hardcoded fixes.
- Prefer self-healing/generic fixes over per-case manual fixes.
- Only modify the `slopconrolV2` repo — never hand-edit the managed target projects (SlopControl fixes those).

## Workflow

- After completing and verifying a fix, commit and push to `origin/main` as the final step.
- When reviewing code (e.g. a Cursor review), independently verify claims against the codebase and give your own assessment — fix only gaps independently judged valid.
- When fixing findings, handle one numbered finding at a time: verify typecheck + tests, report, await next instruction.
- Prefer adjusting timeouts/config over switching models. Retry agents on transient LLM errors. Use fallback model routing when LLM output is broken. When shrinking prompts, use intelligent summarization/selection, never straight truncation.

## Design-loop components

- Default to flat component structures; nested/collapsible only on explicit operator request (surface + confirm).
- Design-element evolution must distinguish COMPOSE (extract a distinct data-element-marked sub-element) from EVOLVE (the pinned element itself must change) — never auto-emit an evolve directive for a composition.
