/**
 * The frozen `marked-terminal` inline byte table — WP-6 of
 * `plans/marked-terminal-replacement.md`.
 *
 * Every value here is what `marked-terminal@7.3.0`'s corresponding renderer method
 * returned for the case of that name in `./inline-parity.ts`, captured from the installed
 * library on the commit **before** the dependency was removed, at both colour settings:
 * `colorOff` from an ordinary non-TTY process (`chalk` level 0), `colorOn` from a fresh
 * subprocess under `FORCE_COLOR=3`.
 *
 * **Why a table and not a call.** Until WP-6 this comparison ran the library live, which
 * made it a true differential and made "byte-identical" provable rather than asserted.
 * WP-6 removes the library, so the live call is no longer available to anyone — including
 * a future reader who wants to re-derive these bytes. Deleting the comparison was the
 * other option and was rejected: it is WP-2's and WP-3's entire class-A evidence, and this
 * repo's test count goes up, never down. Freezing keeps every case and every assertion;
 * what it gives up is the ability to notice that a *newer* `marked-terminal` would have
 * rendered something else, which is a question this repo no longer asks.
 *
 * **Do not regenerate these by rendering with the owned visitors.** That would make the
 * test compare the code against itself and pass unconditionally. They are a record of what
 * a package that is gone used to emit; the only legitimate way to change one is to
 * re-install `marked-terminal@7.3.0` and re-capture (the generator is described in this
 * WP's report), and the only legitimate reason to is a deliberate, parity-classed decision
 * to let the owned output move.
 */
