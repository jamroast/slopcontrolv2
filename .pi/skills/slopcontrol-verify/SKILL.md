---
name: slopcontrol-verify
description: Verify a SlopControl change (typecheck + tests) and, once green, commit and push to origin/main. Use after completing any fix to slopconrolV2, or when asked to commit and push.
---

# SlopControl verify + ship

Run these from the repo root (`slopconrolV2/`). This is a pnpm monorepo; the root scripts fan out to every package/app.

## 1. Install if the lockfile/deps changed

Only if `package.json` / `pnpm-lock.yaml` changed or deps are missing:

```bash
pnpm install
```

## 2. Typecheck

```bash
pnpm typecheck
```

Fails on any package's `tsc --noEmit` error. Fix errors before continuing — do not paper over them with `@ts-ignore` / `any`.

## 3. Tests

```bash
pnpm test
```

Runs every package/app `*.test.ts` via `node --import tsx --test`. Re-run and fix until green.

Targeted re-run when iterating on one package (avoids the full fan-out):

```bash
pnpm --filter @slopcontrol/<pkg> test
```

## 4. Commit and push

Only once typecheck **and** tests are green:

```bash
git add -A
git commit -m "<conventional-commit message>"
git push origin main
```

- Use conventional-commit prefixes that match the repo's history (`fix(...)`, `feat(...)`, `chore(...)`).
- Commit is the **final** step of a fix, never a midpoint with failing checks.
- If a fix touches multiple concerns, prefer separate, focused commits.

## Rules that apply here

- Only edit paths under `slopconrolV2/` — never managed project trees or `node_modules`.
- `pnpm build` is not a commit gate, but run it if you changed package `exports`/build output that other packages consume.
- On transient test/LLM failures, retry before assuming a real regression.
