---
title: 漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢 {a: b} c
other: 1
---

# Witness CJK Excerpt

Synthetic — no file in the corpus hits this shape yet. `yaml` folds its own parse-
error excerpt to 80 *characters*, not 80 columns; a title built from full-width CJK
runs at up to two display columns per character, so the excerpt can render far wider
than the 80-column target while still being exactly 80 characters of source. This is
deliberately left un-exempt (see `src/frontmatter.ts`'s catch branch): the excerpt is
not ours to fold, and if a real file ever hits this, the width gate must say so
rather than silently emitting an over-width line.
