import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import stringWidth from "string-width";
import { renderDocumentDetailed } from "./render";
import { resolveGlyphs, type GlyphTier } from "./glyphs";
import { loadConfig, writeHighlightAlias } from "./config";
import { isSupportedLanguage, setHighlightAliases } from "./lang";

/**
 * `mdview`'s command-line surface (WP-4).
 *
 * The one non-negotiable shape: `mdview <file.md>` must keep working with no
 * subcommand — that invocation predates subcommands and is the one the user
 * runs daily. Subcommands (`highlight-as`, `help`, and the `view` alias for
 * the default itself) sit *alongside* it, not in front of it: `main` only
 * dispatches to a named subcommand handler when the first argument is
 * exactly one of those names; anything else — including every existing flag,
 * which all start with `-` — falls through to the same view path a bare file
 * argument always used. `--probe` (WP-3) is expected to slot in here as a
 * fourth subcommand name; nothing about this dispatch needs to change to add
 * it.
 */
const USAGE = `usage: mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--help]

  <file.md>       markdown file to render (required)
  --width N       target render width (default: terminal columns, else 100)
  --no-pager      write plain output to stdout instead of piping to a pager
  --check         render with no pager; exit non-zero if any line exceeds the
                  target width (this tool's self-smoke gate)
  --ascii         force the ASCII glyph tier (bullets, rules, table borders,
                  task states) regardless of detected terminal capability
  --unicode       force the Unicode glyph tier; mutually exclusive with --ascii
  --help, -h      print this message and exit

Glyph tier resolution (highest precedence first): --ascii/--unicode, then
MDVIEW_GLYPHS=ascii|unicode in the environment, then auto-detection from the
locale and TERM.

Subcommands (a bare <file.md> above is still valid on its own — no subcommand
is required to view a file):
  highlight-as <fence> <language>   map a fence language to a highlighter
                                     language and save it to the config file
  view <file.md> [options]          same as the bare form above, spelled out
  help [subcommand]                 print this message, or a subcommand's own

Run \`mdview <subcommand> --help\` or \`mdview help <subcommand>\` for a
subcommand's own usage.
`;

const HIGHLIGHT_AS_USAGE = `usage: mdview highlight-as <fence> <language>

  <fence>       fence info-string language to alias (e.g. dataviewjs)
  <language>    highlighter language to render it as — validated against
                cli-highlight's supported list before anything is written
  --help, -h    print this message and exit

Records "<fence> -> <language>" into the user config (the XDG config path;
see \`mdview help\` for its precedence), layered over the built-in aliases
(dataviewjs -> javascript, dataview -> sql). A user entry for a fence that
also has a built-in default wins. The write only ever touches this one entry:
every other config key, and every other highlight-as mapping, is left as-is.
`;

export interface CliOptions {
  file: string;
  width?: number;
  noPager: boolean;
  check: boolean;
  help: boolean;
  glyphTier?: GlyphTier;
}

/**
 * Resolve the target render width.
 * Precedence: explicit --width, then the terminal's reported column count,
 * then a fixed fallback so headless/redirected runs stay deterministic.
 */
export function resolveWidth(explicit: number | undefined, columns: number | undefined): number {
  if (explicit !== undefined) return explicit;
  if (columns !== undefined && columns > 0) return columns;
  return 100;
}

