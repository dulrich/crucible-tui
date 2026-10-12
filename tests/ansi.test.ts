import { describe, expect, test } from "bun:test";
import { hasSequences, scan, stripSequences, type SpanKind } from "../scripts/measure/ansi";
import { NARROW_MEASURE, WIDE_MEASURE } from "../scripts/measure/width";
import { osc8Link as link } from "./helpers/osc8";

// Control bytes are built, never pasted — the same convention `TS_BASELINE` `src/ansi.ts` itself
// follows, and for the same reason: a literal ESC in a source file is invisible in every
// editor and every diff.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ST = String.fromCharCode(0x9c);
const SENTINEL = String.fromCharCode(0);
const TASK_STATE_SENTINEL = String.fromCharCode(1);

const kinds = (text: string): SpanKind[] => scan(text).spans.map((span) => span.kind);
const raws = (text: string): string => scan(text).spans.map((span) => span.raw).join("");

describe("scan — the sequence grammar", () => {
  test("plain text is one text span, measured", () => {
    const result = scan("hello");
    expect(result.spans).toEqual([{ kind: "text", raw: "hello", width: 5 }]);
    expect(result.visible).toBe("hello");
    expect(result.malformed).toBe(false);
  });

  test("an SGR pair brackets its text and carries zero width", () => {
    const result = scan(`${ESC}[36m${ESC}[4mlabel${ESC}[24m${ESC}[39m`);
    expect(kinds(`${ESC}[36m${ESC}[4mlabel${ESC}[24m${ESC}[39m`)).toEqual([
      "sgr",
      "sgr",
      "text",
      "sgr",
      "sgr",
    ]);
    expect(result.spans.filter((s) => s.kind !== "text").every((s) => s.width === 0)).toBe(true);
    expect(result.visible).toBe("label");
  });

  test("a bare reset and a multi-parameter SGR are both SGR", () => {
    expect(kinds(`${ESC}[0mx`)).toEqual(["sgr", "text"]);
    expect(kinds(`${ESC}[1;31;4mx`)).toEqual(["sgr", "text"]);
    expect(kinds(`${ESC}[mx`)).toEqual(["sgr", "text"]);
  });

  test("BEL- and ST-terminated OSC-8, and the C1 ST spelling", () => {
    expect(kinds(`${ESC}]8;;https://example.invalid${BEL}label${ESC}]8;;${BEL}`)).toEqual([
      "osc8",
      "text",
      "osc8",
    ]);
    expect(kinds(`${ESC}]8;;https://example.invalid${ESC}\\label`)).toEqual(["osc8", "text"]);
    expect(kinds(`${ESC}]8;;https://example.invalid${ST}label`)).toEqual(["osc8", "text"]);
  });

  test("an OSC that is not a hyperlink is reported, not absorbed", () => {
    expect(kinds(`${ESC}]0;window title${BEL}x`)).toEqual(["malformed", "text"]);
  });

  test("the tmux DCS envelope is one span, doubled ESCs and all", () => {
    const wrapped = link("label", "https://example.invalid", true);
    expect(kinds(wrapped)).toEqual(["dcs", "text", "dcs"]);
    expect(scan(wrapped).visible).toBe("label");
    expect(scan(wrapped).malformed).toBe(false);
  });

  test("a non-SGR CSI is malformed: the vocabulary is what this renderer emits", () => {
    expect(kinds(`${ESC}[2Jx`)).toEqual(["malformed", "text"]);
    expect(scan(`${ESC}[2Jx`).malformed).toBe(true);
  });

  test("width is 0 for every non-text span, by construction", () => {
    const wrapped = `${ESC}[1m${link("mdview", "https://example.invalid/very/long/destination", true)}${ESC}[22m`;
    for (const span of scan(wrapped).spans) {
      if (span.kind !== "text") expect(span.width).toBe(0);
    }
    // **The rule's whole reason, measured here rather than asserted.** A six-column label
    // inside a tmux DCS envelope measures **18** columns to `string-width@7.2.0` — it
    // strips SGR and OSC-8 and does not know what a DCS envelope is, so the envelope's
    // own `Ptmux;` text counts as 12 columns of content. (The plan records 27 for its own
    // example at this base; the constant is the 12-column envelope, not the URL, so the
    // figure varies with the label. Either way the answer is not the label's width, which
    // is the only correct one.)
    expect(NARROW_MEASURE(scan(wrapped).visible)).toBe(6);
    expect(NARROW_MEASURE(wrapped)).toBe(18);
  });

  test("text spans are measured with the ruler handed in", () => {
    const dash = "—";
    expect(scan(dash).spans[0]?.width).toBe(1);
    expect(scan(dash, WIDE_MEASURE).spans[0]?.width).toBe(2);
  });
});

