// `supports-color@7.2.0` ships no TypeScript types (the DefinitelyTyped package targets a
// later major and would describe an API this version does not have). This is a minimal
// ambient shim covering only the surface `detectInlineColor` reads: the module's default
// export and its `stdout` field, which is `false` when the stream supports no colour at
// all and a level descriptor otherwise. Widen only if a new field is actually read.
//
// It replaces `src/marked-terminal.d.ts` (deleted in WP-6 of
// `plans/marked-terminal-replacement.md`) in role but not in shape: that shim needed a
// documented double cast because the library's factory returns a `marked` extension whose
// renderer had to be re-typed at the call site. Nothing here is cast — the value is read,
// not adapted.
declare module "supports-color" {
  export interface ColorSupportLevel {
    level: 0 | 1 | 2 | 3;
    hasBasic: boolean;
    has256: boolean;
    has16m: boolean;
  }

  export interface SupportsColor {
    stdout: false | ColorSupportLevel;
    stderr: false | ColorSupportLevel;
  }

  const supportsColor: SupportsColor;
  export default supportsColor;
}
