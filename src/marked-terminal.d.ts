// `marked-terminal` ships no TypeScript types (last published 2025-01-28). This is a
// minimal ambient shim covering only the surface this tool actually uses: constructing
// the renderer extension via `markedTerminal(options)` and registering it with
// `marked.use()`. Widen only if a new option is actually read.
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface TerminalRendererOptions {
    width?: number;
    reflowText?: boolean;
    tab?: number;
    showSectionPrefix?: boolean;
    unescape?: boolean;
    emoji?: boolean;
    tableOptions?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export type TerminalHighlightOptions = Record<string, unknown>;

  export default class TerminalRenderer {
    constructor(options?: TerminalRendererOptions, highlightOptions?: TerminalHighlightOptions);
  }

  export function markedTerminal(
    options?: TerminalRendererOptions,
    highlightOptions?: TerminalHighlightOptions,
  ): MarkedExtension;
}
