# Loose list probe

A loose list is any list where at least one item ends with a blank line. The lexer
stamps looseness onto the whole list, so every item below routes through mdview's own
paragraph override even though only the separation between them is blank.

## Loose list — the defect case

- This first item is deliberately long enough that it must wrap across several rendered lines at any reasonable terminal width, so that the double-reflow defect has room to show itself clearly in the output stream.

- The second item exists purely so that the list contains a blank line between items, which is what makes marked stamp the entire list as loose and route every item through mdview's own paragraph override, a live seam.

- A third long item, again written at sufficient length that the wrapping engine has to break it multiple times, which is precisely the condition under which the orphaned trailing word appears at the end of each wrapped segment.

## Loose list with a nested loose list

- An outer item carrying enough text to wrap at every width under test, so that the outer nesting level exercises the same wrapping budget the flat case does before recursion is considered at all.

  - A nested item that is itself long enough to wrap, which matters because the nested level is wrapped against a strictly smaller budget than its parent and must not be re-sheared by the shallower pass that runs afterwards.

  - A second nested item, present so the inner list also ends an item on a blank line and is therefore stamped loose in its own right rather than inheriting the outer list's state.

- A closing outer item, long enough to wrap, confirming that the outer list resumes at the outer budget once the nested list has been rendered and folded back into the parent body.

## Tight list — the control, must not change

- A tight list item written long enough that it wraps at every width under test, which is the point: tight items never reach the paragraph override at all, so this rendering is the reference the loose case should match.
- A second tight item, also long enough to wrap across multiple lines, with no blank line separating it from its neighbour so the lexer leaves the whole list tight.
- A third tight item, again long, closing the control list without introducing any blank line that would flip the list into the loose branch being fixed.

## Ordered tight list — a second control

1. An ordered tight item long enough to wrap, verifying that the ordered marker path is unaffected by whatever the loose-list fix does to the unordered one.
2. A second ordered item, also long enough to wrap over several lines at the widths under test.

## Plain prose — the non-list control

This paragraph is not part of any list and is deliberately long enough to be reflowed by the paragraph renderer at every width under test, so that any change to non-list prose wrapping shows up immediately as a diff in this fixture rather than hiding in a corpus.

> A blockquote, also long enough to wrap at every width under test, included because the blockquote renderer reads the same reflow flag the paragraph renderer does and must therefore be held as a control alongside it.
