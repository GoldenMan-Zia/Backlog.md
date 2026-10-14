# Local Codex completion summaries

This opt-in local integration starts `codex exec` after an existing task moves
from any non-Done status to Done. It reuses `onStatusChange`: moving or reordering
a task within Done does not start a summary. CLI and board status changes use the
same callback. Tasks created directly in Done do not trigger it.

The callback starts a detached instance of `scripts/backlog-codex-summary.ts`
and returns immediately. That script holds a per-ledger, per-task lock while
Codex runs. Terminal input is disconnected and output goes to a private local
log, so quitting the board or closing its terminal does not stop the summary.
There is no service, queue, or separate summary writer. Codex reads and appends
the task through the public Backlog CLI.

## Test first

From this checkout, run:

```sh
bash scripts/test-codex-summary
```

The default uses a fixture Codex executable. It tests transitions from To Do and
In Progress, Done-only reordering, batch moves, duplicate execution, model
failure and retry, reopening during analysis, and a real terminal in which M
moves a task to Done and Q exits before the fixture writes back. It requires Bun,
the checkout's dependencies, and `expect`. It makes no model calls and uses
temporary ledgers rather than your existing tasks.

To test with your installed, logged-in Codex CLI:

```sh
bash scripts/test-codex-summary --real
```

This creates a disposable ledger, a uniquely prefixed task with an existing
human summary, and sample conversation history with a neutral filename. Move the
task to Done, confirm with Enter, then quit the board immediately. The script
prints commands to inspect the task and tail its log. Closing the test script's
terminal also leaves the detached summary running.

Expected result: the human summary remains; the new summary reports the sample
cache decision, simulated verification, outstanding load test, source session ID,
date, and evidence limitations. AC and status remain untouched. A passing fixture
test verifies process and CLI behavior; it does not establish that a real model
found or interpreted history correctly. The real test invokes Codex and uses
your normal model configuration and authentication. Temporary test data is kept
for inspection; remove its printed directory after the background run finishes.

## Enable in a ledger

Use the source CLI from this checkout. The installed binary may not yet expose
`config set onStatusChange`.

```sh
BACKLOG_CWD=/absolute/ledger/root bun /absolute/Backlog.md/src/cli.ts config get onStatusChange
BACKLOG_CWD=/absolute/ledger/root bun /absolute/Backlog.md/src/cli.ts config get autoCommit
```

Keep `autoCommit` disabled: the background script refuses to invoke Codex when
it is enabled. After inspecting the existing callback, set the callback command:

```sh
BACKLOG_CWD=/absolute/ledger/root bun /absolute/Backlog.md/src/cli.ts config set onStatusChange '"/absolute/path/to/bun" "/absolute/Backlog.md/scripts/backlog-codex-summary.ts"'
```

Use absolute paths. If a callback already exists, preserve it and append the
summary command with `;` after checking its shell semantics. Do not overwrite an
existing callback blindly. A task-level `onStatusChange` overrides the ledger
callback; such a task needs the summary command in its own callback as well.
Configuration changes apply to subsequently executed status callbacks.

Clear the callback through `config set onStatusChange ""` only if it contains no
other integration. Otherwise remove just the summary command and preserve the
original callback.

## History and write-back

Codex starts a fresh, ephemeral, non-interactive session with `workspace-write`
and approvals disabled. It inherits normal Codex configuration and authentication.
The prompt authorizes only task-summary work, not implementation or Git/remote
operations. It uses this checkout's public CLI with an explicit `BACKLOG_CWD`.

Codex searches its local `sessions` and `archived_sessions` by complete task ID;
the session index can help locate candidates. Names are not required to contain
the task ID. It must distinguish longer IDs and subtasks, and confirm the ledger
and task context before using a conversation. Ambiguous identity stops write-back.
Missing history is documented as a limitation, not invented evidence. History
storage is an implementation detail of Codex; format changes may require adapting
the prompt. This integration does not add a transcript parser or history index.

Immediately before writing, Codex is instructed to reload the task, ensure it is
still Done, preserve existing content, and use `--append-final-summary`. It must
not check acceptance criteria merely because the user moved a task to Done.
These are agent instructions, not an atomic compare-and-write guard. The script
checks the final summary for its unique run marker after Codex exits: exit zero
alone is not reported as successful write-back.

## Logs and retry

Logs append under `~/.local/state/backlog-codex-summary/<ledger-hash>/<task-id>.log`.
Directories are created with mode 0700 and logs with 0600. `Started`,
`write-back confirmed`, and `Finished` identify each run. Failure leaves Done
unchanged. Logs can contain task and conversation excerpts; keep them local.

For a deliberate manual retry, first inspect the task and its log to avoid
duplicating a partially written summary, then run from the ledger root:

```sh
cd /absolute/ledger/root
TASK_ID=TASK-123 OLD_STATUS='To Do' NEW_STATUS=Done bun /absolute/Backlog.md/scripts/backlog-codex-summary.ts
```

Concurrent launches for the same ledger and task are skipped. Locks are
maintained while the script runs and stale locks become reclaimable after 30
seconds. This is a local background process: it does not resume automatically
after a shutdown or process termination.

Optional environment overrides:

| Variable | Purpose |
| --- | --- |
| `BACKLOG_SUMMARY_LOG_DIR` | Use a dedicated private log directory for this ledger. |
| `BACKLOG_SUMMARY_CODEX` | Codex executable path; tests use a fixture executable. |
| `BACKLOG_SUMMARY_HISTORY_DIR` | Restrict history discovery to this directory, used by the real demo. |

The test script does not install or enable this integration in your existing
work ledger.
