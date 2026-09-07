import { mkdir, writeFile } from "node:fs/promises";
await mkdir("benchmarks/generated", { recursive: true });
const paragraph =
  "Readable **Markdown** should be fast, even when a document grows. A little *emphasis*, some `inline_code(value)`, and [a useful reference](https://example.com/reference) make this a realistic paragraph. Long documents should preserve selection, anchors, and smooth scrolling.\n\n";
function section(n) {
  return `## Section ${n}: a considered approach to reading\n\n${paragraph.repeat(3)}### Details ${n}\n\n- First item with **strong text**\n  - A nested item\n    - A deeper item with \`code\`\n- [x] Completed task\n- [ ] Something for later\n\n> A useful quotation with a [reference](https://example.com).\n>\n> A second paragraph inside the quotation.\n\n| Feature | Value | Notes |\n| :--- | ---: | :--- |\n${Array.from({ length: 36 }, (_, r) => `| Table row ${r} | ${r * n} | **Formatted** data and \`values\` |`).join("\n")}\n\n\`\`\`typescript\ninterface Document { title: string; ready: boolean; }\nconst read = (doc: Document) => ({ ...doc, ready: true });\n// Highlight only after the words are visible.\n\`\`\`\n\n---\n\n`;
}
for (const [name, size] of [
  ["100kb", 100 * 1024],
  ["1mb", 1024 ** 2],
  ["5mb", 5 * 1024 ** 2],
  ["20mb", 20 * 1024 ** 2],
]) {
  const parts = ["# A representative Markdown document\n\n"];
  let bytes = parts[0].length;
  let n = 0;
  while (bytes < size) {
    const next = section(++n);
    parts.push(next);
    bytes += Buffer.byteLength(next);
  }
  await writeFile(`benchmarks/generated/${name}.md`, parts.join(""));
  console.log(`${name}: ${bytes.toLocaleString()} bytes, ${n} sections`);
}
