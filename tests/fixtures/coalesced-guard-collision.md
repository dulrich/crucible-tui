# Coalesced-path guard collision

The committed witness for WP-1 of `plans/renderer-deferred-work.md`. Every list below is
**tight** and every item's source spans two authored lines, so the renderer's coalescing
seam joins them and re-wraps them itself rather than leaving the wrap to the
post-composition pass. Each item carries a bare `*` in its prose, positioned so that at
some width the re-wrap starts a continuation line with it.

1. short lead
   and continues on a second authored source line * star token here and more words to push it over

The one-digit ordered marker is the defect case: the item's text column is 7, and one
guard space put it at 8, exactly on the four-column grid, where the bullet substitution
claimed the line. Width 65 corrupted; 64 and 66 were clean.

> 1. short lead
>    and continues on a second authored source line * star token here and more words to push it over

Inside a blockquote the same item sits four columns further right — column 11, still three
short of the grid — so the same collision reappears at a different width (69).

* short lead
  and continues on a second authored source line * star token here and more words to push it over

The unordered marker's text column is 6, so one guard space lands at 7 and misses the grid:
this item pins the single-space rule that was already correct.

1. one
2. two
3. three
4. four
5. five
6. six
7. seven
8. eight
9. nine
10. short lead
    and continues on a second authored source line * star token here and more words to push it over

The tenth item is the only way to reach a two-digit marker — `start` is deliberately
ignored, so a list authored `10.` alone renders `1.`. Its text column is 8, already on the
grid, and one guard space lands at 9: the other half of the single-space rule.
