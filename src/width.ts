import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import stringWidth from "string-width";

/**
 * Display-width measurement, and the East Asian **Ambiguous** question (WP-3).
 *
 * ## Why this module exists at all
 *
 * Almost every non-ASCII character this corpus actually contains — `—` `–` `→` `←`
 * `…` `≥` `×` `•` `○` `─` `│` — is East Asian **Ambiguous** (Unicode TR11). An
 * ambiguous character is one that a terminal renders at *either* 1 or 2 columns
 * depending on its own configuration and locale, and there is no way to know which
 * from the byte alone. `string-width@7` defaults to narrow (`ambiguousIsNarrow:
 * true`), which is also what TR11 itself recommends when the context cannot be
 * established — and until this WP that default was hardcoded at 26 call sites across
 * 7 modules, because `string-width` takes the setting as a **per-call option** and
 * offers no global switch.
 *
 * So this module is now the **only** file in `src/` or `scripts/` that imports
 * `string-width`. That is a checkable property, and `tests/width.test.ts` checks it:
 * if a future edit reaches for `stringWidth` directly, half the renderer silently
 * stops honouring the resolved mode and the tool measures itself two different ways
 * at once — the exact class of bug `src/table.ts`'s v4/v7 reconciliation loop exists
 * to paper over, and one that no width gate can see, because a gate that measures
 * with the wrong ruler passes.
 *
 * ## The mode is threaded, never a module-level global
 *
 * `src/glyphs.ts` states the precedent in its own header: it is the only module that
 * reads the environment, and `render.ts`/`table.ts` stay pure and take a `GlyphSet`
 * argument so every test is deterministic regardless of the machine. A process-global
 * `ambiguousIsNarrow` here would be smaller but is precisely what that comment was
 * written to prevent: it makes every test's result depend on whatever ran before it,
 * and it makes the sweep's numbers depend on the machine that ran it.
 *
 * A `Measure` is therefore a value, passed alongside the `GlyphSet` on the same
 * channel (`cli.ts` → `renderDocumentDetailed` → `renderTable`), and defaulting to
 * `NARROW_MEASURE` at every public entry point. The default is not a convenience: it
 * *is* rule 4 of the resolution order below, so a caller that says nothing gets the
 * documented fallback rather than an unset. And because the narrow path calls
 * `stringWidth(text)` with no options at all — byte-for-byte the call every one of
 * those 26 sites used to make — every existing caller is unchanged **by
 * construction**, not by measurement.
 *
 * ## Resolution order (highest first) — mirrors `resolveGlyphs`
 *
 * 1. `MDVIEW_AMBIGUOUS=narrow|wide` in the environment. Any other value — including
 *    unset, empty, or a typo — is ignored and falls through. Never throws on a bad
 *    env var; that is the `MDVIEW_GLYPHS` contract and this matches it exactly.
 * 2. A cached probe result for **this terminal identity** (see `terminalIdentity`).
 * 3. A live DSR probe, if and only if stdin *and* stdout are TTYs and the caller
 *    allowed probing. Never in `--check`, never in the sweep, never headless — those
 *    have to stay deterministic and subprocess-free.
 * 4. **Narrow.** Every headless, redirected, piped, timed-out and unparseable case,
 *    and TR11's own recommendation when the context cannot be established.
 *
 * ## What wide mode does *not* fix
 *
 * `cli-table3` bundles its own `string-width@4`, which has no `ambiguousIsNarrow`
 * option at all, so its internal cell padding can never honour wide mode. See
 * `src/table.ts`'s `renderTable` for what the existing re-render loop does and does
 * not absorb, and `AGENTS.md`'s "Ambiguous width (WP-3)" for the measured residual.
 */

// ---------------------------------------------------------------------------
// The measure
// ---------------------------------------------------------------------------

export type AmbiguousWidth = "narrow" | "wide";

/**
 * A display-width function that knows which ambiguous-width convention it applies.
 *
 * Callable, so a call site reads `measure(text)` exactly where it used to read
 * `stringWidth(text)` — the swap is mechanical and reviewable — while the `ambiguous`
 * tag keeps a `Measure` self-describing for diagnostics and for tests that need to
 * assert *which* ruler a code path was handed.
 */
export interface Measure {
  (text: string): number;
  readonly ambiguous: AmbiguousWidth;
}

