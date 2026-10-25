# RESEARCH — Phase 01: replay counter

Date: 2026-10-22

## Summary

The parser API (`parse_packet`, `render_packet`) lives in `src/lib.rs` with
unit tests inline. A replay counter is a pure function over `&[Packet]` —
it belongs in a new `src/replay.rs` module re-exported from the crate root,
per the blueprint's module layout.

## Relevant files

- `src/lib.rs` — crate root; gains `pub mod replay;` + re-export
- `src/replay.rs` — NEW: `replay_count(&[Packet]) -> usize`
- `tests/replay.rs` — NEW: integration test `replay_counter_counts`

## Check targets (verified)

- exists: src/lib.rs
- exists: Cargo.toml
- exists: .github/workflows/ci.yml

## Proposed Automated Checks

- `grep -q 'pub fn parse_packet' src/lib.rs` — parser API intact
- `cargo check` — crate still compiles
- `cargo test replay_counter_counts -- --exact` — targeted proof of the new counter

## Risks

- The targeted cargo test takes a test NAME, not a file path — checks must
  not pass `tests/replay.rs` to `cargo test` expecting file filtering.
