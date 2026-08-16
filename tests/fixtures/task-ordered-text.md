# Task items whose text begins with an ordered marker

This fixture exists to fail loudly. Every item below is a GFM task item whose *text*
starts with `N.`, which is the one shape where the source pre-pass in `src/render.ts`
is load-bearing and the composition seam cannot replace it. See `src/AGENTS.md`,
"The task-state pre-pass", population P3.

### Phase 1

- [ ] 1. Alpha initialized
- [ ] 2. Beta configured
- [x] 3. Gamma verified

### Phase 2 — the control

These carry no ordered marker in their text and render identically with or without the
pre-pass, which is what isolates the cause.

- [ ] Delta initialized
- [x] Epsilon verified
