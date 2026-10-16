import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { Task } from "../types/index.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

const EXPECT_PATH = Bun.which("expect");
const itInteractive = process.env.RUN_INTERACTIVE_TUI_TESTS === "1" && EXPECT_PATH ? it : it.skip;

describe("related task navigation with real PTY keys", () => {
	itInteractive(
		"navigates hidden tasks, restores visible scroll, handles errors and watches external edits",
		async () => {
			const root = createUniqueTestDir("board-related-pty");
			const core = new Core(root);
			const transcriptDir = join(process.cwd(), "tmp", "tui-interactive-transcripts");
			await mkdir(transcriptDir, { recursive: true });
			const transcript = join(transcriptDir, `related-tasks-${Date.now()}.log`);
			const parent: Task = {
				id: "TASK-1",
				title: "PTY Parent",
				status: "To Do",
				assignee: [],
				labels: [],
				dependencies: [],
				createdDate: "2026-10-12",
				references: ["TASK-1.1", "TASK-99", "TASK-8"],
				description: Array.from({ length: 100 }, (_, i) => `PARENT-MARKER-${i}`).join("\n"),
			};
			const child = {
				...parent,
				id: "TASK-1.1",
				title: "PTY Child",
				parentTaskId: parent.id,
				references: [],
				description: Array.from({ length: 100 }, (_, i) => `CHILD-MARKER-${i}`).join("\n"),
			};
			const grandchild = {
				...child,
				id: "TASK-1.1.1",
				title: "PTY Grandchild",
				parentTaskId: child.id,
				description: "GRANDCHILD-MARKER",
			};
			try {
				await initializeFilesystemTestProject(core, "Related PTY");
				const parentPath = await core.filesystem.saveTask(parent);
				const childPath = await core.filesystem.saveTask(child);
				const grandchildPath = await core.filesystem.saveTask(grandchild);
				for (const id of ["TASK-8", "TASK-08"]) {
					await Bun.write(
						join(core.filesystem.tasksDir, `${id.toLowerCase()} - Collision.md`),
						serializeTask({ ...parent, id, title: "Collision", references: [] }),
					);
				}
				const beforeParent = await Bun.file(parentPath).text();
				const beforeGrandchild = await Bun.file(grandchildPath).text();
				const boardPath = join(process.cwd(), "src/ui/board.ts");
				const runner = join(root, "runner.ts");
				await Bun.write(
					runner,
					`
import { Core } from ${JSON.stringify(join(process.cwd(), "src/core/backlog.ts"))};
import { renderBoardTui } from ${JSON.stringify(boardPath)};
import { watchTasks } from ${JSON.stringify(join(process.cwd(), "src/utils/task-watcher.ts"))};
import { keepTuiInputAlive } from ${JSON.stringify(join(process.cwd(), "src/ui/tui.ts"))};
import type { Task } from ${JSON.stringify(join(process.cwd(), "src/types/index.ts"))};
const core = new Core(${JSON.stringify(root)}, { enableWatchers: true });
const tasks = await core.filesystem.listTasks();
const parent = tasks.find(t => t.id === "TASK-1");
if (!parent) throw new Error("Missing PTY parent fixture");
const statuses = ["To Do", "In Progress", "Done"];
const release = keepTuiInputAlive();
let updater: ((tasks: Task[], statuses: string[]) => void) | undefined;
const watcher = watchTasks(core, { onTaskChanged: () => updater?.([parent], statuses) }, tasks);
try {
  // Only the parent belongs to this board corpus; the other details must resolve through Core.
  await renderBoardTui([parent], statuses, "horizontal", 20, { core, subscribeUpdates: update => { updater = update; } });
} finally { watcher.stop(); core.disposeContentStore(); release(); }
console.log("PTY-COMPLETED");
`,
				);
				const updater = join(root, "update.ts");
				await Bun.write(
					updater,
					`
import { Core } from ${JSON.stringify(join(process.cwd(), "src/core/backlog.ts"))};
const core = new Core(${JSON.stringify(root)});
const task = await core.getTask("TASK-1.1");
if (!task) throw new Error("Missing PTY child fixture");
const description = task.description === "EXTERNAL-CHILD-UPDATE" ? "SECOND-CHILD-UPDATE" : "EXTERNAL-CHILD-UPDATE";
await core.filesystem.saveTask({ ...task, description, status: description === "EXTERNAL-CHILD-UPDATE" ? "In Progress" : "Done" });
core.disposeContentStore();
`,
				);
				const script = join(root, "navigation.expect");
				await Bun.write(
					script,
					`
set timeout 15
log_user 0
log_file -a {${transcript}}
set env(TERM) {xterm-256color}
set env(LANG) {en_US.UTF-8}
set env(BACKLOG_CWD) {/Users/goldenman/git}
spawn {${process.execPath}} {${runner}}
exec stty rows 40 columns 120 < $spawn_out(slave,name)
proc see {pattern} {
  expect {
    -re $pattern {}
    timeout { puts stderr "Missing terminal output: $pattern"; exit 91 }
    eof { puts stderr "Early EOF while waiting for: $pattern"; exit 92 }
  }
  puts "Matched: $pattern"
  # Rendering can precede the async handler's focus/pending-state cleanup.
  after 100
}
see {PTY Parent}
send "\\r"
see {PARENT-MARKER-0}
send "\\033\\[6~"
see {PARENT-MARKER-30}
send "r"
see {Related.*Tasks}
see {To.Do.*TASK-1.1 - PTY Child}
send "\\r"
see {CHILD-MARKER-0}
send "\\033\\[6~"
see {CHILD-MARKER-30}
send "r"
see {Related.*Tasks}
send "j\\r"
see {GRANDCHILD-MARKER}
send "\\033"
see {CHILD-MARKER-30}
sleep 0.3
send "\\033"
see {PARENT-MARKER-30}
sleep 0.3
send "r"
see {Related.*Tasks}
send "j\\r"
see {TASK-99.*not.*found}
send "r"
see {Related.*Tasks}
send "jj\\r"
see {Ambiguous.*TASK-8.*doctor}
send "r"
see {Related.*Tasks}
send "\\r"
see {CHILD-MARKER-0}
exec {${process.execPath}} {${updater}}
see {EXTERNAL-CHILD-UPDATE}
send "r"
see {Related.*Tasks}
exec {${process.execPath}} {${updater}}
sleep 0.5
# The picker must keep the keyboard during the watcher event.
send "j\\r"
see {GRANDCHILD-MARKER}
send "\\033"
see {SECOND-CHILD-UPDATE}
sleep 0.3
send "\\033"
see {PARENT-MARKER-30}
sleep 0.3
send "r"
see {Related.*Tasks}
see {Done.*TASK-1.1 - PTY Child}
send "\\r"
see {SECOND-CHILD-UPDATE}
send "\\033"
see {PARENT-MARKER-30}
sleep 0.3
send "\\033"
see {PTY Parent}
send "\\r"
see {PARENT-MARKER-0}
send "\\033"
see {PTY Parent}
send "q"
see {PTY-COMPLETED}
expect {
  eof {}
  timeout { puts stderr "Board process did not exit"; exit 93 }
}
exit 0
`,
				);
				const processHandle = Bun.spawn([EXPECT_PATH as string, "-f", script], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, BACKLOG_CWD: "/Users/goldenman/git" },
				});
				const [stdout, stderr, code] = await Promise.all([
					new Response(processHandle.stdout).text(),
					new Response(processHandle.stderr).text(),
					processHandle.exited,
				]);
				if (code !== 0)
					throw new Error(`PTY navigation failed (${code}). ${stdout} ${stderr}\nTranscript: ${transcript}`);
				expect(code).toBe(0);
				expect(await Bun.file(parentPath).text()).toBe(beforeParent);
				expect(await Bun.file(grandchildPath).text()).toBe(beforeGrandchild);
				expect(await Bun.file(childPath).text()).toContain("SECOND-CHILD-UPDATE");
			} finally {
				core.disposeContentStore();
				await safeCleanup(root);
			}
		},
		60_000,
	);
});
