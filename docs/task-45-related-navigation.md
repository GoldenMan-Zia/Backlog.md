# Terminal board: related task navigation

## Local entry

Run the source version from the main checkout:

```sh
/Users/goldenman/git/Backlog.md/scripts/backlog-related-board
```

The launcher explicitly sets `BACKLOG_CWD=/Users/goldenman/git`. It requires Bun and
the checkout's dependencies. It does not replace the installed `backlog` command or
the existing Herdr launcher.

Alternatively, from `/Users/goldenman/git/Backlog.md`:

```sh
BACKLOG_CWD='/Users/goldenman/git' bun src/cli.ts board
```

The existing `backlog-herdr-board` launcher also includes related navigation after
integration. Use it, or pass `--herdr-session default` to the source launcher, to
enable W handoff. See [herdr-local.md](herdr-local.md) for configuration.

## Keys

- Enter opens the selected board task.
- R in task details opens the related-task picker.
- Arrow keys or j/k select a related task; Enter opens its details.
- Esc cancels the picker without losing the task's scroll position.
- Esc/q in details returns one level, restoring the previous task's scroll position.
- Esc/q from the original details returns to the original board selection. If that
  task moved status, the board follows its new column; if it disappeared, focus
  falls back to a surviving column.

The picker merges whole numeric IDs in References (including dotted subtask IDs)
with the native parent and direct children. It deduplicates case and leading-zero
variants and excludes self-links. Unprefixed numeric references use the source
task's prefix. Plain paths, URLs, prose and non-numeric legacy References do not
become selectable links.

Task identity is resolved through Core, not the visible board rows. Missing and
ambiguous targets show warnings; Enter re-reads the selected target before opening
it. It never chooses an arbitrary file when IDs collide.

The board keeps its filters. Related details can be opened outside the filtered or
loaded board corpus. Watcher updates refresh the displayed task while retaining
scroll, but are deferred while a picker or confirmation dialog owns the keyboard.
Returning to a task loads its latest content rather than an old navigation snapshot.
Deleted or unreadable ancestors are skipped with a warning so Back does not trap
the user.

Editing, copying the ID, completing and archiving operate on the displayed task.
Existing read-only and confirmation checks remain in place. Navigation itself does
not change tasks or statuses.

W hands off the displayed task, including a related task outside the board corpus.
Handoff is ignored while navigation is pending. Watcher updates are deferred during
handoff; after success or error acknowledgement, the latest detail is restored and
Esc/q still returns through the navigation stack.

## Implementation history

Worktree: `/Users/goldenman/git/Backlog-task-45`.
Branch: `tasks/task-45-related-navigation`.
Original base: `92c79f84de5e8f1f6844ec5316f7b663da9fd4b9`.

TASK-45 was implemented independently of the uncommitted Herdr work. After the
user confirmed testing and requested integration, the branch was rebased onto
`261c29f8` (the committed Herdr loading and result feedback). TASK-45's commits
contain related navigation and its integration tests, not a copy of the Herdr
implementation. The existing installed launchers are not replaced. No push is made.

## Verification

```sh
bun test --timeout=10000 src/test/board-popup-sync.test.ts src/test/related-tasks.test.ts
RUN_INTERACTIVE_TUI_TESTS=1 bun test src/test/board-related-tasks-pty.test.ts
RUN_INTERACTIVE_TUI_TESTS=1 bun test src/test/herdr-handoff-pty.test.ts
bunx tsc --noEmit
bunx biome check .
```

The PTY test requires Unix and `expect`. It uses an isolated fixture with real Core,
filesystem watchers and actual terminal key bytes. It covers hidden targets, a
three-level navigation path, visible scroll restoration, missing/ambiguous IDs,
external changes and retained picker focus. It does not mutate the work ledger.
Transcripts are saved under `tmp/tui-interactive-transcripts/` (Git-ignored).

### Independent verification on 2026-10-12

- 142 related tests pass across 19 files, including the enabled PTY test.
- The related-task choice loader has 100% line and function coverage in the
  coverage run; this is not a claim of full-application coverage.
- TypeScript type checking passes. Biome checks all 434 files without fixes.
- `git diff --check` passes.
- The source launcher is exercised against the real work ledger: TASK-35 opens
  TASK-35.1 and returns to TASK-35, then exits normally. SHA-256 hashes of all six
  TASK-35-family task files remain unchanged. Transcript and pre-run hashes are
  under `tmp/task-45-verification/`.
- The PTY test catches a real scroll-restoration error missed by the initial mock
  tests: `getScroll()` includes a virtual cursor offset, while `childBase` is the
  visible first row. Navigation now saves and restores the visible row. Widget
  tests also use real terminal dimensions and assert that visible row.

### Integration verification on 2026-10-12

Combination tests cover handing off the refreshed related detail, watcher changes
during handoff, success/failure recovery, retained parent scroll and return to the
board. Real-terminal CLI tests use a fixture Herdr executable and verify that the
prefilled template targets the related task, both task files stay unchanged, input
is locked during loading, and Esc/q returns to the parent and board. They do not
contact or change the user's Herdr session.

A regression test catches W acting on the old detail while a return destination is
still being read. The shared handoff guard now also checks pending navigation.

- 170 tests pass across 22 files, with 563 assertions and no failures, including the
  enabled navigation PTY test and all four success/failure Herdr PTY cases.
- TypeScript type checking passes. Biome checks all 439 files without fixes.
- `git diff --check` passes.
- Logs: `/tmp/task-45-integrated-tests.log`, `/tmp/task-45-integrated-types.log`,
  `/tmp/task-45-integrated-biome.log`. The independent verification artifacts remain
  in the implementation worktree's Git-ignored `tmp/` directory.
- The user reports the independent version's testing as OK before integration.
