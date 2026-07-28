# Tight list probe

A *tight* list is any list where no item ends with a blank line. The lexer never wraps a
tight item in a paragraph token, so `marked-terminal` never reflows it and the author's
own line breaks reach the renderer verbatim. Every list below is tight, and every item
is authored wrapped — the way real plans and briefs in this corpus are written.

## Tight list authored at about 115 columns — the defect case

- The meaningful granularity here is per-item and per-batch, which is also where it really matters: the longest
  workflows are loops over files, and each pass through one of them re-reads the state that the previous pass
  has already written out, so the cost is quadratic in the number of items rather than linear in the number.
- A second item, also authored wrapped at roughly the same column, present so that the list contains rather
  more than one item and the coalescing pass has an item boundary that it is forbidden to join across, in
  both of the directions, which a single-item fixture could never have demonstrated at any width at all.
- A third item, again authored wrapped, closing the list without any blank line that would have flipped the
  whole thing into the loose branch that WP-2b already closed and that this fixture must not exercise here.

## Tight list authored at about 122 columns — the defect at the user's most-used width

- An item authored wrapped at about one hundred and twenty-two columns, which is what a document written for a middling
  terminal looks like, and which therefore shears its tail at the narrower widths under test but not at the wider ones,
  giving the orphan metric a case at 116 and 120 that the hundred-column section above cannot produce for arithmetic.
- A second item at the same authored column, so that this section too has an item boundary the coalescing pass must not
  join across, and so that its own last line is not also the last line of the list, which the metric would then skip.

## Tight list authored at about 170 columns — the defect at the widest real terminal

- An item authored wrapped at roughly one hundred and seventy columns, which is what a document written for the widest of the three tiled terminal layouts looks like, and which
  therefore only shears its tail when the target width is narrower than the column the author wrapped at, so it exercises the same defect at a width the shorter items cannot reach.

## Tight list with hard line breaks — the breaks must survive

- A trailing double-space break ends this line,  
  and this text follows it, authored wrapped and long enough that the item is not trivially short at
  any width under test, so the break is the only thing that can have put the second part on its own line.
- A backslash hard break ends this line\
  and this text follows that one, likewise authored wrapped so the item spans several rendered lines.
- A break tag ends this line.<br />
  And this text follows the tag, again authored wrapped, so the tag is the only reason for the break.

## Tight list with a long URL and a long path on their own authored lines

- The reference for this behaviour is recorded at
  https://example.invalid/a/deliberately/long/url/that/must/never/be/split/or/joined/mid-token/ok
  and the local copy lives at
  /home/example/some/deliberately/long/filesystem/path/that/must/also/survive/a/join/verbatim.md
  so both tokens can be checked, by eye and by assertion, on either side of a coalescing pass.

## Tight list with a fenced block inside an item — the fence is never rewritten

- An item whose text is authored wrapped across two lines before the fence, so the coalescing pass has
  something to do in the same item that also carries a fence it must not touch:

  ```bash
  # * not a bullet, and 1. not a marker
  bun run --cwd mdview sweep
  echo "two  spaces above are not a break"
  ```

## Tight list with a nested tight list — no joining across the boundary

- An outer item authored wrapped across two lines, so the outer level has a soft break of its own to
  coalesce before the nested list is reached at all.
  - A nested item, also authored wrapped across two lines, which is wrapped against a strictly smaller
    budget than its parent and must not be re-sheared by the shallower pass that runs afterwards.
  - A second nested item, authored wrapped, so the inner list has an item boundary of its own too.
- A closing outer item, authored wrapped, confirming the outer level resumes after the nested list has
  been rendered and folded back into the parent body.

## Ordered tight list with ten items — the marker is four columns wide

1. The first ordered tight item, authored wrapped, so a budget computed from a hardcoded two-column
   marker would shear the tail off every line it produces at the widths under test.
2. Second.
3. Third.
4. Fourth.
5. Fifth.
6. Sixth.
7. Seventh.
8. Eighth.
9. Ninth.
10. The tenth ordered tight item, also authored wrapped — this is the item whose marker is four columns
    wide rather than three, and the one a hardcoded marker width gets wrong.

## Tight task list — the task-state sentinel must survive coalescing

- [x] A completed task, authored wrapped across two lines, so the coalescing pass runs over text that
  carries the task-state sentinel between its bracket and its state character.
- [/] An in-progress task in one of Obsidian's custom states, likewise authored wrapped across two
  lines so both the GFM-recognized and the custom-state paths are exercised here.

## Plain prose — the non-list control, must not change

This paragraph is not part of any list and is authored wrapped exactly the way the items above are, so
that any coalescing pass which leaked out of the list path would change this text and show up
immediately as a diff in this fixture rather than hiding somewhere in a corpus.