function makeMeasure(ambiguous: AmbiguousWidth): Measure {
  // The narrow branch deliberately passes **no options object**: `{ ambiguousIsNarrow:
  // true }` is string-width@7's documented default, but "identical to the default" and
  // "the default" are not the same claim, and this WP's binding acceptance criterion is
  // that narrow-mode output is byte-identical to the parent commit. Calling exactly the
  // function the parent commit called makes that true by construction.
  const fn =
    ambiguous === "wide"
      ? (text: string): number => stringWidth(text, { ambiguousIsNarrow: false })
      : (text: string): number => stringWidth(text);
  return Object.assign(fn, { ambiguous }) as Measure;
}

/** East Asian Ambiguous characters measure 1 column. The default, and TR11's own advice. */
export const NARROW_MEASURE: Measure = makeMeasure("narrow");

/** East Asian Ambiguous characters measure 2 columns. */
export const WIDE_MEASURE: Measure = makeMeasure("wide");

export function measureFor(ambiguous: AmbiguousWidth): Measure {
  return ambiguous === "wide" ? WIDE_MEASURE : NARROW_MEASURE;
}

/** Parse an `MDVIEW_AMBIGUOUS`-shaped value; anything unrecognized is `undefined`. */
export function parseAmbiguousWidth(value: string | undefined): AmbiguousWidth | undefined {
  if (value === "narrow") return "narrow";
  if (value === "wide") return "wide";
  return undefined;
}

// ---------------------------------------------------------------------------
// Terminal identity and the cache
// ---------------------------------------------------------------------------

/**
 * `$XDG_CACHE_HOME/mdview/ambiguous-width.json`, else `~/.cache/mdview/...`.
 *
 * Same shape as `resolveConfigPath` in `src/config.ts`, one directory over: this is
 * derived, reproducible state (throw it away and the next probe regenerates it), so it
 * belongs in the cache directory rather than the config directory the user hand-edits.
 */
export function resolveAmbiguousCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgCacheHome = env.XDG_CACHE_HOME;
  const cacheHome = xdgCacheHome && xdgCacheHome.length > 0 ? xdgCacheHome : join(homedir(), ".cache");
  return join(cacheHome, "mdview", "ambiguous-width.json");
}

/**
 * A stable key for "the terminal this answer was measured in".
 *
 * **A cache that hands ghostty urxvt's answer is worse than no cache**, and the user
 * runs both — plus ghostty *inside zellij*, where the multiplexer, not the terminal,
 * is what actually draws the cells. So the key is deliberately over-specified rather
 * than just `TERM`:
 *
 * - `TERM` alone does not separate them reliably: a multiplexer rewrites it, and two
 *   different emulators routinely claim `xterm-256color`.
 * - `TERM_PROGRAM` is what actually names ghostty; `COLORTERM` and `VTE_VERSION`
 *   separate several others.
 * - The multiplexer is its own layer of cell drawing, so zellij/tmux/screen is part of
 *   the identity even when every other variable is unchanged.
 * - **The locale is in the key because it is the single biggest thing that changes the
 *   answer**: a terminal's ambiguous-width behaviour is conventionally locale-driven,
 *   so the same emulator can legitimately answer narrow under one `LANG` and wide
 *   under another.
 *
 * The key is stored readable rather than hashed: a stale or surprising cache entry has
 * to be diagnosable by looking at the file, and `mdview probe` prints it verbatim.
 * Over-specifying only ever costs a re-probe (~a few ms, once); under-specifying costs
 * a silently wrong render.
 */
/**
 * Which multiplexer is drawing the cells — the **innermost** one, which is the layer that
 * answers DSR and decides wrapping.
 *
 * **Order matters here, and the naive one is wrong.** Multiplexers do not agree about
 * cleaning up after themselves: `tmux` strips `ZELLIJ`/`ZELLIJ_SESSION_NAME` from a new
 * session's environment, but **`screen` does not** — so inside screen-within-zellij both
 * `STY` and `ZELLIJ` are set, and a plain `ZELLIJ ? … : TMUX ? … : STY ? …` chain reports
 * `zellij` for a session screen is actually drawing. Measured 2026-07-28: a detached
 * screen session started from a zellij pane reported `TERM=screen`, `STY=…`, `ZELLIJ=0`
 * simultaneously.
 *
 * `TERM` is the tiebreaker, because the innermost multiplexer is the last thing to set
 * it: screen sets `screen*`, tmux sets `tmux*` (or `screen*`), and zellij passes a plain
 * `xterm*` through. So a `screen*` `TERM` with `STY` set means screen really is innermost,
 * whatever an outer multiplexer left lying around; zellij-inside-screen keeps its
 * `xterm*` `TERM` and still resolves to `zellij`, correctly.
 *
 * The cache cost of getting this wrong is only a spurious miss (screen-in-zellij and bare
 * screen would key differently and each re-probe once). The real cost is that
 * `mdview probe` would **print a false statement** about the user's own terminal stack,
 * in the one output whose entire job is to be believed.
 */
