# Traceability Fixture Report

Generated: 2026-07-12T20:28:29.236Z

## Coverage

- Exact UI to BFF matches: 1
- Ambiguous path-variable matches: 1
- Unmatched UI calls: 1
- BFF outbound to BE records: 2
- Unresolved records: 3

Path variables in colon, Spring brace, template literal, and named-brace forms normalize to `/customers/{param}`. Missing leading slashes normalize safely. Ambiguous and unmatched records remain explicit.

Result: PASS.
