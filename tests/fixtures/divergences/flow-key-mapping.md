---
just a scalar: line
not: [a, b]: c
---

# flow-key-mapping

The `yaml` package parses the block above and invents an empty-string key (`"": "c"`); yaml-rust2 rejects it.
