# Lists inside blockquotes

The construct WP-2g exists for. Every list rendered by this tool carries at least four
columns of indent, and a blockquote adds four more on top of whatever its children
already had — so a marker glyph at column 0 anywhere in this file's rendered output is
the defect, not a style question.

> - A list item inside a blockquote, long enough that it has to wrap at least once at
>   every width under test so that its continuation lines are visible next to its own
>   marker rather than somewhere to the left of the quote.
> - A second item, also long enough to wrap onto a continuation line, so that the
>   alignment of the two items against each other can be compared directly at a width
>   where nothing has to wrap at all.

An ordered list, whose markers are wider than a bullet's and are never substituted for a
glyph, so the library still spells them as digits when the last pass over the body runs:

> 1. An ordered item inside a blockquote, long enough to wrap so that the column its
>    continuation lands at can be compared against the column its own text starts at.
> 2. A second ordered item, with a nested unordered list under it so that the drift the
>    re-alignment pass subtracts is exercised inside a quote as well as outside one.
>    - A nested item that is itself long enough to wrap at the widths under test, so its
>      own continuation column is observable.
>    - A second nested item, kept short.
> 3. A third ordered item, so the level's widest marker is still one character wide.

A heading inside a blockquote owes the same columns the quoted prose under it does, and
is reflowed through the same seam:

> ### A quoted heading, deliberately long enough that it has to be reflowed at the widths under test rather than fitting on one line
>
> The prose under that heading, also long enough to wrap, so the two are checked against
> the same budget.

A blockquote nested inside a blockquote, with a list at the bottom of it — two indents
still pending when the innermost list composes its body:

> > - The innermost item, long enough to wrap at every width under test so that the sum
> >   of both quotes' indents shows up in where its continuation lands.
> > - A second innermost item for comparison.

The other direction: a blockquote **inside** a list item is *legitimately* indented past
its item's text column by its own renderer, and nothing here may flatten it back.

- A list item that contains a quote, with prose of its own before it that is long enough
  to wrap at the widths under test:

  > Quoted prose inside a list item, long enough to wrap at every width under test, and
  > deliberately indented deeper than the item's own text column by the blockquote
  > renderer rather than by any defect.

  Trailing prose belonging to the same item, also long enough to wrap, which must land
  back at the item's own text column rather than at the quote's.

Fenced code inside a blockquote is never rewritten — it overflows, exactly as fenced code
does everywhere else in this tool, and stays inside a recorded code range:

> A quote that introduces a command.
>
> ```bash
> some-command --with a-very-long-argument --and another-long-one --so that this line is far past eighty columns
> ```
>
> Trailing prose after the fence.

A **one-line** fenced block inside a blockquote — the shape that decides how strict the
sentinel walk has to be, because its whole content sits on a line that both opens and
closes the sentinel pair:

> ```
> one-line fenced content that is comfortably longer than the narrowest width under test and must survive verbatim
> ```

A list inside a blockquote whose items carry a fence, so both passes that walk a composed
body meet a sentinel in the same document:

> - An item introducing a command:
>
>   ```sh
>   another-command --flag value --flag value --flag value --flag value --flag value --flag value
>   ```
>
> - A second item, long enough to wrap so that the item after a fence is still measured.

Plain quoted prose with no list in it at all, as the control: it is reflowed by the
library at the blockquote's own budget, so none of its lines should need the safety net,
and none of them should start at column 0.

> A plain blockquoted paragraph with no list in it, long enough to wrap at every width
> under test, included because the same indent that the list case loses is the one this
> case loses too — the mechanism is the blockquote's, not the list's.
