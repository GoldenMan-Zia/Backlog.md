# TASK-58: Status badges in related tasks

Open a task in the terminal board and press `R`. Each readable related task now
shows its current status before its ID and title:

```text
[○ To Do] TASK-35.1 - Pending child
[◒ In Progress] TASK-35.2 - Active child
[✔ Done] TASK-35.3 - Finished child
```

The status comes from the target task, including custom status names. Reopening
the list reads it again. The existing status icons and colors are reused. Missing,
ambiguous, and unreadable targets keep their existing warnings; selection still
uses task IDs. Opening the list does not change task files.

## Scope and implementation

Based on `fork/local-main` at `2ab5efcb`. The production change is confined to
`src/ui/related-tasks.ts`; it adds no persisted fields, dependencies, sorting,
or task lifecycle behavior. The list is a snapshot while open.

## TDD evidence

The user journey is to inspect a parent's related tasks and identify children
that have not started without opening each child.

- RED checkpoint `fe519087`: four related-task tests failed because the status
  prefixes were absent. The focused board picker test failed for the same reason.
- GREEN checkpoint `87dcbaef`: 38 tests passed, 169 assertions, no failures:

```sh
RUN_INTERACTIVE_TUI_TESTS=1 bun test --timeout=10000 \
  src/test/related-tasks.test.ts \
  src/test/board-popup-sync.test.ts \
  src/test/board-related-tasks-pty.test.ts
```

These checks cover default and custom status labels, native parent/child
relationships, reference deduplication, missing and ambiguous targets, fresh
status reads through real Core, and keyboard navigation through a real PTY.
The PTY changes a child's status externally and checks the updated badge after
reopening its parent's list, while retaining navigation and scroll checks.

`bun test --timeout=10000 --coverage src/test/related-tasks.test.ts` passed all
eight tests. The changed related-task module has 100% line and function coverage;
this is not application-wide coverage. TypeScript and Biome checks passed.

## Local build

```sh
BACKLOG_BUILD_VERSION=1.53.0-local.87dcbaef bun scripts/build.ts
```

Run the resulting `dist/backlog` with `BACKLOG_CWD` set to the desired ledger.
This task does not replace the installed CLI, merge branches, or push commits.

The compiled CLI also passed a separate PTY smoke test using a temporary ledger
created through CLI commands: a parent and three children with different statuses.
All three badges rendered, selecting a child and returning worked, and the process
exited normally. SHA-256 checks confirmed that all four task files were unchanged.
The script, transcript, and receipt are in the worktree's ignored
`tmp/task-58-verification/` directory.