function detectMultiplexer(env: NodeJS.ProcessEnv): string {
  const term = env.TERM ?? "";
  if (env.STY && term.startsWith("screen")) return "screen";
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ || env.ZELLIJ_SESSION_NAME) return "zellij";
  if (env.STY) return "screen";
  return "none";
}

export function terminalIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const multiplexer = detectMultiplexer(env);
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const parts = [
    `term=${env.TERM ?? ""}`,
    `program=${env.TERM_PROGRAM ?? ""}`,
    `colorterm=${env.COLORTERM ?? ""}`,
    `vte=${env.VTE_VERSION ?? ""}`,
    `mux=${multiplexer}`,
    `locale=${locale}`,
  ];
  return parts.join("|");
}

interface CacheFile {
  version: number;
  entries: Record<string, { ambiguous: AmbiguousWidth; probedAt: string }>;
}

const CACHE_VERSION = 1;

/**
 * Read one identity's cached answer, or `undefined`.
 *
 * **Never throws.** A missing, unreadable, truncated, hand-mangled or
 * wrong-version cache file is indistinguishable from "not cached yet" here, and
 * degrades to a re-probe. A cache is by definition reconstructible; a viewer that
 * refuses to render because a derived file is corrupt would be trading the thing the
 * user asked for against state they never knew existed.
 */
export async function readCachedAmbiguousWidth(
  identity: string,
  path: string,
): Promise<{ ambiguous: AmbiguousWidth; probedAt: string } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const file = parsed as Partial<CacheFile>;
    if (file.version !== CACHE_VERSION) return undefined;
    const entries = file.entries;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return undefined;
    const entry = (entries as Record<string, unknown>)[identity];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const ambiguous = parseAmbiguousWidth((entry as { ambiguous?: unknown }).ambiguous as string | undefined);
    if (ambiguous === undefined) return undefined;
    const probedAt = (entry as { probedAt?: unknown }).probedAt;
    return { ambiguous, probedAt: typeof probedAt === "string" ? probedAt : "unknown" };
  } catch {
    return undefined;
  }
}

/**
 * Record one identity's answer, preserving every other identity already in the file.
 *
 * Written atomically (temp file in the same directory, then `rename`), the same
 * pattern `writeHighlightAlias` uses in `src/config.ts`: a failure partway through can
 * never leave a truncated cache on disk. Unlike that function this one does **not**
 * refuse an unparseable existing file — the config is the user's, a cache is ours, and
 * the right response to a corrupt cache is to replace it, not to make the user delete
 * a file they never created.
 *
 * Never throws: an unwritable cache directory (read-only home, full disk) must cost a
 * re-probe next time and nothing else. Returns whether the write actually landed.
 */
