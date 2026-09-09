# A project-level task board in Markdown

This is the approach used in Gummybear from 2026-09-08, when its Notion task database hit the workspace block limit and every card was migrated into the repo. The board lives in the repository as one Markdown file per task, a generated `BOARD.md`, one zero-dependency script, and a few enforced rules. Humans read it in Paneless. Agents read and write it with ordinary file tools and `grep`. Nothing here depends on Paneless internals; Paneless is the viewer.

Why a folder of files rather than a tracker service:

- Agents already have file tools, git, and `grep`. They need no API, token, or MCP server to file, claim, or close work.
- History is git history. Who changed what, and when, is answered by `git log -- tasks/`.
- The board opens offline, in any Markdown reader, and Paneless refreshes it as agents write.
- The rules that matter are enforced by a lint in CI and a pre-commit hook, not by convention.

## Layout

```
tasks/
  README.md            the protocol of record (copy the sections below)
  BOARD.md             generated views; never edited by hand
  GB-<n>-<slug>.md     one open task per file
  archive/             done and dropped tasks, same shape, moved here on close
scripts/tasks.mjs      the only tool: new · board · lint · close
scripts/board.sh       opens BOARD.md in Paneless (macOS)
.github/workflows/tasks.yml   runs the lint on every push that touches tasks/
```

`GB` is the project prefix. Pick a short one for your project and use it in the id, the filename, and the H1.

## The task file

```markdown
---
id: GB-157
status: ready          # inbox | ready | in-progress | blocked | done | dropped
owner: agent           # <human-a> | <human-b> | either | agent
type: bug              # bug | feature | decision | tuning | chore | research | copy-design
priority: next         # now | next | later  (may be absent)
area: [ios, server]    # your project's areas
source: agent-session  # <human-a> | <human-b> | agent-session | scheduled-audit  (who FILED it)
added: 2026-09-08
blocked-on: "only when status is blocked: the one thing that unblocks it"
---

# GB-157 — Title

Two to eight lines a stranger can act on: what, why, the evidence. For a
decision: the options. Link the doc that holds the deep context, don't paste it.

## Refs
- 2deaf820
- server/src/services/chat/turn.ts:140
- docs/plans/2026-08-18-flexible-slots-design.md

## Log
- 2026-09-08 (agent session) — filed from the 0.28 crash report.
- 2026-09-09 (Vlad) — ruled: ship in 0.29.
- 2026-09-10 (agent session) — done: 09254237 pushed. Device pass still owed.
```

Field semantics:

- **status.** `inbox` filed and untriaged. `ready` triaged, anyone can pick it up. `in-progress` someone is on it. `blocked` see `blocked-on`. `done` shipped or answered. `dropped` deliberately not doing, and the Log says why.
- **owner.** Who the ball is with. `agent` means an agent may execute it without a fresh human decision. A human owner on a `decision` means nobody builds until that human rules.
- **source.** Who filed it. Agents file as `agent-session` or `scheduled-audit`, never as a human, even when transcribing a human's words. Say whose words in the body.
- **Refs** are greppable pointers only: commit SHAs, `path/to/file.ts:line`, doc filenames, related task ids. No prose.
- **Log** is append-only and dated. Every line names its author: `(Vlad)`, `(JK)`, `(agent session)`, `(scheduled audit)`. Nobody rewrites another author's line. A correction is a new line.
- There is no `updated` field. It is the file's last commit date, read from git when the board is generated.
- Cross-reference other tasks by id in text, never by path. A closed task moves to `archive/`, and a path would break.

Specs and deep context stay in the project's docs folder. A task is a pointer with enough context to act.

## The script

`scripts/tasks.mjs` is a single Node 20+ file with no dependencies. Gummybear's is about 400 lines. It has four commands.

| Command | What it does |
| --- | --- |
| `node scripts/tasks.mjs new "Title" --type bug --owner agent --priority next --area server` | Writes a task file with the next free id and prints its path. It fetches `origin/main` first and takes the highest id from both the local tree and the remote, so two sessions do not mint the same number. Defaults: `status: inbox`, `source: agent-session`, `added:` today. The body is a template with an empty Refs list and one dated "filed" Log line. |
| `node scripts/tasks.mjs board` | Regenerates `tasks/BOARD.md` from every task file. |
| `node scripts/tasks.mjs lint` | Validates every task file and fails when `BOARD.md` differs from a fresh render. This is the CI gate. |
| `node scripts/tasks.mjs close GB-12 [--dropped]` | Sets `status: done` (or `dropped`), then `git mv` moves the file into `tasks/archive/`. It reminds you to append the dated outcome line and regenerate the board. |

