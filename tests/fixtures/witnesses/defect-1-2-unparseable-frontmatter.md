---
name: witness-unparseable
description: a witness value repeated so the block folds past width a witness value repeated so the block folds past width a witness value repeated so the block folds past width a witness value repeated so the block folds past width a witness value repeated so the block folds past width a witness value repeated so the block folds past width {a: b} c
author: Example
---

# Witness Unparseable Frontmatter

The `description` line above is a plain scalar followed by `{a: b} c`, which `yaml`
rejects as "Nested mappings are not allowed in compact mappings". This is a real,
deterministic parse error carrying the summary/excerpt/caret shape defects 1 and 2
witness: the diagnostic must wrap to the target width while the excerpt/caret stay
verbatim (defect 1), and the raw echo of this block is the file's own bytes, so it
must be exempt from the width gate rather than measured against it (defect 2).