export async function writeCachedAmbiguousWidth(
  identity: string,
  ambiguous: AmbiguousWidth,
  path: string,
): Promise<boolean> {
  let file: CacheFile = { version: CACHE_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>;
    if (parsed.version === CACHE_VERSION && typeof parsed.entries === "object" && parsed.entries !== null) {
      file = { version: CACHE_VERSION, entries: parsed.entries as CacheFile["entries"] };
    }
  } catch {
    // Missing or unusable: start from an empty file rather than failing the probe.
  }
  file.entries[identity] = { ambiguous, probedAt: new Date().toISOString() };

  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `.ambiguous-width.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The DSR probe
// ---------------------------------------------------------------------------

/**
 * The character the probe measures.
 *
 * U+2014 EM DASH, chosen because it is the ambiguous character this corpus actually
 * contains most of (90 of them in a single real document) — the probe measures the
 * thing whose misrendering motivated the WP, not an abstract representative. Terminals
 * treat ambiguous width as one global setting rather than per-character, so one probe
 * answers for the whole class; `mdview probe` prints which character it used so a
 * disagreement is at least visible.
 */
export const PROBE_GLYPH = "—";

/** Default DSR reply deadline. Short enough that a silent terminal costs nothing perceptible. */
export const PROBE_TIMEOUT_MS = 200;

export interface ProbeReport {
  /** The inferred setting, or `null` when nothing usable came back. */
  ambiguous: AmbiguousWidth | null;
  /** One human-readable sentence: what happened, in the diagnostic's own words. */
  detail: string;
  /** The raw DSR reply with escapes made printable, or `null` if none arrived. */
  reply: string | null;
  /** Reported cursor column before and after writing the glyph, when both arrived. */
  columns: { before: number; after: number } | null;
  /** Measured columns the glyph occupied (`after - before`), when derivable. */
  glyphColumns: number | null;
  elapsedMs: number;
}

/**
 * The slice of `process.stdin` this module uses, named as an interface so a test can
 * hand in a scripted terminal without a pty.
 *
 * **Reads are pull-based (`"readable"` + `read()`), not push-based.** Both spellings
 * work under Bun on a raw TTY — verified against a scripted pty, twice in a row on one
 * stream, which is what this code needs since a probe issues two DSR queries in
 * sequence. Pull is the one chosen because it keeps draining and cleanup in the same
 * place: the listener owns the buffer, `read()` returns `null` when the kernel buffer
 * is empty, and nothing is left half-consumed between the two queries.
 */
interface Tty {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  read: () => unknown;
  on: (event: string, listener: () => void) => unknown;
  off: (event: string, listener: () => void) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  /**
   * `pause()` stops delivery but does **not** stop stdin from holding the event loop
   * open — measured: without the `unref()` in `probeAmbiguousWidth`'s `finally`,
   * `mdview probe` printed its whole report and then hung forever with nothing left
   * to do. Optional because a scripted test double has no loop to release.
   */
  unref?: () => unknown;
}

interface Out {
  isTTY?: boolean;
  columns?: number;
  write: (text: string) => unknown;
}

const DSR_REPLY = /\x1b\[(\d+);(\d+)R/; // eslint-disable-line no-control-regex

function printable(reply: string): string {
  return reply.replace(/\x1b/g, "\\e").replace(/[\x00-\x1f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`); // eslint-disable-line no-control-regex
}

/**
 * Ask the terminal where the cursor is (DSR, `CSI 6n`) and wait for `CSI r ; c R`.
 *
 * Resolves `null` on timeout, on a reply that never matches, or when the user hits
 * Ctrl-C — which in raw mode arrives as a `\x03` **byte** rather than a signal, since
 * raw mode is exactly what turns ISIG off. Treating it as an abort is not politeness:
 * without it the only way out of a hung probe would be to kill the process, which is
 * the one path that cannot run the `finally` that restores cooked mode.
 */
