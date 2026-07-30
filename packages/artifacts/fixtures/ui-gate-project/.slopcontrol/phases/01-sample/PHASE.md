# Phase 01: Make composer form fillable

## Scope

Keep the interactive form in the composer (`data-testid="composer-form"`). Fix so the operator can fill and submit.

## File Changes

- `src/components/composer-surface.tsx` — ensure form mode mounts actionable controls

## Success Criteria

- Composer shows fillable form with enabled input and submit
- data-testid=composer-form is present when an active form exists

## Automated Checks

```bash
npm test -- tests/composer-form.test.ts
grep -q 'data-testid="composer-form"' src/components/composer-surface.tsx
```

## Blueprint Deltas

- **BD-COMPOSER-FORM-MODE-RESTORED:** interactive form remains in the composer.
