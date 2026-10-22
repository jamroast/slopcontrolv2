# Agent conventions for packetd

- Verify changes with `cargo test <test_name> -- --exact` for the targeted
  proof, then `cargo test` for the whole suite before calling work done.
- `cargo clippy -- -D warnings` and `cargo fmt --check` must stay clean.
- Never add a dependency for something the standard library provides.
- Public functions on `src/lib.rs` keep doc comments with an example.