describe("scan — malformed input carries its bytes and eats no text", () => {
  test("an unterminated OSC-8 is malformed and keeps the rest of the string", () => {
    const text = `${ESC}]8;;https://example.invalid`;
    expect(kinds(text)).toEqual(["malformed"]);
    expect(raws(text)).toBe(text);
    expect(scan(text).visible).toBe("");
  });

  test("an unterminated CSI is malformed", () => {
    expect(kinds(`${ESC}[31`)).toEqual(["malformed"]);
  });

  test("an unterminated DCS is malformed", () => {
    expect(kinds(`${ESC}Ptmux;${ESC}${ESC}]8;;u`)).toEqual(["malformed"]);
  });

  test("a lone ESC consumes itself only — the byte after it is still visible", () => {
    const result = scan(`a${ESC}b`);
    expect(result.spans.map((s) => s.kind)).toEqual(["text", "malformed", "text"]);
    expect(result.visible).toBe("ab");
    expect(result.malformed).toBe(true);
  });

  test("an ESC inside an OSC body ends the malformed span there, and is re-examined", () => {
    const text = `${ESC}]8;;u${ESC}[31mx`;
    expect(kinds(text)).toEqual(["malformed", "sgr", "text"]);
    expect(raws(text)).toBe(text);
  });
});

describe("scan — concatenation identity", () => {
  // The property the whole representation rests on: a consumer may rebuild a line from a
  // subsequence of spans without inventing or losing a byte.
  const alphabet = [
    "a",
    " ",
    "\n",
    `${ESC}[31m`,
    `${ESC}[0m`,
    `${ESC}]8;;https://example.invalid${BEL}`,
    `${ESC}]8;;${BEL}`,
    link("x", "https://example.invalid", true),
    `${ESC}[2J`,
    `${ESC}`,
    `${ESC}]8;;unterminated`,
    SENTINEL,
    TASK_STATE_SENTINEL,
    "—",
  ];

  test("holds over a generated corpus of 512 mixed strings", () => {
    let seed = 12345;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    for (let i = 0; i < 512; i += 1) {
      let text = "";
      for (let piece = 0; piece < 8; piece += 1) text += alphabet[next(alphabet.length)] as string;
      expect(raws(text)).toBe(text);
      expect(stripSequences(text)).toBe(scan(text).visible);
    }
  });
});

describe("scan — the renderer's own sentinels are text", () => {
  test("code points 0 and 1 pass through untouched, in place", () => {
    const text = `${SENTINEL}fence${SENTINEL} and [${TASK_STATE_SENTINEL}x] done`;
    expect(scan(text).spans).toEqual([{ kind: "text", raw: text, width: NARROW_MEASURE(text) }]);
    expect(stripSequences(text)).toBe(text);
    expect(scan(text).malformed).toBe(false);
  });

  test("a sentinel adjacent to a sequence does not disturb either", () => {
    const text = `${ESC}[31m${SENTINEL}code${SENTINEL}${ESC}[39m`;
    expect(kinds(text)).toEqual(["sgr", "text", "sgr"]);
    expect(scan(text).visible).toBe(`${SENTINEL}code${SENTINEL}`);
  });
});

describe("stripSequences and hasSequences", () => {
  test("text with no ESC is returned unchanged", () => {
    expect(stripSequences("plain")).toBe("plain");
    expect(hasSequences("plain")).toBe(false);
    expect(hasSequences(`x${ESC}[0m`)).toBe(true);
  });

  test("it agrees with scan().visible on every kind", () => {
    const text = `${ESC}[1ma${link("b", "https://example.invalid", true)}c${ESC}[2Jd`;
    expect(stripSequences(text)).toBe("abcd");
    expect(stripSequences(text)).toBe(scan(text).visible);
  });
});
