# witnesses

Fixtures for WP-10 of `plans/representative-corpus.md` (see its `# Revision` section,
WP-10's entry). WP-5 (commit `6ba370b`) fixed four frontmatter width defects and took a
measured 79 overflows down to 2; the files that drove those fixes now render clean, so
nothing distinguished "this file proved a silent correctness failure" from "this file is
unremarkable." A **witness** is a fixture plus a test that fails if its fix is reverted —
the mechanism that keeps that evidence durable instead of merely current.

Same intent as the private corpus harness's provenance record for vendored READMEs (a
different repo, described here by role only — this repo's own convention, per
`scripts/AGENTS.md`'s note that a private repository is named by what it does, never by
path) and as `tests/fixtures/wide-table.md` in this directory's parent: a fixture is not
just test data, it is evidence, and the reason it exists has to survive next to it.

## Layout

- **`witness-index.json`** — one record per witness: which defect it witnesses, the fixture
  file, the test(s) that assert the post-fix behaviour, the fix commit, how the fix was
  reverted to prove the witness (or why no revert differentiates it), and whether it is
  synthetic (no real driving file exists) or a minimal reconstruction of a real defect's
  shape (never a vendored third-party file — see `plans/representative-corpus.md`'s
  cross-repo caution: no corpus content or neighbour-repository material enters this repo).
- **`defect-0-crlf-frontmatter.md`** — real CRLF line endings, `-text` in the root
  `.gitattributes` so no `core.autocrlf` setting can silently convert it to LF and turn the
  witness inert. Valid YAML frontmatter; before the fix, CRLF reached the parser as bytes
  that do not parse and the block was echoed raw at very wide columns.
- **`defect-1-2-unparseable-frontmatter.md`** — a plain scalar followed by `{a: b} c`, a
  real deterministic `yaml` "nested mappings not allowed in compact mappings" error.
  Witnesses both defect 1 (the diagnostic summary must wrap; the excerpt/caret must not) and
  defect 2 (the raw echo is exempt from the width gate; nothing else is).
- **`defect-2-success-path-overwide.md`** — a *successfully parsed* meta block, over width
  only because its key is long. The scope-boundary half of defect 2: the exemption must
  never reach a block that parsed. See `witness-index.json`'s note on why this half does not
  differentiate the pre-fix commit (explained there, not glossed over).
- **`defect-3-nested-mapping.md`** — a `metadata` mapping nested at depth 1, wide enough that
  its `JSON.stringify`ed form exceeds every swept width. Before the fix this bypassed
  `targetWidth` entirely.
- **`defect-cjk-excerpt.md`** — synthetic, added by this WP rather than promoted from a real
  file (none in the corpus hits this yet). `yaml` folds its own parse-error excerpt to 80
  *characters*, not columns; a CJK-heavy title reaches far more than 80 *columns* at that
  same character budget. Deliberately left un-exempt by WP-5 — this fixture pins that the
  gate still catches it rather than silently emitting an over-width line.
- **`defect-wp14-list-item-inline-markup.md`** — added by WP-14, the first witness here that
  is not a WP-5 frontmatter defect. `marked-terminal`'s `text` renderer handed a list item
  its markdown *source*, so `**bold**` and `[label](url)` reached the terminal as literal
  syntax in every kind of list item and nowhere else. One item of each kind, plus the
  interactions the fix has to survive: a soft break that must coalesce and a hard break that
  must not, a reference-style link, a self-referential link, an escaped asterisk, and a fence
  nested in an item whose own `**not bold**` must stay verbatim.

## The tests do not all live in one file

WP-10's witnesses are asserted in `tests/witnesses.test.ts`; WP-14's is asserted in
`tests/render-list-layout.test.ts` (since split; `plans/representative-corpus.md`
originally assigned that WP `tests/render.test.ts`).
Each record's `test_file` and `describe` fields are authoritative — read those rather than
assuming a single test file.

## Why these are hand-built, not vendored

`tests/fixtures/wide-table.md`'s header calls itself "deliberately hostile": these fixtures
follow the same convention, and the same reason wide-table.md doesn't lift a real repo's
table applies here — a minimal reconstruction that reproduces the defect's exact shape is
smaller, more durable, and (per the sprint's cross-repo caution) keeps corpus content and
neighbour-repository material out of this repo entirely.

## Four of these six are swept by `bun run sweep` — by name, not by glob

Before WP-1 of `plans/gate-corpus-reframe.md`, the bundled default manifest's glob was
`tests/fixtures/*.md` — one path segment per `*`, so it matched files directly under
`tests/fixtures/` and never descended into this subdirectory; nothing here was swept.
**That is no longer true.** WP-1 replaced the glob with an explicit, wildcard-free path
list (`corpus/default-manifest.json`), and it names four of these six witnesses
individually: `defect-0-crlf-frontmatter.md`, `defect-1-2-unparseable-frontmatter.md`,
`defect-3-nested-mapping.md` and `defect-wp14-list-item-inline-markup.md` — every witness
that swept clean (`overflow=0 errors=0`) at the 5 default widths and both glyph tiers.
`defect-2-success-path-overwide.md` and `defect-cjk-excerpt.md` stay out **on purpose**:
both are witnesses of the width gate legitimately catching an over-width block, so
`overflow=0` is not their pinned behaviour — `witness-index.json`'s notes on each explain
why, and `tests/witnesses.test.ts`/`tests/frontmatter.test.ts` pin it. **This `README.md`
itself must never become a manifest entry** — `tests/gate-corpus.test.ts`'s eligibility
assertion rejects any entry ending `README.md`, independent of the exact-set pin.

These fixtures are still read directly by their own tests first and foremost — the
manifest entry does not replace `tests/witnesses.test.ts`/`tests/render-list-layout.test.ts`'s
assertions, it only adds the four clean ones to the gate corpus every sweep runs over.
All six are, and always were, scanned by the containment guard
(`tests/containment.test.ts`'s containment describe, which walks the whole tree outside
`runs/`, independent of the sweep manifest), same as every other file in the repo.
