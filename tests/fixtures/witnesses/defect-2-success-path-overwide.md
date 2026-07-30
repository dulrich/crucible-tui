---
kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: value
---

# Witness Success-Path Over-Width

This frontmatter block parses cleanly — the key above is merely very long, which is
pre-existing, unrelated behaviour used only as a reproducible way to make a
*successfully parsed* meta block exceed the target width. It is not the echoed raw
bytes of an unparseable block (defect 2's fixture), so it carries no exempt range and
must still be caught by the width gate. This is the scope-boundary half of defect 2:
the exemption must be narrow enough that this block is never swept up in it.