The lint checks, per file:

- `id` is `<PREFIX>-<n>`, unique, and the filename starts with `<id>-`.
- `status`, `owner`, `type`, `source` are each one of the allowed values. `priority` is allowed or absent. `area` is a list of allowed values, possibly empty.
- `added` is `YYYY-MM-DD`.
- `status: blocked` has a `blocked-on`.
- The first heading is exactly `# <id> — Title`.
- `done` and `dropped` files live in `archive/`, and nothing else does.
- There is a `## Log` section with at least one `- YYYY-MM-DD` line.

The frontmatter parser handles only the subset of YAML the script writes: scalars, quoted strings, inline lists `[a, b]`, and indented `- item` lists. That is deliberate. Keeping the parser small means no dependency and no surprises.

`BOARD.md` is a set of tables over the same files, each row linking to the task. The sections, in order:

1. **Now**: priority `now`.
2. **Decisions needed**: type `decision`.
3. **Blocked**: with the `blocked-on` text as a column.
4. **In progress**.
5. **Inbox (untriaged)**.
6. **One queue per human owner**, including `either`.
7. **Agent queue**: owner `agent` and status `ready`.
8. **Recently closed**: the last 14 days, dated by the last Log line, capped at 30 rows.

Rows sort by priority, then last commit date descending, then id descending. The header line carries counts per status and open-of-total. The first line of the file is an HTML comment saying it is generated and must not be edited by hand.

The "updated" column comes from one `git log --format=%cs --name-only -- tasks` call, so a freshly written untracked file falls back to its mtime. CI therefore checks out with full history (`fetch-depth: 0`); a shallow clone makes every date wrong and the freshness check fails.

## Reading the board

Humans open `tasks/BOARD.md`. In Paneless, use **Project inbox** on the repository folder: every task file appears as a document, new tasks show as Unread, and a task an agent has edited since you last read it shows as Updated. Open `BOARD.md` and leave it open; when an agent regenerates it, the file watcher refreshes the view and keeps your scroll position. Select a task's body and use **Ask agent** to hand it to Claude Code or Codex with the absolute path and section already in the prompt.

Agents use `grep` as the query language:

```sh
grep -l '^status: ready' tasks/GB-*.md | xargs grep -l '^owner: agent'   # the agent queue
grep -rl 'GB-73' tasks/                                                # everything that mentions a task
grep -l '^type: decision' tasks/GB-*.md                                # open decisions
```

## Filing and working a task

1. **Search first.** `grep -ril '<keyword>' tasks/` before creating. If a task exists, append a dated Log line and adjust its status. A duplicate is worse than a miss.
2. `node scripts/tasks.mjs new ...`, then fill the body and Refs.
3. Status stays `inbox` unless a human asked for the work in this session. Then it is `ready`.
4. `node scripts/tasks.mjs board`, then commit the task file and `BOARD.md` together. The lint fails on a stale board.
5. **Claim before starting:** set `status: in-progress`, add a Log line, commit and push. That is the signal to concurrent sessions and scheduled routines. An uncommitted edit is invisible to them.
6. **Finish:** `node scripts/tasks.mjs close GB-nn`, append the dated outcome line with the commit SHA and deploy state, regenerate the board, commit. If verification is still owed, the task stays open and the Log says what is owed.
7. Mention the task id in commit messages when natural, so git and the board cross-link.

When a repo doc closes an item that has a task, close the task in the same commit. When a task ships, the durable record is still the repo. The task points at it.

## Hard rules for agents, and how they are enforced

Four things an agent must never do on its own:

- Resolve a `decision`. Humans rule; agents append findings, evidence, and options.
- Set `status: dropped`. That is a human call.
- File a new task as a human (`source: <human>`).
- Remove a dated Log line.

Plus one: a task file is archived, never deleted.

