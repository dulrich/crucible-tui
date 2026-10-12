/**
 * The TypeScript renderer behind the parity JSONL protocol — WP-1 of
 * `plans/mdview-rust-port.md`, the `ts-server:` revision kind's subprocess.
 *
 * `bun run scripts/parity-ts-server.ts <materialized root>` serves the same protocol
 * `mdview __parity serve` does (`crates/mdview/src/parity.rs`): one JSON request per stdin
 * line, one JSON response per stdout line, in order — `{text, codeRanges}` or `{error}`. It
 * renders through `./revision`'s `loadTsRenderer`, the very loader the in-process `ts` kind
 * uses, so `render-diff --rev-b ts-server:<x>` against `--rev-a <x>` measures the transport and
 * nothing else. `tokens` is ignored (the TS renderer lexes for itself); under hyperlinks the
 * wiki-link resolver is built from the request's `path`, read-only.
 *
 * **stdout carries response lines and nothing else**, and nothing is written to stderr on a
 * per-request failure — the client treats stderr as fatal, so a failure is always an
 * `{error}` line it can attribute to one request.
 */
import { loadTsRenderer, streamChunks, type WireRequest } from "./revision";

async function serve(root: string): Promise<void> {
  const render = await loadTsRenderer(root);
  const decoder = new TextDecoder();
  let buffer = "";
  const answer = (line: string): string => {
    try {
      const request = JSON.parse(line) as WireRequest;
      if (typeof request.source !== "string") throw new Error("bad source");
      if (typeof request.width !== "number") throw new Error("bad width");
      if (request.policy === null || typeof request.policy !== "object") throw new Error("request is missing \"policy\"");
      const { text, codeRanges } = render(request);
      return JSON.stringify({ text, codeRanges });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  for await (const chunk of streamChunks(Bun.stdin.stream())) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    const out: string[] = [];
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      out.push(`${answer(line)}\n`);
    }
    if (out.length > 0) await Bun.write(Bun.stdout, out.join(""));
  }
  if (buffer.trim() !== "") await Bun.write(Bun.stdout, `${answer(buffer)}\n`);
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) {
    process.stdout.write(`${JSON.stringify({ error: "usage: parity-ts-server.ts <root>" })}\n`);
    process.exit(2);
  }
  await serve(root);
}
