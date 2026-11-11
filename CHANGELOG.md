# Changelog

## Unreleased — changes from the PEOPS fork, 25 September – 5 November 2026

Written against the first part of this pull request (29e2513). Built and run on macOS / Apple Silicon.

### Find counts its matches

Cmd/Ctrl+F used to say "Found" or nothing. The field now shows a count, the way Google Docs does: "12 matches" while you type, "3 of 12" once you jump, "0 of 0" when the word is not there. Typing only counts. The page moves on Enter, Next or Previous.

The reader, the source editor and documents over 2 MiB now share one matcher in `src/findText.ts`, and the Rust count in `search_document` folds text the same way. So the number in the field is always the number of places Enter visits. It ignores case and nothing else. A word split by bold or a link counts once, and image alt text does not count, because neither is how the page reads.

This replaced `window.find`. In the reader it matched the query inside the find box itself, so Enter stopped on the box and never reached the page. The jump now paints a CSS highlight and leaves the keyboard in the box.

### Large documents keep the found word in place

Four defects in `LargeReader.tsx`, each reproduced with a chunk fetch delayed by 300 ms:

- a neighbour section that mounted late pushed the found word off screen;
- quick steps whose sections arrived out of order marked the last one to arrive, so the mark and the counter disagreed;
- a section kept for a match, or fetched off screen, was never evicted afterwards;
- a short section came back from eviction taller than it was, and at the end of a document the word moved.

Evicted sections now keep their real height. A section that renders as nothing (raw HTML only) is no longer evicted, because each visit fetched it again.

### Open in Claude Code goes to the session already working on the folder

When a Claude desktop session is open on the document's folder, the button switches to it instead of starting a new one, and the dialog names the session. Running sessions come from `~/.claude/sessions/`. The `claude://code/continue` link takes no prompt, so the context goes on the clipboard and nothing is sent. With no such session it opens a new one as before.

The Supacode button and its link code are gone. Say if you still use it and it comes back.

### The editor

Selected text in the source editor was nearly invisible: a pale tint under pale syntax colours. Every syntax colour on the selection now meets WCAG AA (4.5:1) in both themes. The editor also has its accessible name, "Markdown source", again. The plain textarea had it, and CodeMirror dropped it in the first part of this pull request.

### Tests

`npm run test:find` is new and covers the counter in all three modes and the large-document cases above. The other suites had drifted from the app. `test-inbox` looked for labels that had been renamed, and the development adapter in `bench-server.rs` did not know the multi-folder commands. `test-handoff` waited for a status text the app has never shown. `test-ui` now replaces text with real keystrokes: Playwright's `fill` races CodeMirror in WebKit and about 1 run in 100 saved a leading blank line, which typing never did in about 1,770 runs.

## Unreleased — changes from the PEOPS fork, 9–24 September 2026

Written against 9065bb2. Everything below was built and run on macOS / Apple Silicon.

### The inbox holds several folders

The inbox tracked one project folder. It now tracks any number, each a chip that can be switched off to hide its documents and on to bring them back, with the enabled set shown as one merged list. Read, unread and updated state is kept per folder and independently, so closing a folder and reopening it later keeps its history.

The reason for the work was a folder on a server: when the share was unreachable the single-folder model had nowhere to put it. A folder that cannot be reached now stays in the list as an offline chip and comes back, with its history, on the next Refresh.

Internally each root is an `Open { root, project, view }` and each is scanned under its own lock, while the list of roots is locked only long enough to clone the handles. A cached snapshot is written under the project lock and read without it, so the merged view never waits behind another folder's scan. That is what stops one hung network mount freezing the window. Payloads carry an increasing version and the UI drops one that lands out of order.

### Documents can be created

Cmd/Ctrl+N opens an empty buffer with no file behind it, the way TextEdit does; the first save asks where it goes, starting in the folder of the document that was open. A new Rust command `create_document` writes the file with `create_new`, which tests for existence and creates in one syscall, so a new note cannot overwrite an existing file even when the save panel has already asked about replacing it. A failure after the file exists removes it again, so a retry is not blocked by the previous attempt's leftover. Six unit tests cover the creation rules.

### Saving to a network share works

`Reader::save` flushed with `sync_all`, which on macOS issues `fcntl(F_FULLFSYNC)` — and SMB rejects that with ENOTSUP, so every save to a share failed with "Operation not supported (os error 45)". It now falls back to a plain `fsync`, and to nothing if that is also refused: the atomic rename, not the flush, is what guarantees a reader never sees a half-written file. The permission copy is best-effort for the same reason.

### The window-close button works

Closing the window did nothing at all, with or without unsaved changes. `onCloseRequested` calls `destroy()` itself when the handler does not prevent the default, Tauri's core prevents the close as soon as a JS listener exists, and `core:window:allow-destroy` is not part of `core:window:default` — so every close path ended in a denied command, and the rejection happened inside the API's own listener where nothing could report it. Granting the permission fixes it. `confirmDiscard` now reports a failed dialog instead of swallowing it.

### The release build produces an app again

`[profile.release] strip = true` applies to build scripts and proc macros as well as to the binary, and a stripped proc-macro dylib loses the metadata rustc needs to recognise it as a crate. The release build failed with `can't find crate for ctor_proc_macro`, naming a file that is present on disk and passed to rustc on the command line. `[profile.release.build-override] strip = "none"` fixes it; the shipped binary is still stripped.

### A test for the permission list

`npm run test:acl` compares the capability files against the plugin commands the frontend can reach, deriving both sides from the installed packages. Nothing at build time reads those files, so a wrong list passes tsc, cargo and every unit test and fails only when a person uses the feature — which is how both permission defects above were found. The header states what the static scan cannot see.

### The Windows test run passes

Two unit-test helpers opened a file with `File::open` and then called `set_times` on it. `SetFileTime`
requires a handle carrying `FILE_WRITE_ATTRIBUTES` ([Microsoft's own wording](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfiletime)),
which a read-only open does not have, so both tests failed on Windows with "Access is denied"
(os error 5) while passing everywhere else. Opening for write carries the right and changes nothing
on Unix. One of the two helpers is in `project.rs`, which this fork otherwise does not touch.

### Editor and appearance

The source editor is CodeMirror 6 with Markdown highlighting, line numbers and wrapping, themed from the reader's own tokens. The native window title bar follows the theme, which it did not before, leaving dark title text on a dark bar. Inline code has a border and its own fill, having been nearly invisible against the dark page background. The two inbox footer actions are one style instead of one button that looked like text. The accent is blue and the surfaces are neutral; the app icon is the fork's.
