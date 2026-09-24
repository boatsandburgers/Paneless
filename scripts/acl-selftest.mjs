// Every Tauri plugin command the frontend can invoke must be granted in src-tauri/capabilities/,
// and every granted permission must be one the frontend actually needs. Nothing at build time
// reads that file: tsc, cargo and the unit tests all pass with a wrong list, and the app fails only
// when the feature is used. Two such defects shipped here and were found by hand, not by any
// tool: `dialog:allow-save` missing (Cmd-S on a new file: "Command plugin:dialog|save not allowed
// by ACL"), and a window-close button that did nothing while the list granted
// `dialog:allow-confirm` — confirm() does not invoke a `confirm` command at all, the installed
// package sends `plugin:dialog|message`, and the close path needs `core:window:allow-destroy`.
//
// So neither side of the mapping is typed by hand; both are read from what is installed:
//   - what the frontend CAN invoke: every @tauri-apps import in src/**/*.ts(x), the exported
//     functions and class methods the file calls, followed through the installed dist-js down to
//     the literal `plugin:<plugin>|<command>` strings (confirm() → messageCommand() →
//     plugin:dialog|message; onCloseRequested() → this.destroy() → plugin:window|destroy);
//   - what a permission GRANTS: src-tauri/gen/schemas/acl-manifests.json, which tauri-build
//     regenerates from the resolved Rust crates on every cargo build — so a permission that a crate
//     upgrade turns into an alias, deprecates or drops is seen at the next rebuild, not at runtime.
//
// Reads files only: no app, no dev server, no browser, no network.
//
// WHAT IT DOES NOT SEE — a PASS means "no ungranted command in the shapes below", not a proof:
// a call reached under a different name (`import { readText as paste }`, a destructured rename, the
// function passed as a value, a local re-export), bracket access (`api["readText"]()`), a command
// name built at runtime, a constructor body or a static factory named `new` (`new WebviewWindow(…)`,
// `Image.new()`, `TrayIcon.new()`),
// and any file that is not src/**/*.ts(x). Write plugin calls in the plain direct style and this
// test can see them; get clever and it cannot. Commands issued from Rust are not ACL-gated at all.
//
// Run it with `npm run test:acl`, and ideally from CI: it needs no app, no dev server and no
// network, so it costs a fraction of a second.
// Usage: node scripts/acl-selftest.mjs [capability.json …]   (default: every src-tauri/capabilities/*.json)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => relative(root, p);
const problems = [];
const warnings = [];

