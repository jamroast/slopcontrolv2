# Project verification conventions (declared)

Extracted verbatim from the project's own files — follow these over any
generic defaults when they declare a convention for the same thing.
Sources: AGENTS.md, .github/workflows/ci.yml

## AGENTS.md (verbatim)

# Agent conventions for packetd

- Verify changes with `cargo test <test_name> -- --exact` for the targeted
  proof, then `cargo test` for the whole suite before calling work done.
- `cargo clippy -- -D warnings` and `cargo fmt --check` must stay clean.
- Never add a dependency for something the standard library provides.
- Public functions on `src/lib.rs` keep doc comments with an example.

## CI check commands (quoted from workflows)

- `cargo test --workspace`
- `cargo fmt --check && cargo clippy -- -D warnings`
