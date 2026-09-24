# Changelog

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

### Editor and appearance

The source editor is CodeMirror 6 with Markdown highlighting, line numbers and wrapping, themed from the reader's own tokens. The native window title bar follows the theme, which it did not before, leaving dark title text on a dark bar. Inline code has a border and its own fill, having been nearly invisible against the dark page background. The two inbox footer actions are one style instead of one button that looked like text. The accent is blue and the surfaces are neutral; the app icon is the fork's.