// ---- 1. Two same-length views of a JS/TS source ------------------------------------------------
// `masked` blanks comments AND string contents, so braces, parens and names inside them do not
// count; `code` blanks only comments, so the plugin:… literals stay readable at the same offsets.
function views(src) {
  const masked = Array.from(src);
  const code = Array.from(src);
  const n = src.length;
  const blank = (from, to, both) => {
    for (let k = from; k < to; k++) {
      if (src[k] === "\n") continue;
      masked[k] = " ";
      if (both) code[k] = " ";
    }
  };
  let last = ""; // last significant character: tells a regex literal from a division
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end, true);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end, true);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      blank(i + 1, j, false);
      i = j + 1;
      last = c;
      continue;
    }
    if (c === "/" && (last === "" || "(,=:[!&|?{};".includes(last))) {
      let j = i + 1;
      let cls = false;
      while (j < n && (cls || src[j] !== "/") && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      blank(i + 1, j, false);
      i = j + 1;
      last = "/";
      continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return { masked: masked.join(""), code: code.join("") };
}

// Index of the bracket that closes masked[open], or -1.
function matchClose(masked, open) {
  const pair = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (pair[c]) stack.push(pair[c]);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

const KEYWORDS = new Set(
  "if for while switch catch function return typeof await new else do throw async delete void in of instanceof super import export class extends yield constructor".split(
    " ",
  ),
);
const COMMAND = /plugin:[\w-]+\|[\w-]+/g;
const CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[^()<>]*>)?\s*\(/g;
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?<![\w$])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// ---- 2. The installed API: name → the commands its body invokes and the names it calls --------
// One table across every loaded module, keyed by bare name: a name defined twice (Window.listen and
// event.js listen) is followed into both, which is the conservative direction — it can only make a
// command look reachable, never hide one.
const table = new Map(); // name → { commands: Set, callees: Set }
const modules = new Map(); // file → Set of names defined in that file

function resolveSpecifier(spec, from) {
  if (spec.startsWith(".")) return resolve(dirname(from), spec);
  try {
    return fileURLToPath(import.meta.resolve(spec));
  } catch {
    return null;
  }
}

function loadModule(file) {
  if (modules.has(file)) return;
  const names = new Set();
  modules.set(file, names);
  const src = readFileSync(file, "utf8");
  const { masked, code } = views(src);
  for (const m of masked.matchAll(CALL)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    let k = close + 1;
    while (k < masked.length && /\s/.test(masked[k])) k++;
    if (masked[k] !== "{") continue; // a call, not a definition
    const end = matchClose(masked, k);
    if (end < 0) continue;
    const entry = table.get(name) ?? {
      commands: new Set(),
      callees: new Set(),
    };
    table.set(name, entry);
    names.add(name);
    for (const c of code.slice(k, end).match(COMMAND) ?? [])
      entry.commands.add(c);
    for (const call of masked.slice(k, end).matchAll(CALL))
      if (!KEYWORDS.has(call[1])) entry.callees.add(call[1]);
  }
  for (const m of code.matchAll(IMPORT)) {
    const target = resolveSpecifier(m[1] ?? m[2], file);
    if (
      target &&
      target.includes("/node_modules/@tauri-apps/") &&
      existsSync(target)
    )
      loadModule(target);
  }
}

// Depth-first from a name to every plugin:… string it can reach; `trail` is kept so a failure
// can print WHY a command is reachable (confirm() → messageCommand() → plugin:dialog|message).
function reach(name, trail, seen, out) {
  const entry = table.get(name);
  if (!entry || seen.has(name)) return;
  seen.add(name);
  const path = [...trail, `${name}()`];
  for (const c of entry.commands) if (!out.has(c)) out.set(c, path.join(" → "));
  for (const n of entry.callees) reach(n, path, seen, out);
}

// ---- 3. What the frontend can invoke -----------------------------------------------------------
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const invocable = new Map(); // command → "src/file.tsx: name() → … "
const files = sources(join(root, "src"));
for (const file of files) {
  const { masked, code } = views(readFileSync(file, "utf8"));
  for (const c of code.match(COMMAND) ?? [])
    invocable.set(c, `${rel(file)}: literal`);
  // Which names of each imported module this file binds: destructured (`const { listen } = await
  // import(spec)`, `.then(({ getCurrentWindow }) =>`, `import { x } from spec`) or reached as a
  // member (`.confirm(`, `.setTitle(`). A bare `name(` counts only for a bound name, so a local
  // function that happens to share a plugin's export name (main.tsx's own openPath vs the opener's)
  // is not mistaken for it. A member call on some OTHER object with the same name (window.open,
  // window.confirm) still counts — that errs towards "needs a permission", never towards hiding one.
  for (const m of code.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2];
    if (!spec.startsWith("@tauri-apps/")) continue;
    const target = resolveSpecifier(spec, file);
    if (!target || !existsSync(target)) {
      problems.push(`${rel(file)} imports ${spec}, which is not installed`);
      continue;
    }
    loadModule(target);
    const quoted = `['"]${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}['"]`;
    const bound = new Set();
    for (const braces of [
      new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${quoted}`, "g"),
      new RegExp(
        `\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*${quoted}\\s*\\)`,
        "g",
      ),
      new RegExp(
        `import\\s*\\(\\s*${quoted}\\s*\\)\\s*\\)?\\s*\\.then\\s*\\(\\s*\\(?\\s*\\{([^}]*)\\}`,
        "g",
      ),
    ])
      for (const b of code.matchAll(braces))
        for (const part of b[1].split(","))
          if (part.trim()) bound.add(part.trim().split(/\s+as\s+|\s*:\s*/)[0]);
    for (const name of modules.get(target)) {
      const generic = "\\s*(?:<[^()<>]*>)?\\s*\\(";
      const member = new RegExp(`\\.\\s*${name}${generic}`);
      const bare = new RegExp(`(?<![\\w$.])${name}${generic}`);
      if (!member.test(masked) && !(bound.has(name) && bare.test(masked)))
        continue;
      const found = new Map();
      reach(name, [], new Set(), found);
      for (const [c, via] of found)
        if (!invocable.has(c)) invocable.set(c, `${rel(file)}: ${via}`);
    }
  }
}
// The gate runs every committed test in the repo, including from checkouts where this app's dev
// dependencies were never installed. Not being able to look is not the same as finding a problem:
// skip, rather than block a push that has nothing to do with Paneless. The question must be asked
// of the DISK — "are the packages here?" — and never of the parser's output: keying the skip on an
// empty table would let a parser that stops understanding the installed code turn itself off and
// report success.
if (!existsSync(join(root, "node_modules/@tauri-apps"))) {
  console.log(
    `SKIP: ${rel(join(root, "node_modules/@tauri-apps"))} is not installed — run npm ci in ` +
      "Projects/Paneless to enable the ACL check.",
  );
  process.exit(0);
}
if (!table.size) {
  console.error(
    "FAIL: @tauri-apps is installed but no API function could be parsed out of it. The scan's\n" +
      "      assumptions about the shape of the published code no longer hold, so a PASS here\n" +
      "      would mean nothing. Fix the parser in this file rather than trusting the result.",
  );
  process.exit(1);
}

// ---- 4. What each granted permission means, from the generated ACL manifests -------------------
const manifestPath = join(root, "src-tauri/gen/schemas/acl-manifests.json");
if (!existsSync(manifestPath)) {
  console.error(
    `FAIL: ${rel(manifestPath)} is missing. tauri-build writes it on every cargo build; run\n` +
      "      cargo check --manifest-path src-tauri/Cargo.toml   once, then rerun this test.",
  );
  process.exit(1);
}
// NO staleness gate here, deliberately. An earlier version failed when the manifest was older than
// Cargo.lock — but Cargo.lock is tracked, so every checkout and merge stamps it with the current
// time, while the manifest is gitignored and only cargo touches it. That check therefore blocked
// pushes over identical content because of a clock, in the very checkout pushes are made from. Nor
// is there a reliable content signal: the manifest records no crate versions, and the locked plugin
// set legitimately differs from the manifest's (transitive plugins such as tauri-plugin-fs, and
// command-less ones such as single-instance, never appear in it). So the age is REPORTED and left
// to the reader: if you changed crates, rebuild before trusting this run.
const manifestDate = new Date(statSync(manifestPath).mtimeMs)
  .toISOString()
  .slice(0, 10);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const prefixOf = (pluginKey) => pluginKey.replace(/^core:/, "");
const pluginKeyOf = (command) => {
  const p = command.slice("plugin:".length, command.indexOf("|"));
  return Object.keys(manifest).find((k) => k !== "core" && prefixOf(k) === p);
};
const split = (id) => {
  const i = id.lastIndexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
};

// "dialog:allow-message" → its commands; "core:default" → every command of every set it contains.
function expand(
  id,
  out = { allow: new Set(), deny: new Set(), missing: [], deprecated: [] },
  trail = [],
) {
  if (trail.includes(id)) return out;
  const [plugin, perm] = split(id);
  const m = manifest[plugin];
  let members = null;
  if (!m) out.missing.push(id);
  else if (perm === "default")
    members = m.default_permission?.permissions ?? (out.missing.push(id), []);
  else if (m.permission_sets?.[perm])
    members = m.permission_sets[perm].permissions;
  else if (m.permissions?.[perm]) {
    const p = m.permissions[perm];
    for (const c of p.commands?.allow ?? [])
      out.allow.add(`plugin:${prefixOf(plugin)}|${c}`);
    for (const c of p.commands?.deny ?? [])
      out.deny.add(`plugin:${prefixOf(plugin)}|${c}`);
    if (/deprecated/i.test(p.description ?? ""))
      out.deprecated.push(
        `${id}: ${p.description.replace(/\s+/g, " ").trim()}`,
      );
  } else out.missing.push(id);
  for (const mem of members ?? [])
    expand(mem.includes(":") ? mem : `${plugin}:${mem}`, out, [...trail, id]);
  return out;
}

function grantsFor(command) {
  const key = pluginKeyOf(command);
  if (!key) return [];
  const c = command.slice(command.indexOf("|") + 1);
  return Object.values(manifest[key].permissions ?? {})
    .filter(
      (p) =>
        p.commands?.allow?.includes(c) &&
        !/deprecated/i.test(p.description ?? ""),
    )
    .map((p) => `${key}:${p.identifier}`)
    .sort((a, b) => (a.endsWith(`allow-${c.replace(/_/g, "-")}`) ? -1 : 1));
}

// ---- 5. Capabilities, per window label ---------------------------------------------------------
const capabilityDir = join(root, "src-tauri/capabilities");
const capabilityFiles =
  process.argv.length > 2
    ? process.argv.slice(2).map((p) => resolve(p))
    : readdirSync(capabilityDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(capabilityDir, f));
const capabilities = capabilityFiles.map((file) => ({
  file,
  ...JSON.parse(readFileSync(file, "utf8")),
}));
const conf = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
const labels = (conf.app?.windows ?? []).map((w) => w.label ?? "main");
if (!labels.length) labels.push("main");

const report = [];
for (const label of labels) {
  const applies = capabilities.filter((c) =>
    (c.windows ?? c.webviews ?? ["*"]).some((w) => w === "*" || w === label),
  );
  const granted = new Map(); // id → { allow, deny, deprecated, missing, file }
  for (const cap of applies)
    for (const entry of cap.permissions ?? []) {
      const id = typeof entry === "string" ? entry : entry.identifier;
      granted.set(id, { ...expand(id), file: rel(cap.file) });
    }
  const allowed = new Set();
  const denied = new Set();
  for (const g of granted.values()) {
    for (const c of g.allow) allowed.add(c);
    for (const c of g.deny) denied.add(c);
  }
  report.push(
    `window "${label}": ${applies.length} capability file(s), ${granted.size} permissions granted, ${invocable.size} commands invocable from src/`,
  );
  for (const [command, via] of [...invocable].sort()) {
    if (denied.has(command))
      problems.push(
        `window "${label}": ${command} is DENIED but the frontend can invoke it — ${via}`,
      );
    else if (!allowed.has(command))
      problems.push(
        `window "${label}": ${command} has NO permission — invoked by ${via}\n` +
          `      grant: ${grantsFor(command).join(" or ") || "(no permission in the installed crate allows this command)"}`,
      );
  }
  for (const [id, g] of granted) {
    for (const m of g.missing)
      problems.push(
        `${g.file}: "${id}" names "${m}", which the installed crates do not define (typo, or a permission removed by an upgrade)`,
      );
    for (const d of g.deprecated)
      problems.push(
        `${g.file}: "${d}" — grant the permission named after the command instead`,
      );
    const used = [...g.allow].filter((c) => invocable.has(c));
    if (!g.missing.length && !used.length)
      problems.push(
        `${g.file}: "${id}" is granted but nothing in src/ invokes any of its ${g.allow.size} command(s) — the capability is "Local reader shell only", so remove it`,
      );
    else if (used.length)
      report.push(
        `  ${id.padEnd(36)} ${used.map((c) => `${c}  ← ${invocable.get(c)}`).join("\n" + " ".repeat(39))}`,
      );
  }
}

for (const w of warnings) console.log(`WARN: ${w}`);
if (problems.length) {
  for (const p of problems) console.log(`FAIL: ${p}`);
  console.log(
    `\n${problems.length} ACL problem(s) in ${capabilityFiles.map(rel).join(", ")}`,
  );
  process.exit(1);
}
console.log(report.join("\n"));
console.log(
  `ACL test passed: ${invocable.size} invocable command(s) all granted, no unused, unknown or deprecated permission (${files.length} source files, ${modules.size} installed API modules, ${capabilityFiles.map(rel).join(", ")}).\n` +
    `Permission meanings read from ${rel(manifestPath)}, generated ${manifestDate} — a build artefact: rebuild after changing crates, or this answer is about the old ones.`,
);
