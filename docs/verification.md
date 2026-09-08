# Verification record

Tested September 6–7, 2026 on an Apple M5 Pro, 24 GiB RAM.

## Passed

- TypeScript compilation and Vite production build.
- Rust unit tests: HTML/URL safety, GFM and heading IDs, local resource confinement, consecutive saves, external-change conflicts, and stale document IDs.
- Rust Clippy, all targets including the development adapter, with warnings denied.
- Native Apple Silicon release executable and `.app` bundle; app launches and renders documents.
- DMG creation with `CI=true`, which skips Finder's decorative icon positioning. The initial interactive DMG build failed in that optional step. The resulting installer is about 2.6 MB; the app is about 6.3 MB.
- Real macOS picker: `.md` selected and opened. Local raster image displayed from the document directory.
- Finder double-click: `welcome.md` delivered to an already-running Paneless instance and updated the title/document.
- Native source mode and Cmd+S: edits reached the fixture on disk; fixture restored afterward.
- Native outline, deferred highlighting, dark appearance, and external link opening in Safari.
- Packaged app opened the 20 MiB fixture and navigated its 12,037-heading outline. An observed late anchor shift was fixed by compensating scroll position as earlier sections acquire their measured heights, then verified by stronger Chromium and WebKit assertions.
- Chromium and WebKit: light/dark screenshots at 480, 1060, and 1800 px; document rendering, table/code overflow, outline navigation, edits and conflict refusal, empty documents, and hostile Markdown.
- Generated 100 KiB, 1 MiB, 5 MiB, and 20 MiB representative Markdown. Release Rust parsing plus the same frontend measured in both engines. Final results in `benchmark-results.json`.
- Tauri desktop-event integration passed: native picker command, drag-enter overlay, drop-to-open through the production listener, queued OS file delivery, and external-link IPC, using the official event mock with the real Rust reader.
- Large-file tests assert a bounded DOM, target-heading position after a long jump, and search near the end of the complete source.

## Limits and release follow-up

- Windows native compilation, installation, Explorer launch/second-instance handling, WebView2 behavior, and window restoration require a Windows machine. A macOS/Windows CI matrix is provided but has not been run remotely.
- A real cross-window Finder drag was attempted with computer automation but the drop was not conclusively delivered. The production event handler is covered separately using Tauri's official mocked event transport and the real Rust reader (`npm run test:desktop`). Manually drag a Markdown file onto the final app on each target OS before release.
- Signing, notarization, Authenticode, Intel/universal builds, and public distribution have not been performed.
- Benchmark first-render time is measured from the frontend open request to a paint opportunity after readable content insertion, using a development HTTP transport to the release Rust core. It is not a cold-process startup measurement or an exact native IPC measurement. WebKit does not expose Chromium's Long Tasks API; frame-gap measurements are used in both engines.
- Above 2 MiB, document sections are mounted near the viewport. Native selection/copy and accessibility are limited to mounted sections; source mode exposes the entire file. Search examines the whole text index and groups results by section. Scrollbar geometry is estimated until sections are visited. Very large single blocks still need further subdivision if they become a real workload.
- Remote and SVG images are intentionally blocked. Resource tests cover path escape and disallowed formats; local raster image rendering was verified in the native app. Very large decoded-image memory use and every raster codec were not exhaustively tested.

Screenshots and temporary test files are kept under ignored `test-results/`; synthetic documents are under ignored `benchmarks/generated/`.

## 0.2 project inbox — September 8, 2026

- Eight Rust tests pass, including first-scan baselines, content-versus-timestamp changes, same-metadata event invalidation, history/pins across restart, deletion/reappearance, excluded directories, symlink boundaries, and relative Markdown links. Clippy passes with warnings denied.
- Chromium and WebKit inbox tests pass against the real Rust index and parser with official Tauri IPC/event mocks. Coverage includes unread/updated/read counts, exact-revision read acknowledgement, background updates remaining unacknowledged, pins, filters, folder selection, long-list paging, keyboard movement, back navigation, automatic refresh, and unsaved-editor protection. Light/dark/narrow screenshots were inspected.
- The existing reader suite passes through 20 MiB in both engines, including bounded DOM, deep heading navigation, search, editing, and hostile Markdown. These regression runs used a **debug Rust adapter**; their timings are saved under ignored `test-results/inbox-debug-regression-results.json`. The earlier release benchmark numbers remain unchanged.
- Packaged macOS verification: selected a project with the native folder picker; first two documents appeared read; a new report appeared automatically as unread; opening acknowledged it; pinning persisted during the session; followed a relative link to a sibling folder; an atomic report replacement appeared as Updated; a new nested report directory was discovered automatically; Back reopened the latest revision; an external edit refreshed the open report.
- Fixed development-only duplicate app mounts by separating the React bootstrap from the App component. The desktop picker/drop/queued-open/external-link mock suite passes after this fix.
- The inbox UI/CSS is a separate lazy-loaded bundle; a single-file launch does not initialize the index. No new runtime package dependencies were introduced.
- Remaining platform limits: Windows native watch/installer behavior has not been exercised here. Signing/notarization, full Git ignore semantics, previous-content diffs, and precise semantic scroll anchoring are outside this release. The local index reflects the checkout on disk, not remote Git state.
