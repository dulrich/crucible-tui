# Publication containment guard — reference

Detail behind the "Containment" section of `tests/AGENTS.md`. Rules live in `tests/helpers/containment.ts`; `tests/containment.test.ts` runs them over every file in the repo, itself included.

## Why inverse-shaped rules

A denylist of private strings cannot work: it only contains leaks somebody already found, and the literals themselves were the disclosure. The rules instead describe what this repo's own content looks like and flag everything else; nothing private is named anywhere in this repo.

| Rule | Flags |
|---|---|
| `foreign-path` | a path-shaped citation whose first segment is not a directory this repo has (the strip set's control-plane directories, such as the gitignored `runs/`, count even where a checkout lacks them), not an installed package (nor a listed former one), and not the sanctioned fake root — i.e. a neighbour's internal layout |
| `home-path` | an absolute path under a home-like root naming any account but the sanctioned fake one |
| `neighbour-name` | a bare mention of a directory that sits around this checkout, read from the filesystem at run time and never written down — a name in prose, which no path rule can see |

- It catches names nobody has enumerated: the path rule keys on shape, the neighbour rule reads the directories actually there.
- There is no self-exception: the rule fixtures are assembled from parts at run time (`["widget_factory", "internal", …].join("/")`) so the test file does not contain the shapes it tests for, and the scan covers it like any other file.
- `example` is the one sanctioned fake vocabulary (`example/…` relative, `/home/example/…` absolute). Anything else is a finding, fixtures included.
- Nothing can go inert: the path and home rules need no configuration, the neighbour rule needs only directories that necessarily exist, and a missing `node_modules` is a hard error rather than an empty package set.

## Scan boundary

The whole repository minus `SKIP_DIRS` and exactly the publication strip set: `DEFAULT_PUBLICATION_STRIP` (`plans/ reviews/ references/ runs/ INITIATIVE.md DEVELOPMENT.md FEEDBACK.md .publication.json`) plus `.publication.json`'s `strip`, read live by `publicationStrip` so guard and projection cannot drift. It is independent of any corpus manifest (`plans/gate-corpus-reframe.md`): `collectFiles` never reads `corpus/default-manifest.json`. The only link to the gate corpus is one pinned assertion in `tests/containment.test.ts` — no gate-corpus entry may begin `runs/` and no corpus root may be or resolve into `runs/`.

`SKIP_DIRS` is matched by name before the entry's type is consulted: in a worktree `.git` is a file (`gitdir: <path to the main checkout>`), and scanning it was a self-inflicted finding. Two regression tests pin this.

## Where a second checkout may live

The neighbour rule walks every ancestor to `/`, collecting sibling directory names at each level, and `ownNames` seeds itself from `basename(root)`. So:

- A checkout under a different ancestor chain (a temp dir) inherits that chain's unrelated directory names as forbidden tokens (measured: nine findings in a system-temp worktree).
- A checkout whose leaf directory is not named for the repo loses its own name to the neighbour set, so every self-mention is flagged (measured: 30 findings).

A worktree at `<code-root>/.worktrees/<label>/<repo-name>` scans clean (measured, 0 findings): the dot-named parent is invisible to this rule and to fleet initiative discovery, the leaf keeps the repo's name, and the ancestor chain matches the real checkout's. Prefer that over a full clone; clones parked in a plain directory inside the code root are discoverable as repositories and accumulate.

## Dependencies beside the clone, and removed dependencies

The neighbour rule drops a name that collides with an installed package only when the directory proves it is that package (a `package.json` naming itself).

The `foreign-path` rule reads its package whitelist from `node_modules`, so uninstalling a dependency turns every citation of its internals into a finding. `DOCUMENTED_FORMER_PACKAGES` in `tests/helpers/containment.ts` lists each such package with its reason: `marked-terminal`, `cli-table3` and `cli-highlight`. The list grows one entry per recorded removal and is the sanctioned response to the guard going red for this reason; it is not a general escape hatch. An entry is legitimate only for a package that was genuinely a declared dependency of this repo and was removed by a recorded work package (checkable from `THIRD-PARTY-LICENSES.txt`'s history). It cannot launder a private sibling's name, and it changes nothing about the neighbour rule: a neighbour directory carrying such a name still has to prove itself with a self-naming `package.json`.

Do not simplify by subtracting every installed package name from the neighbour set. The path rule treats a package name as a safe first segment (so `marked/lib/marked.cjs` can be cited), which makes the neighbour rule the only thing catching a private sibling whose name collides with a package (`<pkg-named-sibling>/private/layout.ts`). Three tests pin this, including the hole the evidence-based exemption leaves open.

## The supplement

Private strings that are neither path-shaped nor directory names (a person, a client, a host) cannot be derived, so a private list is the only instrument; the repo is told a path and knows nothing about the other end.

```bash
MDVIEW_PRIVATE_NAMES=<path to a {"names": [...]} JSON file> bun test tests
```

Unset: the three always-on rules run (the binding guard) and the test writes a line to stderr saying the supplement was not applied. Set: the file must exist and parse to a non-empty list of non-empty strings, or the test throws — a quiet fall-back would let the opt-in check rot into one that can never fail.

## Ordinary words are the neighbour rule's sharp edge

`isDistinctive` lets a name be flagged mid-sentence only when it carries a separator or a digit and is at least four characters. Everything else is flagged only inside a code span (`CODE_SPAN`: a backtick span or a double-quoted string). Several directories beside a checkout are single ordinary English words (e.g. 'archive', 'data', 'scratch'), so a git subcommand in a spawn argument list, a variable interpolated into a template literal, or the word inside a double-quoted error message turns the guard red while the same word in prose is fine.

The sanctioned escape is a single-quoted string literal: `CODE_SPAN` excludes single quotes deliberately, because in prose they are apostrophes. Renaming the identifier is the other fix and usually reads better. Do not weaken `isDistinctive` and do not subtract these names from the neighbour set to make a file pass.

## Record: the five-file test split (WP-R3, `plans/post-refactor-code-quality-remediation.md`)

WP-R3 split every test file of 1,000+ lines along its `describe` groups (no assertion or fixture changed); WP-9 of `plans/mdview-rust-port.md` then deleted the renderer's TypeScript tests (`TS_BASELINE` = `c097c66`). The record of where blocks landed, as of `TS_BASELINE`:

- `render-lists.test.ts` → `render-lists-wrapping` (loose/tight-list double-wrap witnesses), `render-lists-nesting` (nested-list and blockquote continuation, fenced code in a list item), `render-lists-guards` (coalesced-path and colon-guard collision witnesses, three colour-cannot-move-a-character repairs).
- `sweep.test.ts` → `sweep-manifest` (manifest parsing, corpus selection, symlink disclosure), `sweep-cli` (`parseArgs`'s ordinary measurement flags), `sweep-colour-axis` (colour-axis flags, `stripColourModeArgs`, `printColourAxis`, `renderWithForcedColor` non-vacuity). The last three survive.
- `wikilink.test.ts` → `wikilink-tokenizer`, `wikilink-emission`, `wikilink-table`.
- `table.test.ts` → `table-normalization`, `table-allocation`, `table-emission`; `LONG_PATH` was duplicated byte-for-byte into all three.
- `render.test.ts` split by production owner → `render-wikilinks`, `render-list-layout`, `render-frontmatter`, `render-emoji`, `render-core`.

`LONG_PATH` now lives in `crates/mdview/src/table/tests.rs`.
