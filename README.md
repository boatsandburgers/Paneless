# Paneless

A small, quiet desktop reader for local Markdown. Open a file, drop one into the window, or double-click it in Finder or Explorer. Reading comes first; a simple source editor is there when you need it.

Tauri 2 · React 19 · TypeScript · Vite · Rust / pulldown-cmark

## Run and build

Install Node.js 24 LTS (or another Vite-supported release), npm, and stable Rust. Follow the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run tauri dev
```

`npm run dev` alone serves a development browser shell; it is not the desktop app. Its optional local filesystem adapter is described below.

```sh
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features bench-server -- -D warnings
npm run tauri build
```

**macOS:** Install Xcode / its command-line tools and Rust's native Apple target. `npm run tauri -- build --bundles app,dmg` produces an app and DMG in `src-tauri/target/release/bundle/`. This checkout was built and run on Apple Silicon. An Intel build requires the `x86_64-apple-darwin` Rust target; a universal build uses Tauri's `--target universal-apple-darwin` with both Apple targets installed. Distribution still needs your Developer ID, signing configuration, and [notarization](https://v2.tauri.app/distribute/sign/macos/). The generated local build is not a notarized public release. If Finder automation is unavailable, `CI=true npm run tauri -- build --bundles app,dmg` skips decorative DMG layout; this produced the verified 2.6 MB installer on this host.

**Windows:** Install the Visual Studio C++ desktop build tools, Windows SDK, WebView2, and stable Rust's MSVC toolchain. Run the same commands from PowerShell. Tauri bundles the executable into Windows installers; Authenticode signing requires your certificate/configuration. Windows compilation and Explorer integration are included in the implementation and CI configuration, but have not been executed on this macOS host.

On this development host only, Rust was provisioned under `/tmp` without changing the user's shell configuration. Until a normal Rust installation is available, prefix native commands with:

```sh
export PATH="/tmp/paneless-cargo/bin:$PATH"
export CARGO_HOME=/tmp/paneless-cargo
export RUSTUP_HOME=/tmp/paneless-rustup
```

## Using it

- Open `.md` and `.markdown` files using the native picker, OS file associations, or drag/drop. Files must be UTF-8; empty documents are supported.
- The outline button shows headings, with a filter and bounded row rendering for thousands of entries. It starts hidden.
- **Aa** controls light, dark, or system appearance, font size, and reading width. Preferences persist locally; native window size and position are restored by Tauri's window-state plugin.
- The source button opens a plain, monospaced textarea. Save before returning to reading; unsaved changes require confirmation before replacement or close/quit.
- File watching uses OS notifications on the containing directory, including atomic replacements. External changes show a **Reload** notice. This deliberately lets you retain your reading position or copy unsaved edits before reloading. Saving checks the original disk fingerprint and refuses to overwrite external edits. Writes use a temporary sibling file and atomic replacement while preserving permissions.

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+O | Open file |
| Cmd/Ctrl++ / − | Increase / decrease type size |
| Cmd/Ctrl+0 | Reset type size |
| Cmd/Ctrl+F | Find in document |
| Cmd/Ctrl+S | Save source |
| Escape | Close appearance or find controls |

## Architecture and parser choice

`src-tauri/src/document.rs` reads the local file and converts pulldown-cmark's event stream directly into HTML, heading metadata, and a text search index. Raw HTML events are discarded and resource/link destinations are constrained. `src-tauri/src/lib.rs` runs opening/parsing and saving on background workers, retains the current document, handles platform events and file watching, and serves raster images through a restricted custom protocol.

React manages the shell. `Reader.tsx` inserts native HTML sections in approximately 6 ms work slices, yielding to painting and input between batches. Syntax highlighting is a separate, dynamically loaded Highlight.js bundle, applied after readable code appears and only near the viewport. Nine common language grammars ship; unknown languages and code blocks over 24 KB remain readable plain code. Source text crosses IPC only when editing begins.

A JavaScript parser such as Marked or markdown-it could also run in a worker, but would require moving the whole source across IPC, a worker protocol, and a sanitization pass or equivalently strict token filtering. Rust already owns file access, and pulldown-cmark provides a mature streaming event API without a persistent AST or React node tree. That makes it a compact architecture with directly measured read/parse timings. This is **not** a claim that Rust beats every JS parser: no controlled JS parser comparison was performed. The measured bottleneck was browser DOM/layout, not parsing. See [pulldown-cmark's API](https://docs.rs/pulldown-cmark/latest/pulldown_cmark/) and [Tauri's process model](https://v2.tauri.app/concept/process-model/).

### Large documents

Files up to 2 MiB retain the whole HTML document, with `content-visibility: auto` avoiding offscreen layout. Browser selection, copying, anchors, and find operate normally after insertion completes.

The initial 20 MiB stress fixture produced **1.57 million DOM elements**. Chunked insertion avoided a blank window, but WebKit still experienced multi-second stalls. This evidence justified `LargeReader.tsx`: above 2 MiB it keeps nearby sections mounted, remembers their heights, and retrieves other sections on demand. The final 20 MiB run held roughly **6,300–6,500 elements**, including lightweight placeholders. No long frame gaps were recorded during the measured load and theme change.

Tradeoffs are explicit: large-file scrollbar geometry is estimated until sections are visited; browser Select All/copy and accessibility expose the mounted portion, not the entire document. Selection within visible sections is native. Use source mode to copy the full file. Cmd/Ctrl+F searches the **whole document in Rust** and navigates matching sections; repeated occurrences within one section are grouped as one result. Outline anchors can jump directly to unmounted headings. A single enormous block (for example a multi-megabyte unbroken table or paragraph) is not subdivided and can still be expensive. File input is capped at 100 MiB.

## Security

Markdown is untrusted. It never enters a privileged React/component pipeline.

- Raw HTML is disabled, including scripts, iframes, styles, and event-handler attributes. Text and attributes are escaped by pulldown-cmark's HTML writer.
- Links allow heading fragments, HTTP(S), and mailto. External destinations open through the OS browser/mail handler; they cannot navigate the app WebView or inherit application privileges. Relative document links are inert in v1.
- Images are limited to PNG, JPEG, GIF, WebP, and AVIF under the currently open document's canonical directory. Canonicalization rejects traversal and symlink escapes; per-document IDs invalidate resources from previous files. No SVG, file URLs, absolute image paths, data URLs, remote images, or network shares are loaded. Individual image files are capped at 32 MiB.
- A restrictive production CSP disallows frames, objects, arbitrary script, and remote connections. The app does not grant the WebView a filesystem plugin permission or a global asset-protocol scope.
- The development-only HTTP adapter is optional behind `bench-server`, binds loopback, and rejects foreign origins. It is never started or included as a running service in normal desktop builds. Stop it after testing.

## File associations

`tauri.conf.json` declares `.md` and `.markdown` with the Editor role. macOS handles `RunEvent::Opened` both at launch and while running; startup paths are queued until the frontend listener is ready. Windows receives command-line paths, and the single-instance plugin forwards subsequent launches using the calling directory. See [Tauri's association example](https://github.com/tauri-apps/tauri/tree/dev/examples/file-associations) and [single-instance documentation](https://v2.tauri.app/plugin/single-instance/).

Install the bundled app/installer before testing associations. On macOS use Finder's **Open With → Paneless**; **Get Info → Open with → Change All** is the user's choice to make it the default. On Windows choose Paneless in **Open with / Default apps** after installation. Packaging registers support but does not forcibly replace the user's preferred Markdown app. Signing, notarization, and Windows installer/Explorer behavior still require release-machine verification.

## Benchmarks and QA

```sh
npm run bench:generate
# In separate terminals:
npm run bench:server
npm run dev
# Then:
npx playwright install chromium webkit
npm run test:ui
npm run test:desktop
```

The generator creates approximately 100 KiB, 1 MiB, 5 MiB, and 20 MiB in `benchmarks/generated/` (ignored by Git), mixing paragraphs, heading hierarchies, nested/task lists, 36-row tables, quotations, links, inline formatting, and fenced code. The largest file has 6,018 sections and 12,037 headings. Tests use the **release Rust reader** through a development HTTP adapter and the same frontend in Playwright Chromium and WebKit. Measurements cover native file read, parse/metadata/index construction, and open request to a paint opportunity after first readable insertion. They exclude process cold startup, native file-picker time, and actual Tauri IPC transport. Cache state and host load are uncontrolled; these are regression measurements, not guaranteed latency figures.

Recorded on an Apple M5 Pro with 24 GiB RAM:

| File | Read | Parse | First readable, Chromium / WebKit |
| --- | ---: | ---: | ---: |
| 100 KiB | 0.3–2.3 ms | 1.0–3.1 ms | 15 / 24 ms |
| 1 MiB | 0.4–2.5 ms | 8.1–8.9 ms | 30 / 18 ms |
| 5 MiB | 1.9–3.6 ms | 37–43 ms | 64 / 62 ms |
| 20 MiB | 4.0–8.2 ms | 139–142 ms | 176 / 203 ms |

At 100 KiB and 1 MiB, the complete DOM was inserted in about 71–79 ms and 450–462 ms respectively. For larger files, `completeMs` means the bounded reader is ready, **not that all content is mounted**. Raw measurements are in [`docs/benchmark-results.json`](docs/benchmark-results.json). The frontend shell is about 67 KB gzipped; highlighting is a deferred 21 KB gzipped chunk. The Apple Silicon app bundle is approximately 6.3 MB on disk.

Automated checks cover TS/build, Rust URL/HTML/resource confinement and save conflicts, light/dark screenshots at 480/1060/1800 px, outline navigation, editing/save, empty/hostile Markdown, overflow, and large-file search/DOM bounds. Visual outputs are under ignored `test-results/`. Native macOS picker opening, Finder double-click delivery to a running instance, relative raster images, source/save, outline, external browser opening, and the packaged 20 MiB reader were exercised. Tauri’s official event mock additionally exercises the production drag/drop listener against the real Rust backend; an actual cross-window OS drop was not conclusively automated. See [`docs/verification.md`](docs/verification.md) for remaining manual platform checks.