export const INLINE_PARITY_GOLDEN: Record<"colorOff" | "colorOn", Record<"emojiOn" | "emojiOff", Record<string, string>>> = {
  "colorOff": {
    "emojiOn": {
      "strong/plain": "bold words",
      "strong/nested style": "has \u001b[33mcode\u001b[39m inside",
      "strong/own close code present": "a\u001b[22mb",
      "strong/newline": "first\nsecond",
      "strong/carriage return then newline": "first\r\nsecond",
      "strong/empty": "",
      "em/plain": "emphasised",
      "em/hard return": "before/\\n/gafter",
      "em/two hard returns": "a/\\n/gb\rc",
      "em/nested style": "has \u001b[33mcode\u001b[39m inside",
      "codespan/plain": "value",
      "codespan/colons": "a*#COLON|*b*#COLON|*c",
      "codespan/shortcode": "*#COLON|*rocket*#COLON|*",
      "codespan/hard return": "before/\\n/gafter",
      "codespan/empty": "",
      "del/plain": "struck out",
      "del/nested style": "struck \u001b[33mcode\u001b[39m out",
      "del/newline": "first\nsecond",
      "link/labelled": "the label (https://example.com/page)",
      "link/bare": "https://example.com/page",
      "link/no text": "https://example.com/page",
      "link/plus in url": "spaces (https://example.com/a+b+c)",
      "link/shortcode in label": "ship it 🚀  (https://example.com/page)",
      "link/styled label": "a \u001b[33mb\u001b[39m c (https://example.com/page)",
      "image/no title": "![alt text](https://example.com/i.png)\n",
      "image/with title": "![alt text – The Title](https://example.com/i.png)\n",
      "image/empty alt": "![](https://example.com/i.png)\n",
      "br": "\r",
      "text/plain": "some text",
      "text/with colons": "a:b",
      "text/with shortcode": "ship :rocket: it"
    },
    "emojiOff": {
      "strong/plain": "bold words",
      "strong/nested style": "has \u001b[33mcode\u001b[39m inside",
      "strong/own close code present": "a\u001b[22mb",
      "strong/newline": "first\nsecond",
      "strong/carriage return then newline": "first\r\nsecond",
      "strong/empty": "",
      "em/plain": "emphasised",
      "em/hard return": "before/\\n/gafter",
      "em/two hard returns": "a/\\n/gb\rc",
      "em/nested style": "has \u001b[33mcode\u001b[39m inside",
      "codespan/plain": "value",
      "codespan/colons": "a*#COLON|*b*#COLON|*c",
      "codespan/shortcode": "*#COLON|*rocket*#COLON|*",
      "codespan/hard return": "before/\\n/gafter",
      "codespan/empty": "",
      "del/plain": "struck out",
      "del/nested style": "struck \u001b[33mcode\u001b[39m out",
      "del/newline": "first\nsecond",
      "link/labelled": "the label (https://example.com/page)",
      "link/bare": "https://example.com/page",
      "link/no text": "https://example.com/page",
      "link/plus in url": "spaces (https://example.com/a+b+c)",
      "link/shortcode in label": "ship it :rocket: (https://example.com/page)",
      "link/styled label": "a \u001b[33mb\u001b[39m c (https://example.com/page)",
      "image/no title": "![alt text](https://example.com/i.png)\n",
      "image/with title": "![alt text – The Title](https://example.com/i.png)\n",
      "image/empty alt": "![](https://example.com/i.png)\n",
      "br": "\r",
      "text/plain": "some text",
      "text/with colons": "a:b",
      "text/with shortcode": "ship :rocket: it"
    }
  },
  "colorOn": {
    "emojiOn": {
      "strong/plain": "\u001b[1mbold words\u001b[22m",
      "strong/nested style": "\u001b[1mhas \u001b[33mcode\u001b[39m inside\u001b[22m",
      "strong/own close code present": "\u001b[1ma\u001b[22m\u001b[1mb\u001b[22m",
      "strong/newline": "\u001b[1mfirst\u001b[22m\n\u001b[1msecond\u001b[22m",
      "strong/carriage return then newline": "\u001b[1mfirst\u001b[22m\r\n\u001b[1msecond\u001b[22m",
      "strong/empty": "",
      "em/plain": "\u001b[3memphasised\u001b[23m",
      "em/hard return": "\u001b[3mbefore/\\n/gafter\u001b[23m",
      "em/two hard returns": "\u001b[3ma/\\n/gb\rc\u001b[23m",
      "em/nested style": "\u001b[3mhas \u001b[33mcode\u001b[39m inside\u001b[23m",
      "codespan/plain": "\u001b[33mvalue\u001b[39m",
      "codespan/colons": "\u001b[33ma*#COLON|*b*#COLON|*c\u001b[39m",
      "codespan/shortcode": "\u001b[33m*#COLON|*rocket*#COLON|*\u001b[39m",
      "codespan/hard return": "\u001b[33mbefore/\\n/gafter\u001b[39m",
      "codespan/empty": "",
      "del/plain": "\u001b[2m\u001b[90m\u001b[9mstruck out\u001b[29m\u001b[39m\u001b[22m",
      "del/nested style": "\u001b[2m\u001b[90m\u001b[9mstruck \u001b[33mcode\u001b[39m\u001b[90m out\u001b[29m\u001b[39m\u001b[22m",
      "del/newline": "\u001b[2m\u001b[90m\u001b[9mfirst\u001b[29m\u001b[39m\u001b[22m\n\u001b[2m\u001b[90m\u001b[9msecond\u001b[29m\u001b[39m\u001b[22m",
      "link/labelled": "\u001b[34mthe label (\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "link/bare": "\u001b[34m\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m\u001b[39m",
      "link/no text": "\u001b[34m\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m\u001b[39m",
      "link/plus in url": "\u001b[34mspaces (\u001b[34m\u001b[4mhttps://example.com/a+b+c\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "link/shortcode in label": "\u001b[34mship it 🚀  (\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "link/styled label": "\u001b[34ma \u001b[33mb\u001b[39m\u001b[34m c (\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "image/no title": "![alt text](https://example.com/i.png)\n",
      "image/with title": "![alt text – The Title](https://example.com/i.png)\n",
      "image/empty alt": "![](https://example.com/i.png)\n",
      "br": "\r",
      "text/plain": "some text",
      "text/with colons": "a:b",
      "text/with shortcode": "ship :rocket: it"
    },
    "emojiOff": {
      "strong/plain": "\u001b[1mbold words\u001b[22m",
      "strong/nested style": "\u001b[1mhas \u001b[33mcode\u001b[39m inside\u001b[22m",
      "strong/own close code present": "\u001b[1ma\u001b[22m\u001b[1mb\u001b[22m",
      "strong/newline": "\u001b[1mfirst\u001b[22m\n\u001b[1msecond\u001b[22m",
      "strong/carriage return then newline": "\u001b[1mfirst\u001b[22m\r\n\u001b[1msecond\u001b[22m",
      "strong/empty": "",
      "em/plain": "\u001b[3memphasised\u001b[23m",
      "em/hard return": "\u001b[3mbefore/\\n/gafter\u001b[23m",
      "em/two hard returns": "\u001b[3ma/\\n/gb\rc\u001b[23m",
      "em/nested style": "\u001b[3mhas \u001b[33mcode\u001b[39m inside\u001b[23m",
      "codespan/plain": "\u001b[33mvalue\u001b[39m",
      "codespan/colons": "\u001b[33ma*#COLON|*b*#COLON|*c\u001b[39m",
      "codespan/shortcode": "\u001b[33m*#COLON|*rocket*#COLON|*\u001b[39m",
      "codespan/hard return": "\u001b[33mbefore/\\n/gafter\u001b[39m",
      "codespan/empty": "",
      "del/plain": "\u001b[2m\u001b[90m\u001b[9mstruck out\u001b[29m\u001b[39m\u001b[22m",
      "del/nested style": "\u001b[2m\u001b[90m\u001b[9mstruck \u001b[33mcode\u001b[39m\u001b[90m out\u001b[29m\u001b[39m\u001b[22m",
      "del/newline": "\u001b[2m\u001b[90m\u001b[9mfirst\u001b[29m\u001b[39m\u001b[22m\n\u001b[2m\u001b[90m\u001b[9msecond\u001b[29m\u001b[39m\u001b[22m",
      "link/labelled": "\u001b[34mthe label (\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "link/bare": "\u001b[34m\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m\u001b[39m",
      "link/no text": "\u001b[34m\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m\u001b[39m",
      "link/plus in url": "\u001b[34mspaces (\u001b[34m\u001b[4mhttps://example.com/a+b+c\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "link/shortcode in label": "\u001b[34mship it :rocket: (\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "link/styled label": "\u001b[34ma \u001b[33mb\u001b[39m\u001b[34m c (\u001b[34m\u001b[4mhttps://example.com/page\u001b[24m\u001b[39m\u001b[34m)\u001b[39m",
      "image/no title": "![alt text](https://example.com/i.png)\n",
      "image/with title": "![alt text – The Title](https://example.com/i.png)\n",
      "image/empty alt": "![](https://example.com/i.png)\n",
      "br": "\r",
      "text/plain": "some text",
      "text/with colons": "a:b",
      "text/with shortcode": "ship :rocket: it"
    }
  }
};