In Gummybear these are enforced by a Claude Code `PreToolUse` hook on Bash (`.claude/hooks/guard-bash.py`, registered in `.claude/settings.json`). When the command is `git add <path under tasks/>` or `git commit`, the hook diffs the task files about to be recorded (working tree against HEAD for `add`, the index for `commit`, with untracked files synthesised as all-added diffs) and scans the diff:

| Diff line | Finding |
| --- | --- |
| `+status: dropped` | a human call |
| `+status: done` in a file whose content has `type: decision` | only a human resolves a decision |
| `+source: vlad` or `+source: jk` in a new file | filed as a human |
| `-- 2026-09-08 ...` (a removed dated Log line) | the Log is append-only |
| `deleted file mode` with no same-named file in `tasks/archive/` | tasks are archived, never deleted |

Any finding turns the command into a permission prompt whose text names the violated rule. A human approving the prompt is the authorisation. In a headless routine nobody can approve, so the write fails, which is the point. A denied prompt is a no; the agent must not rephrase the command to route around it.

A scheduled audit files everything as `inbox` + `scheduled-audit`. It may append a dated evidence line to a task the repo shows has shipped, and may close a task only when its own commit in the same run fixed it. No re-prioritising, no bulk rewrites.

## Telling the agent about it

Three places, so the rules load whether or not the session started near the board:

- **`tasks/README.md`** is the protocol of record. It holds everything in the sections above, written for the project.
- **A path-scoped rule** (`.claude/rules/tasks.md` with `paths: ["tasks/**", "scripts/tasks.mjs"]`) loads when a session touches the folder. It is the short version: one task per file, generated board, the commands, claim and close, the four never-do rules, and that every Log line names its author.
- **The project `CLAUDE.md`** has one paragraph under working-in-this-repo that says the board exists, where the protocol lives, and repeats the short version.

A `/board` slash command (`.claude/commands/board.md`) runs `scripts/board.sh` for the human and, if the question was really about the board's contents, answers from `BOARD.md` instead.

## Opening the board without installing anything

`scripts/board.sh` opens `tasks/BOARD.md`, or any task file passed as an argument, in Paneless. It uses an installed Paneless in `~/Applications` or `/Applications` if there is one. Otherwise it unpacks the zip checked in under `tools/paneless/` into `~/Applications` and writes a marker file with the zip's sha inside the app bundle. A copy it installed is upgraded when the bundled zip changes. A Paneless you installed yourself is never touched; the script only notes a version mismatch on stderr.

To bundle Paneless in your own repo, build it here and zip the app bundle:

```sh
CI=true npm run tauri -- build --bundles app,dmg
ditto -c -k --keepParent src-tauri/target/release/bundle/macos/Paneless.app /path/to/your-repo/tools/paneless/Paneless-<version>-arm64.zip
```

The bundled build is unsigned. A git checkout carries no quarantine flag, so it opens without the Gatekeeper prompt. If someone downloads the zip through a browser instead, they right-click and Open the first time. The bundle is Apple Silicon only; on other platforms `board.sh` exits and tells the user to open the file in any Markdown viewer.

## CI

One workflow, path-filtered to `tasks/**`, the script, and itself. Checkout with full history, set up Node, run `node scripts/tasks.mjs lint`. It is free, has no secrets, and touches no network beyond checkout. Run the lint locally before committing task changes.

## Setting it up in a new project

1. Create `tasks/` and `tasks/archive/`. Write `tasks/README.md` from the sections above with your prefix, humans, and areas.
2. Write `scripts/tasks.mjs` to the contract in "The script". The enums at the top of the file are the only project-specific part: owners, areas, sources, and the id prefix.
3. Run `node scripts/tasks.mjs new "First task"` and then `board`. Commit both files.
4. Add the CI workflow.
5. Add the path-scoped rule, the CLAUDE.md paragraph, and the guard hook if your agents commit through Claude Code. Without the hook the four never-do rules are still stated, just not enforced.
6. Optionally bundle Paneless under `tools/paneless/` and add `scripts/board.sh` and the `/board` command.

If you are migrating from another tracker, keep a back-link. Gummybear's migrated files carry a `notion:` frontmatter field pointing at the read-only original, and the frontmatter renderer knows the key so it stays in a stable position.
