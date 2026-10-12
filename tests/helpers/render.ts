/**
 * tests/helpers/render.ts — one render through the built Rust renderer, synchronously.
 *
 * WP-9 of `plans/mdview-rust-port.md` deleted the TypeScript renderer (`TS_BASELINE` = `c097c66`);
 * the instruments' tests that used to call `renderDocumentDetailed` in-process now send one
 * `mdview __parity serve` request to the binary `bun run build:rust` writes (or `MDVIEW_BIN`).
 * `scripts/verify.ts` runs `bun test` after that build for exactly this reason.
 */
import { resolve } from "node:path";
import { mdviewBinary, POLICIES, type PolicyName, type RenderOutput, type WireRequest } from "../../scripts/revision";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export interface RenderSyncOptions {
  tier?: "unicode" | "ascii";
  ambiguous?: "narrow" | "wide";
  /** A named policy, or `"env"` (resolved by the server from `env`). Default `P0`. */
  policy?: PolicyName | "env";
  emoji?: boolean | null;
  /** The server's environment, for `policy: "env"`. Default: this process's. */
  env?: Record<string, string | undefined>;
}

export function renderSync(source: string, width: number, options: RenderSyncOptions = {}): RenderOutput {
  const policy = options.policy ?? "P0";
  const request: WireRequest = {
    source,
    width,
    tier: options.tier ?? "unicode",
    ambiguous: options.ambiguous ?? "narrow",
    policy: policy === "env" ? "env" : { ...POLICIES[policy] },
    emoji: options.emoji ?? null,
  };
  const proc = Bun.spawnSync([mdviewBinary(REPO_ROOT), "__parity", "serve"], {
    stdin: new TextEncoder().encode(`${JSON.stringify(request)}\n`),
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ?? process.env,
  });
  const response = JSON.parse(proc.stdout.toString()) as Partial<RenderOutput> & { error?: string };
  if (proc.exitCode !== 0 || typeof response.text !== "string" || !Array.isArray(response.codeRanges)) {
    throw new Error(`mdview __parity serve: ${response.error ?? proc.stderr.toString().trim()}`);
  }
  return { text: response.text, codeRanges: response.codeRanges };
}
