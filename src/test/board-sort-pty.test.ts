import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { getTestCliPath } from "./test-cli.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

const expectPath = Bun.which("expect");
const cliPath = process.env.TUI_TEST_CLI_PATH?.trim() || getTestCliPath();
const runtime = process.env.TUI_TEST_CLI_RUNTIME?.trim() ?? "bun";
const itInteractive =
	process.env.RUN_INTERACTIVE_TUI_TESTS === "1" && expectPath && process.platform !== "win32" ? it : it.skip;

describe("board display sorting in a real terminal", () => {
	for (const initialSort of ["manual", "updated"] as const) {
		itInteractive(
			`starts in ${initialSort} order and switches without changing task files`,
			async () => {
				const directory = createUniqueTestDir("board-sort-pty");
				await mkdir(directory, { recursive: true });
				try {
					const core = new Core(directory);
					await initializeFilesystemTestProject(core, "Board sort PTY");
					for (let id = 1; id <= 3; id++) {
						await core.createTask(
							{
								id: `task-${id}`,
								title: `Sort fixture ${id}`,
								status: "To Do",
								assignee: [],
								labels: [],
								dependencies: [],
								createdDate: "2026-01-01",
								updatedDate: `2026-01-0${id} 10:00`,
								ordinal: id * 1000,
								description: `SORT-BODY-${id}`,
							},
							false,
						);
					}
					const files = await Promise.all(
						(await core.fs.listTasks()).map(async (task) => {
							if (!task.filePath) throw new Error("Missing fixture task path");
							return { path: task.filePath, content: await readFile(task.filePath) };
						}),
					);
					const script = join(directory, "sort.expect");
					const transcript = join(directory, "transcript.log");
					const first = initialSort === "manual" ? 1 : 3;
					const other = initialSort === "manual" ? 3 : 1;
					await writeFile(
						script,
						`set timeout 15
log_user 0
log_file -a {${transcript}}
set env(TERM) xterm-256color
set env(LANG) en_US.UTF-8
spawn ${runtime ? `{${runtime}} ` : ""}{${cliPath}} board --sort ${initialSort}
exec stty rows 32 columns 120 < $spawn_out(slave,name)
expect {
  -re {Sort fixture} {}
  timeout { exit 91 }
}
sleep 0.2
send "\\r"
expect {
  -re {SORT-BODY-${first}} {}
  timeout { exit 92 }
}
sleep 0.2
send "q"
sleep 0.2
send "s"
sleep 0.2
# The selected task identity must survive the sort toggle.
send "\\r"
expect {
  -re {SORT-BODY-${first}} {}
  timeout { exit 93 }
}
sleep 0.2
send "q"
sleep 0.2
send "\\033\\[H"
sleep 0.2
send "\\r"
expect {
  -re {SORT-BODY-${other}} {}
  timeout { exit 94 }
}
sleep 0.2
send "q"
sleep 0.2
send "\\t"
sleep 0.4
send "\\t"
sleep 0.4
send "\\033\\[H"
sleep 0.2
send "\\r"
expect {
  -re {SORT-BODY-${other}} {}
  timeout { exit 96 }
}
sleep 0.2
send "q"
sleep 0.2
send "q"
expect {
  eof {}
  timeout { exit 95 }
}
exit 0
`,
					);
					const child = Bun.spawn([expectPath as string, "-f", script], {
						cwd: directory,
						env: { ...process.env, BACKLOG_CWD: directory },
						stdout: "pipe",
						stderr: "pipe",
					});
					const [stdout, stderr, exit] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					if (exit !== 0)
						throw new Error(`Sort PTY failed (${exit}): ${stdout}\n${stderr}\n${await readFile(transcript, "utf8")}`);
					for (const file of files) expect(await readFile(file.path)).toEqual(file.content);
				} finally {
					await safeCleanup(directory);
				}
			},
			30_000,
		);
	}
});
