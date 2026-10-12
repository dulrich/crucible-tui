/**
 * tests/helpers/osc8.ts — OSC-8 hyperlink bytes, for scanner fixtures.
 *
 * The emitter itself is the Rust crate's (`crates/mdview/src/ansi.rs`, `link`, with its own
 * tests); the TypeScript `link` in `TS_BASELINE` `src/ansi.ts` was deleted with the renderer at WP-9 of
 * `plans/mdview-rust-port.md` (`TS_BASELINE` = `c097c66`). The instruments only *scan*
 * sequences, so their tests need the bytes, not an emitter: this is that shape, transcribed
 * (`ESC ] 8 ; ; url BEL label ESC ] 8 ; ; BEL`, and under tmux each half wrapped in
 * `ESC P tmux ; … ESC \` with every inner ESC doubled). It does not sanitize the URL.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function wrap(sequence: string, tmux: boolean): string {
  return tmux ? `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\` : sequence;
}

export function osc8Link(label: string, url: string, tmux = false): string {
  return wrap(`${ESC}]8;;${url}${BEL}`, tmux) + label + wrap(`${ESC}]8;;${BEL}`, tmux);
}
