# Terminal board: related task navigation

## Local entry

Run the isolated source version:

```sh
/Users/goldenman/git/Backlog-task-45/scripts/backlog-related-board
```

The launcher explicitly sets `BACKLOG_CWD=/Users/goldenman/git`. It requires Bun and
the worktree's dependencies. It does not replace the installed `backlog` command or
the existing Herdr launcher.

Alternatively, from this worktree:

```sh
BACKLOG_CWD='/Users/goldenman/git' bun src/cli.ts board
```

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

## Isolation

Worktree: `/Users/goldenman/git/Backlog-task-45`.
Branch: `tasks/task-45-related-navigation`.
Base: `92c79f84de5e8f1f6844ec5316f7b663da9fd4b9`.

This branch contains only TASK-45 changes. No TASK-46/Herdr changes are included;
the committed base has no W handoff. Combined W/R behavior must be verified when
the separate work is integrated. The original worktree and existing launchers are
not modified. No commit or push is made.

## Verification

```sh
bun test --timeout=10000 src/test/board-popup-sync.test.ts src/test/related-tasks.test.ts
RUN_INTERACTIVE_TUI_TESTS=1 bun test src/test/board-related-tasks-pty.test.ts
bunx tsc --noEmit
bunx biome check .
```

The PTY test requires Unix and `expect`. It uses an isolated fixture with real Core,
filesystem watchers and actual terminal key bytes. It covers hidden targets, a
three-level navigation path, visible scroll restoration, missing/ambiguous IDs,
external changes and retained picker focus. It does not mutate the work ledger.
Transcripts are saved under `tmp/tui-interactive-transcripts/` (Git-ignored).

### Results on 2026-10-12

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

W handoff integration remains unverified because its changes are deliberately not
part of this branch. TASK-45 stays In Progress with acceptance criterion 3 pending;
criteria 1, 2 and 4 are verified. No other task, repository branch or launcher is
merged into this worktree.
