# Tree-sitter Java Endpoint Spike Report

Generated: 2026-07-11T21:06:13.443Z

## Scope and Safety

- Scope is limited to Java Spring controller endpoints.
- Production parser registry and default selection were not changed.
- DTO/entity, service-call, and repository parsing still delegate to the regex provider.
- AST failures return explicit diagnostics and a regex fallback instead of stopping the pipeline.

## Dependency Decision

- Compatible pair: tree-sitter 0.21.1 + tree-sitter-java 0.23.5.
- Packages are development dependencies for the spike. The native binding loaded successfully on Windows x64 / Node v20.16.0.
- Installed unpacked package sizes measured locally: tree-sitter 2,674,496 bytes; tree-sitter-java 6,223,115 bytes; node-addon-api 417,282 bytes; node-gyp-build 13,864 bytes.
- The Java grammar peer range is ^0.21.1 and therefore excludes tree-sitter 0.25; the latest core package was intentionally not selected.
- Official references: https://github.com/tree-sitter/node-tree-sitter and https://github.com/tree-sitter/tree-sitter-java

## Runtime Compatibility

- Native load and parse: PASS on Windows x64 / Node v20.16.0.
- VS Code installation observed: 1.128.0 on Windows x64.
- Extension Development Host native-load/package test: NOT RUN. The provider must remain non-production until this is verified because Electron/extension-host ABI and VSIX packaging are separate from the CLI Node test.

## Fixture Results

- AST endpoints: 7
- Regex endpoints: 6
- AST source ranges: 7/7
- AST validation metadata: 2 endpoints
- AST security metadata: 1 endpoints
- Multi-path RequestMapping endpoints: 2
- Controlled AST exception fallback: PASS (regex results retained with explicit reason and diagnostic).

## Micro Benchmark

50 iterations across 100 fixture parses:

- Tree-sitter: 237.73 ms
- Regex: 9.41 ms

This micro benchmark is directional only; extension-host profiling is still required before production activation.

## Cached Public Repository Comparison

- Controller files: 26
- AST endpoints: 141
- Regex endpoints: 141
- Shared normalized endpoint keys: 141
- AST-only keys: 0
- Regex-only keys: 0
- Files requiring AST-to-regex fallback: 0

## Diagnostics

- AST_SPIKE_ONLY: Bu sağlayıcı deneysel karşılaştırma içindir ve üretim parser registry varsayılanı değildir.
- REGEX_CAPABILITY_FALLBACK: Controller endpoint dışındaki Java yetenekleri mevcut regex sağlayıcısına devredilir.
- AST_REGEX_DIVERGENCE: AST/regex endpoint farkı algılandı (AST-only: 1, regex-only: 0); sonuç AST olarak korundu.

## Decision

The provider remains opt-in and test-only. Promotion requires reviewing AST-only/regex-only samples, adding extension-host packaging tests, and validating latency/memory on larger repositories.
