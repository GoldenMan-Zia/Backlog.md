# Local Herdr handoff

Run Herdr in one terminal tab and the board in another:

```sh
herdr
backlog-herdr-board
```

Select a task in the board, or open its details with Enter, then press **W**.
The board creates a tab in the configured Herdr session, starts Codex, fills its
input with the task discussion template, and selects the new Herdr tab. Switch
back to the terminal running Herdr to edit the message and press Enter yourself.
The board stays open. No task status changes as a result of the handoff.

While opening the session, a centered loading box shows the task ID and the
current step: creating the tab, starting Codex, naming the session, prefilling the template, and
focusing the Herdr tab. Board keyboard and mouse actions are locked until the
handoff succeeds or fails. The operation has a 75-second total timeout.

On success, the board unlocks and shows a five-second notice with the tab ID and
the reminder that the template was not submitted. On failure, the board unlocks
and opens an error dialog. Enter or Esc closes that dialog without closing the
task details or exiting the board; long errors can be scrolled.

The tab and saved Codex session are both named `task-35 + <task title>`.
After Codex is ready, the handoff submits its local `/rename` command before
prefilling the task template. Only the naming command is submitted; the task
template stays editable and no model turn starts. This requires a Codex CLI
version that supports `/rename`.
Codex may not make a fresh, empty session resumable until its first model turn;
the handoff does not submit the template just to create saved history.

Codex reads the task through the CLI
using the explicit ledger root in the template, discusses scope before making
changes, and is instructed to record plans, progress, evidence, and next steps
through the Backlog CLI. These are agent instructions, not an automatic completion
hook. Backlog does not monitor or manage the ongoing Codex session.

## Target session and workspace

The installed local launcher uses the work ledger at `/Users/goldenman/git` and
the existing `default` Herdr session. To target a different session or workspace:

```sh
backlog-herdr-board --herdr-session work --herdr-workspace w1
```

Use actual IDs returned by Herdr. Without a workspace option, Herdr creates the
tab in that session's active workspace. The session needs a running server and
an available workspace; the board does not start or restart a Herdr server.

Environment defaults are also supported:

```sh
BACKLOG_HERDR_SESSION=work backlog-herdr-board
```

The underlying CLI accepts the same options on `board` and `board view`:

```sh
BACKLOG_CWD=/Users/goldenman/git bun /Users/goldenman/git/Backlog.md/src/cli.ts board --herdr-session default
```

The first version starts a fresh Codex session in the ledger's project root.
The discussion determines the actual repository before implementation; it does
not guess a repository from labels or references. Codex uses the user's existing
configuration. No prompt is passed as a Codex startup argument, because that
would begin a turn instead of leaving an editable draft.

## Failure and retry

Repeated W presses are ignored while a launch is pending. The board displays
startup failures. If a tab was created before an error, its ID is included in
the message: inspect that tab before retrying. The board never automatically
closes a partially started agent or resubmits its input. Missing executable,
unavailable session, invalid workspace, and Codex startup dialogs require fixing
the reported condition before another handoff.

The single-line template has no control characters or newlines. It is sent with
`pane send-text`, without Enter. Titles and paths are passed as process arguments,
not interpolated into shell commands.

## Local installation

The launcher runs the source with the installed Bun runtime. This is the locally
verified execution path. The normal installed `backlog` command remains available.

Dependencies are installed in `/Users/goldenman/git/Backlog.md/node_modules`.
After editing the source, the launcher uses the change on its next run.

## Verification

Automated terminal tests use a fixture Herdr CLI; they do not contact or change
the user's Herdr session. On 2026-10-12, the user provided a success-notice
screenshot from a real Herdr/Codex handoff and confirmed that the test succeeded.