async function queryCursor(
  stdin: Tty,
  stdout: Out,
  timeoutMs: number,
): Promise<{ row: number; column: number; raw: string } | null> {
  return new Promise((resolve) => {
    let buffered = "";
    let settled = false;

    const finish = (value: { row: number; column: number; raw: string } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      stdin.pause();
      resolve(value);
    };

    const onReadable = (): void => {
      for (;;) {
        const chunk = stdin.read();
        if (chunk === null || chunk === undefined) break;
        buffered += Buffer.from(chunk as Uint8Array).toString("latin1");
      }
      if (buffered.includes("\x03")) return finish(null); // Ctrl-C: abort, do not hang
      const match = DSR_REPLY.exec(buffered);
      if (match) finish({ row: Number(match[1]), column: Number(match[2]), raw: buffered });
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    stdin.on("readable", onReadable);
    stdin.resume();
    stdout.write("\x1b[6n");
  });
}

/**
 * Measure how many columns this terminal gives one ambiguous character.
 *
 * **The method deliberately never moves the cursor to a position it did not already
 * occupy.** It asks where the cursor is, writes one character there, asks again, and
 * the difference is the answer. The alternative — carriage-return to column 1, write,
 * restore — overwrites whatever the shell prompt left on that line, and the write is
 * not recoverable because we never knew what was there. Here the only cell touched is
 * one the cursor was about to write to anyway, and erasing from the saved column to
 * the end of the line puts it back exactly.
 *
 * Two guarantees this function owes and the reasons they are structured the way they
 * are:
 *
 * - **Cooked mode is restored on every path.** The restore is in a `finally`, so a
 *   throw from the write, the read, or the timer cannot skip it, and it is *also*
 *   registered as a `process.on("exit")` handler for the duration — because a `finally`
 *   does not run when the process is killed, and a terminal left in raw mode is a shell
 *   the user has to `reset`. The handler is removed in the same `finally`, so nothing
 *   leaks across calls.
 * - **No visible artefact.** The glyph is erased by returning to the recorded column
 *   and clearing to end of line, which is exact rather than approximate: nothing to the
 *   right of the cursor existed before we wrote it.
 *
 * Refuses to probe within two columns of the right margin instead of guessing: a glyph
 * written there wraps, the second DSR reports a column on the *next* row, and the erase
 * would clear a line the probe did not write. Reporting "inconclusive, re-run from the
 * start of a line" is a worse answer than probing, and a much better one than corrupting
 * the screen.
 */
export async function probeAmbiguousWidth(
  stdin: Tty = process.stdin as unknown as Tty,
  stdout: Out = process.stdout as unknown as Out,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeReport> {
  const started = Date.now();
  const fail = (detail: string, extra: Partial<ProbeReport> = {}): ProbeReport => ({
    ambiguous: null,
    detail,
    reply: null,
    columns: null,
    glyphColumns: null,
    elapsedMs: Date.now() - started,
    ...extra,
  });

  if (!stdin.isTTY || !stdout.isTTY) {
    return fail(
      `not probing: stdin is ${stdin.isTTY ? "a TTY" : "not a TTY"} and stdout is ${stdout.isTTY ? "a TTY" : "not a TTY"} — a DSR probe needs both`,
    );
  }
  if (typeof stdin.setRawMode !== "function") {
    return fail("not probing: this stdin has no raw mode, so a DSR reply could not be read back");
  }

  const wasRaw = stdin.isRaw === true;
  const restore = (): void => {
    try {
      stdin.setRawMode?.(wasRaw);
    } catch {
      // Nothing useful to do; the process is on its way out.
    }
  };
  const release = (): void => {
    try {
      stdin.pause();
      stdin.unref?.();
    } catch {
      // Same.
    }
  };
  // Three layers, because a `finally` alone is not enough and the gap is the user's
  // shell. `finally` covers a throw or a normal return; `"exit"` covers `process.exit`
  // and an unhandled rejection; the signal handlers cover an external `kill`, whose
  // *default* disposition terminates the process without emitting `"exit"` at all —
  // which is precisely the case that would strand a terminal in raw mode. Each handler
  // restores and then exits with the conventional 128 + signal code, so the caller's
  // shell still sees a killed process rather than a swallowed signal. All of them are
  // removed in the `finally`, so nothing leaks past the probe's ~200ms window.
  const signals: Array<[NodeJS.Signals, number]> = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ];
  const signalHandlers = signals.map(([signal, code]): [NodeJS.Signals, () => void] => [
    signal,
    () => {
      restore();
      process.exit(code);
    },
  ]);
  process.on("exit", restore);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    stdin.setRawMode(true);

    const before = await queryCursor(stdin, stdout, timeoutMs);
    if (!before) {
      return fail(`no DSR reply within ${timeoutMs}ms — the terminal did not answer \\e[6n`);
    }

    const columns = stdout.columns;
    if (typeof columns === "number" && columns > 0 && before.column + 2 > columns) {
      return fail(
        `inconclusive: the cursor is at column ${before.column} of ${columns}, too close to the right margin for the test glyph to be measured without wrapping — re-run at the start of a line`,
        { reply: printable(before.raw) },
      );
    }

    stdout.write(PROBE_GLYPH);
    const after = await queryCursor(stdin, stdout, timeoutMs);
    // Put the cell back however this turned out: the glyph is on screen from here on.
    stdout.write(`\x1b[${before.column}G\x1b[K`);

    if (!after) {
      return fail(`no DSR reply within ${timeoutMs}ms after writing the test glyph`, {
        reply: printable(before.raw),
      });
    }
    if (after.row !== before.row) {
      return fail(
        `inconclusive: writing the test glyph moved the cursor from row ${before.row} to row ${after.row}, so the column difference is not a width`,
        { reply: printable(after.raw) },
      );
    }

    const glyphColumns = after.column - before.column;
    const shared = {
      reply: printable(after.raw),
      columns: { before: before.column, after: after.column },
      glyphColumns,
      elapsedMs: Date.now() - started,
    };
    if (glyphColumns === 1) {
      return { ambiguous: "narrow", detail: `the terminal rendered ${PROBE_GLYPH} in 1 column`, ...shared };
    }
    if (glyphColumns === 2) {
      return { ambiguous: "wide", detail: `the terminal rendered ${PROBE_GLYPH} in 2 columns`, ...shared };
    }
    return {
      ambiguous: null,
      detail: `inconclusive: the terminal reported ${glyphColumns} columns for ${PROBE_GLYPH}, which is neither 1 nor 2`,
      ...shared,
    };
  } catch (error) {
    return fail(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    restore();
    release();
    process.off("exit", restore);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type AmbiguousSource = "env" | "cache" | "probe" | "default";

export interface AmbiguousResolution {
  ambiguous: AmbiguousWidth;
  measure: Measure;
  /** Which rule of the precedence order actually won. */
  source: AmbiguousSource;
  /** One sentence naming *why* that rule won, for `mdview probe` to print verbatim. */
  detail: string;
  identity: string;
  cachePath: string;
  /** Present only when a live probe ran. */
  probe?: ProbeReport;
}

export interface ResolveAmbiguousOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Whether a live DSR probe is permitted. **Off by default**, which is the important
   * direction: `--check`, the sweep and every test must never spawn terminal I/O, and
   * a default of "probe unless told otherwise" would make that a thing each of them
   * has to remember rather than a thing they get for free.
   */
  allowProbe?: boolean;
  /** Skip the cache read and re-probe (`mdview probe --refresh`). */
  refresh?: boolean;
  /** Skip the cache write. */
  noCache?: boolean;
  stdin?: Tty;
  stdout?: Out;
  timeoutMs?: number;
  cachePath?: string;
}

/**
 * Resolve the ambiguous-width setting per the precedence order in this file's header.
 *
 * Async because rules 2 and 3 touch the filesystem and the terminal. Every failure
 * along the way degrades to the next rule and ultimately to narrow; nothing here
 * throws, for the same reason `resolveGlyphs` never throws on a bad `MDVIEW_GLYPHS`:
 * a viewer that refuses to show a document because a diagnostic went wrong has
 * mistaken its own plumbing for the user's request.
 */
export async function resolveAmbiguousWidth(options: ResolveAmbiguousOptions = {}): Promise<AmbiguousResolution> {
  const env = options.env ?? process.env;
  const identity = terminalIdentity(env);
  const cachePath = options.cachePath ?? resolveAmbiguousCachePath(env);
  const base = { identity, cachePath };

  const fromEnv = parseAmbiguousWidth(env.MDVIEW_AMBIGUOUS);
  if (fromEnv) {
    return {
      ambiguous: fromEnv,
      measure: measureFor(fromEnv),
      source: "env",
      detail: `MDVIEW_AMBIGUOUS=${fromEnv} in the environment overrides everything else`,
      ...base,
    };
  }

  if (!options.refresh) {
    const cached = await readCachedAmbiguousWidth(identity, cachePath);
    if (cached) {
      return {
        ambiguous: cached.ambiguous,
        measure: measureFor(cached.ambiguous),
        source: "cache",
        detail: `cached answer for this terminal identity, probed ${cached.probedAt}`,
        ...base,
      };
    }
  }

  if (options.allowProbe) {
    const probe = await probeAmbiguousWidth(options.stdin, options.stdout, options.timeoutMs);
    if (probe.ambiguous) {
      if (!options.noCache) await writeCachedAmbiguousWidth(identity, probe.ambiguous, cachePath);
      return {
        ambiguous: probe.ambiguous,
        measure: measureFor(probe.ambiguous),
        source: "probe",
        detail: probe.detail,
        probe,
        ...base,
      };
    }
    return {
      ambiguous: "narrow",
      measure: NARROW_MEASURE,
      source: "default",
      detail: `${probe.detail}; falling back to narrow`,
      probe,
      ...base,
    };
  }

  return {
    ambiguous: "narrow",
    measure: NARROW_MEASURE,
    source: "default",
    detail:
      "no override, no cached answer, and no live probe (a probe needs both stdin and stdout to be TTYs, and never runs under --check or the sweep) — narrow is what Unicode TR11 recommends when the context cannot be established",
    ...base,
  };
}
