import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import stringWidth from "string-width";
import { renderDocumentDetailed } from "./render";
import { resolveGlyphs, type GlyphTier } from "./glyphs";

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

export async function main(args = Bun.argv.slice(2)): Promise<void> {
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

if (import.meta.main) {
  await main();
}