export function parseArgs(args: string[]): CliOptions {
  let file: string | undefined;
  let width: number | undefined;
  let noPager = false;
  let check = false;
  let help = false;
  let glyphTier: GlyphTier | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--no-pager") {
      noPager = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--ascii" || arg === "--unicode") {
      const requested: GlyphTier = arg === "--ascii" ? "ascii" : "unicode";
      if (glyphTier !== undefined && glyphTier !== requested) {
        throw new Error("--ascii and --unicode are mutually exclusive");
      }
      glyphTier = requested;
      continue;
    }
    if (arg === "--width") {
      const value = args[index + 1];
      if (!value) throw new Error("missing value for --width");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--width must be a positive number, got: ${value}`);
      }
      width = parsed;
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (file !== undefined) {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
    file = arg;
  }

  if (!help && !file) {
    throw new Error("missing required argument: <file.md>");
  }

  return { file: file ?? "", width, noPager, check, help, glyphTier };
}

async function runPager(output: string): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let child;
    try {
      child = spawn("less", ["-R"], { stdio: ["pipe", "inherit", "inherit"] });
    } catch {
      process.stdout.write(output);
      resolvePromise();
      return;
    }

    child.on("error", () => {
      // `less` missing or unusable — fall back to plain stdout.
      process.stdout.write(output);
      resolvePromise();
    });
    child.on("exit", () => {
      resolvePromise();
    });
    child.stdin?.write(output);
    child.stdin?.end();
  }).catch(() => {
    // Swallow: fallback already wrote plain output above.
  });
}

/**
 * `codeRanges` are the 1-based, inclusive line ranges `render.ts` recorded for fenced
 * code blocks — exempt by the user's explicit "never rewrite code" decision (see
 * `src/render.ts`'s `wrapCode`). Everything else must fit `targetWidth`.
 */
function isExemptLine(lineNumber: number, codeRanges: Array<[number, number]>): boolean {
  return codeRanges.some(([start, end]) => lineNumber >= start && lineNumber <= end);
}

function checkOverflow(
  output: string,
  targetWidth: number,
  codeRanges: Array<[number, number]>,
): { line: number; width: number } | null {
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (isExemptLine(lineNumber, codeRanges)) continue;
    const width = stringWidth(lines[index] ?? "");
    if (width > targetWidth) {
      return { line: lineNumber, width };
    }
  }
  return null;
}

/**
 * The default (and implicit) subcommand: render a file. Unchanged from the
 * tool's pre-subcommand behavior, plus one addition — loading the user's
 * `highlightAs` config and installing it (`src/lang.ts`'s `setHighlightAliases`)
 * before the render call, so a `highlight-as` write actually takes effect on
 * the next view.
 */
async function runView(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  let source: string;
  try {
    source = await readFile(options.file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read file: ${options.file} (${reason})`);
  }

  const config = await loadConfig();
  setHighlightAliases(config.highlightAs);

  const targetWidth = resolveWidth(options.width, process.stdout.columns);
  const glyphs = resolveGlyphs(process.env, options.glyphTier);
  const { text: output, codeRanges } = renderDocumentDetailed(source, targetWidth, glyphs);

  if (options.check) {
    const overflow = checkOverflow(output, targetWidth, codeRanges);
    if (overflow) {
      throw new Error(
        `line ${overflow.line} exceeds target width ${targetWidth} (measured ${overflow.width})`,
      );
    }
    process.stdout.write(output);
    return;
  }

  const usePager = process.stdout.isTTY && !options.noPager;
  if (usePager) {
    await runPager(output);
    return;
  }

  process.stdout.write(output);
}

/** `mdview highlight-as <fence> <language>` — validates, then writes back to the config. */
async function runHighlightAs(args: string[]): Promise<void> {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(HIGHLIGHT_AS_USAGE);
    return;
  }

  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.length > 0) {
    throw new Error(`highlight-as: unknown argument: ${flags[0]} (run \`mdview highlight-as --help\`)`);
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length !== 2) {
    throw new Error(
      `highlight-as: expected exactly 2 arguments <fence> <language>, got ${positional.length} ` +
        "(run `mdview highlight-as --help`)",
    );
  }

  const [fence, language] = positional as [string, string];
  if (!isSupportedLanguage(language)) {
    throw new Error(
      `highlight-as: unsupported language "${language}" — cli-highlight does not recognize it, so ` +
        "the fence would render unhighlighted rather than mysteriously plain later. Common valid " +
        'targets: javascript, typescript, python, bash, sql, json, yaml, plaintext ("plaintext" is ' +
        "always accepted, if the fence should just not be highlighted).",
    );
  }

  const result = await writeHighlightAlias(fence, language);
  const normalizedFence = fence.trim().toLowerCase();
  const normalizedLanguage = language.trim().toLowerCase();
  process.stdout.write(
    `mdview: ${result.created ? "created" : "updated"} config at ${result.path} — ` +
      `"${normalizedFence}" now highlights as "${normalizedLanguage}"\n`,
  );
}

/** `mdview help [subcommand]` — prints top-level help, or one subcommand's own. */
async function runHelp(args: string[]): Promise<void> {
  const [name] = args;
  if (name === undefined || name === "view" || name === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (name === "highlight-as") {
    process.stdout.write(HIGHLIGHT_AS_USAGE);
    return;
  }
  throw new Error(`help: unknown subcommand: ${name} (expected one of: view, highlight-as, help)`);
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const [first, ...rest] = args;

  if (first === "highlight-as") return runHighlightAs(rest);
  if (first === "help") return runHelp(rest);
  if (first === "view") return runView(rest);

  // No recognized subcommand name in the lead position — including every
  // existing flag, which all start with "-" and therefore never match one of
  // the three names above. This is the compatibility path: a bare
  // `mdview FILE.md` (with flags in any position) behaves exactly as it did
  // before subcommands existed.
  return runView(args);
}

// Errors reach the user as one line naming the problem, never as a stack trace.
// `main` itself still throws — tests call it directly and assert on the thrown
// message, and that contract is what keeps the suite subprocess-free — so the
// catch lives here, at the process boundary, and nowhere else. Without it Bun
// prints a source excerpt, a stack, and its own version banner around every
// message this file carefully worded, and leaks the absolute install path while
// doing it.
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mdview: ${message}\n`);
    process.exit(1);
  }
}
