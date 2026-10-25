# Phase 01 — Replay counter

## Scope

Add `src/replay.rs` with `replay_count(&[Packet]) -> usize` counting
packets whose (tag, payload) pair appears more than once. Re-export from
`src/lib.rs`.

## File Changes

| Path | Action |
| --- | --- |
| src/lib.rs | EDIT |
| src/replay.rs | NEW |
| tests/replay.rs | NEW |

## Build Order

1. Create `src/replay.rs` with `replay_count`.
2. Wire `pub mod replay;` + re-export in `src/lib.rs`.
3. Add `tests/replay.rs` integration test `replay_counter_counts`.

## Success Criteria

- `replay_count` counts exact duplicate packets (same tag AND payload).
- The targeted integration test proves the counter on a mixed stream.

## Automated Checks

```bash
set -euo pipefail
grep -q 'pub fn parse_packet' src/lib.rs || exit 1
grep -q 'pub mod replay' src/lib.rs || exit 1
grep -q 'pub fn replay_count' src/replay.rs || exit 1
grep -q 'fn replay_counter_counts' tests/replay.rs || exit 1
cargo check || exit 1
cargo test replay_counter_counts -- --exact || exit 1
```

## Blueprint Deltas

- **BD-01-1 — Feature logic lives in its own module.** New capabilities
  get a `src/<feature>.rs` module re-exported from the crate root; the
  crate root stays a thin API surface.
