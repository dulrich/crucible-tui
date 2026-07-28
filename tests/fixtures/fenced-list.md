# Fenced code inside list items

The WP-2f fixture. Two invariants live here, both invisible to every width gate:
`rewrapListBody` must never rewrite a line that belongs to a fenced block, and it must
never choose a line break that leaves a continuation line starting `*` or `N.`.

- A loose item whose fence carries a command far longer than any target width under
  test, which this pass used to split mid-command:

  ```bash
  echo "a deliberately very long command line that must never be rewrapped or reindented at all, at any width"
  ```

- A loose item with a **one-line** fence — the case that decides how strict the sentinel
  walk has to be, because the block's opening and closing markers land on the same
  physical line and so that line never *starts* inside a fence:

  ```bash
  printf '%s\n' "one physical line, opening and closing marker both on it, and still far too long to fit"
  ```

- A tight item with a fence, whose content carries both marker shapes as decoys:
  ```text
  * not a bullet, and 1. not a marker, on a line long enough that the pass would have split it
  ```

- An outer item, long enough to wrap on its own, so that the level below it is not the
  only thing this pass has to look at.

  - A nested item whose fence has to survive the shallower level's pass as well as its
    own, since every level runs this pass over the body it just composed:

    ```bash
    git log --oneline --graph --decorate --all --since="2026-01-01" --author="nobody" | head -40
    ```

- A second outer item.

An ordered list, so the renumbering pass runs over a body that contains a fence:

1. An ordered item carrying a fence of its own:

   ```bash
   rsync -avz --delete --exclude='*.tmp' ./source/ user@host.example.invalid:/srv/destination/
   ```

2. A second ordered item, which must keep its own number.

The marker-shaped-continuation case, which needs no fence at all — the pass chooses
where this item breaks, and one of the breaks lands on a bare `*`:

1. An ordered item padding word here to move the break point along by a measured amount and then * zero or more, not a bullet, and the item continues for a while after it so the line is long.
2. A second item that must keep its own number.
3. A third item that must keep its own number.
