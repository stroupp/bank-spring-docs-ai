# Gap Detection and Repair Hardening

## Reviewed Behavior

The gap pipeline reads `copilot-draft.md`, checks required Turkish sections, writes `detected-gaps.json`, builds a repair plan/context, asks Copilot for only weak sections, merges repaired sections into the draft, backs up an existing final document, and writes the final page document.

## Improvements Implemented

- Turkish heading normalization continues to fold `ı`, `ğ`, `ü`, `ş`, `ö`, and `ç` consistently.
- Duplicate level-two headings no longer overwrite prior section content during gap detection; their bodies are combined.
- Required sections emitted as orphan level-three headings can be recognized without making nested level-three children terminate a valid parent section.
- Duplicate gap findings are removed using normalized section + gap type + description.
- Page directories are created before gap/repair output writes.
- Repaired duplicate headings are still applied at most once.
- Repaired sections replace only an exactly normalized matching level-two section.
- Unmatched repair output is appended under `Ek Onarim Notlari`, preserving existing behavior.
- Source file references present in a replaced draft section are retained when the repair response omits them.
- Finalization now requires a non-empty, fresh Copilot draft. Repair fragments can no longer become a standalone “final” document.
- Existing final documents continue to be backed up before overwrite.
- Final metadata now includes project, branch, page, route, generation time, input hash, pipeline version, and the metadata comment.

## Safety Properties

- The original draft is never modified.
- `repaired-sections.md` remains a separate intermediate artifact.
- A previous final document is copied to a timestamped backup.
- Stale repair output is skipped.
- Stale or missing draft output causes finalization to fail with an actionable message.
- Source references are preserved across matching-section replacement.

## Remaining Limitations

- Heading parsing remains Markdown-oriented and does not understand arbitrary HTML headings or deeply irregular structures.
- Repair output with renamed headings is appended rather than semantically matched; this is safer than replacing an unrelated section.
- Gap detection still uses phrase and source-path heuristics. It does not validate every factual claim against evidence.
- The repair request has a single shared context budget; target-section-specific evidence budgets would improve large pages.
- Final backups have no retention policy. A future maintenance command may safely prune old backups with explicit user consent.

## Recommended Next Tests

- Turkish and ASCII versions of every required heading;
- parent `##` with multiple `###` children;
- duplicate required headings with one empty body;
- repaired heading aliases and duplicate repair headings;
- source-reference preservation during replacement;
- stale draft, stale repair, missing draft, and backup behavior.
