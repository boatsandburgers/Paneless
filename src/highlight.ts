import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
for (const [name, fn] of Object.entries({
  javascript,
  typescript,
  rust,
  python,
  bash,
  json,
  css,
  xml,
  sql,
}))
  hljs.registerLanguage(name, fn);
export function highlight(code: HTMLElement) {
  const language = [...code.classList]
    .find((c) => c.startsWith("language-"))
    ?.slice(9);
  if (
    language &&
    hljs.getLanguage(language) &&
    (code.textContent?.length ?? 0) < 24000
  )
    hljs.highlightElement(code);
}
