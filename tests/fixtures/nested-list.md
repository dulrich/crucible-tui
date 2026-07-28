# Nested list continuation alignment

Fixture for WP-2e. Every item below is authored on a single source line, so nothing
here depends on the WP-2b loose path or the WP-2c tight-item coalescing pass: the only
thing under test is where a *nested* item's continuation lines land.

The mechanism this fixture exists to catch is `marked-terminal`'s `bulletPointLines` /
`numberedLines` adding a marker's width to every line an inner list already rendered as
a continuation, while leaving that inner list's marker lines alone. So each item that
has to demonstrate it is authored long enough to wrap **at every width the suite tests,
346 included** — a continuation that does not exist cannot be misaligned, and a fixture
that fits on one line at the widest real terminal would silently stop testing anything
there.

- A first-level unordered item, written at enough length that it wraps at 80 and 100 columns and gives the level-two items below it a parent whose own continuation alignment is worth checking at the same time.
  - A second-level unordered item, and this one is authored deliberately long enough that it still wraps even at 346 columns, which is the widest of the three tiled terminal layouts this tool is measured against, because the defect it demonstrates only becomes visible once a line has actually been wrapped and the wrapped remainder has somewhere to drift to. One ancestor level means one marker width of drift.
    - A third-level unordered item, also authored past 346 columns for the same reason, and this one sits under two ancestor levels rather than one, so before the fix its continuation lines drifted twice as far from their own marker's text column as the second-level item's did. Both are wrong; the deeper one is more wrong, and a fix that only handles one nesting level would pass a shallower fixture.
  - A second second-level item, short.
- A first-level item whose nested list is ordered, so the marker width the parent level adds is three columns rather than two:
  1. An ordered second-level item, authored long enough to wrap at 346 columns as well, because an ordered parent pads its non-marker lines with the width of a number and a full stop and a space rather than the two columns an unordered bullet costs, and a fix that hardcodes two would leave exactly one column of drift here and nowhere else.
     1. A third-level ordered item under an ordered parent, also past 346 columns, which is the case where two different marker widths compose and the drift is the sum of them rather than a multiple of either.
  2. A second ordered item, short.

1. A first-level *ordered* item, with an unordered sub-list, checking the mirror of the case above.
   - A second-level unordered item under an ordered parent, authored past 346 columns once more so that its continuation lines exist at every width under test and can be compared against the column its own bullet starts its text at.
   - A short sibling.
2. A second first-level ordered item, short.

- A first-level item whose nested item carries a fenced block, which is never rewritten:
  - A second-level item long enough to wrap at 346 columns, introducing a fence whose contents include lines that look like list markers, so that a re-alignment pass which is not sentinel-aware corrupts them visibly rather than subtly.

    ```bash
    # * not a bullet, and 1. not a marker
    bun run --cwd mdview sweep
        echo "these four leading spaces are content, not indentation"
    ```

- A first-level item ending in a long token: https://example.invalid/a/long/url/inside/a/list/item/ok
  - See https://example.invalid/a/second/deliberately/long/url/inside/a/nested/list/item/which/must/also/survive/verbatim/ok
