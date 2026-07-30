---
name: witness-nested-mapping
metadata:
  priority: 6
  promptSignals:
    phrases:
      - witness harness phrase one
      - witness harness phrase two
      - witness harness phrase three
      - witness harness phrase four
      - witness harness phrase five
    weights:
      high: 3
      low: 1
---

# Witness Nested Mapping

`metadata` is a mapping nested at depth 1. `formatMapping` stops recursing at depth
>= 1 and stringifies the subtree instead of indenting further — by design, not the
defect. The defect was that the stringified subtree was pushed straight to output
without ever consulting `targetWidth`, so it grew as wide as `JSON.stringify` made
it. This witness's `phrases` list is long enough that the stringified form exceeds
every width this suite sweeps, so a regression shows up immediately.
