# Blueprint

packetd is a single-crate Rust library. Parsing lives in `src/lib.rs`;
feature modules (e.g. `src/replay.rs`) extend it and are re-exported from
the crate root. Integration tests live in `tests/`.
