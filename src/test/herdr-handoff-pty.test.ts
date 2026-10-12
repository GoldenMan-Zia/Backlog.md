import { describe, expect, it } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { getTestCliPath } from "./test-cli.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

const expectPath = Bun.which("expect");
const cliPath = process.env.TUI_TEST_CLI_PATH?.trim() || getTestCliPath();
const cliRuntime = process.env.TUI_TEST_CLI_RUNTIME?.trim() ?? "bun";
const interactive = process.env.RUN_INTERACTIVE_TUI_TESTS === "1" && expectPath && process.platform !== "win32";
const itInteractive = interactive ? it : it.skip;

describe("Herdr handoff in a real terminal with a fixture CLI", () => {
	for (const fail of [false, true]) {
		itInteractive(
			`locks input and restores the detail after ${fail ? "failure" : "success"}`,
			async () => {
				const directory = createUniqueTestDir("herdr-handoff-pty");
				await mkdir(directory, { recursive: true });
				try {
					const core = new Core(directory);
					await initializeTestProject(core, "Handoff PTY");
					const config = await core.fs.loadConfig();
					if (!config) throw new Error("Missing fixture config");
					await core.fs.saveConfig({ ...config, remoteOperations: false, checkActiveBranches: false });
					await core.createTask(
						{
							id: "task-1",
							title: "Handoff PTY task",
							status: "To Do",
							createdDate: "2026-10-12",
							assignee: [],
							labels: [],
							dependencies: [],
							description: "PTY-BODY",
							rawContent: "",
						},
						false,
					);
					const taskPath = (await core.fs.listTasks())[0]?.filePath;
					if (!taskPath) throw new Error("Missing fixture task");
					const original = await readFile(taskPath);
					const bin = join(directory, "bin");
					await mkdir(bin);
					const calls = join(directory, "herdr-calls.log");
					const gate = join(directory, "release-agent-start");
					await writeFile(
						join(bin, "herdr"),
						`#!/bin/sh
printf '%s\\n' "$3 $4" >> '${calls}'
if [ "$3 $4" = 'tab create' ]; then
  printf '%s' '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p2"}}}'
elif [ "$3 $4" = 'agent start' ]; then
  count=0
  while [ ! -f '${gate}' ] && [ "$count" -lt 200 ]; do
    sleep 0.05
    count=$((count + 1))
  done
  ${fail ? "printf '%s' 'fixture_start_failed' >&2; exit 1" : ":"}
elif [ "$3 $4" = 'pane send-text' ]; then
  sleep 0.4
fi
`,
					);
					await chmod(join(bin, "herdr"), 0o755);
					const script = join(directory, "handoff.expect");
					const transcript = join(directory, "transcript.log");
					await writeFile(
						script,
						`set timeout 15
log_user 0
log_file -a {${transcript}}
set env(TERM) xterm-256color
set env(LANG) en_US.UTF-8
spawn ${cliRuntime ? `{${cliRuntime}} ` : ""}{${cliPath}} board --herdr-session fixture
exec stty rows 32 columns 120 < $spawn_out(slave,name)
expect {
  -re {Handoff PTY task} {}
  timeout { exit 91 }
}
send "\\r"
expect {
  -re {PTY-BODY} {}
  timeout { exit 92 }
}
sleep 0.2
send "w"
expect {
  -re {Starting Codex} {}
  timeout { exit 93 }
}
# These keys must be discarded, not queued or delivered to the detail or board.
send "wq\\t\\033"
sleep 0.3
exec touch {${gate}}
expect {
  -re {${fail ? "fixture_start_failed" : "submitted\\."}} {}
  eof { exit 94 }
  timeout { exit 95 }
}
${fail ? 'send "\\r"\nsleep 0.2' : ""}
send "q"
sleep 0.3
send "q"
expect {
  eof {}
  timeout { exit 96 }
}
exit 0
`,
					);
					const child = Bun.spawn([expectPath as string, "-f", script], {
						cwd: directory,
						env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKLOG_CWD: directory },
						stdout: "pipe",
						stderr: "pipe",
					});
					const [stdout, stderr, exit] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					if (exit !== 0)
						throw new Error(`PTY failed (${exit}): ${stdout}\n${stderr}\n${await readFile(transcript, "utf8")}`);
					const commands = (await readFile(calls, "utf8")).trim().split("\n");
					expect(commands).toEqual(
						fail ? ["tab create", "agent start"] : ["tab create", "agent start", "pane send-text", "tab focus"],
					);
					expect(await readFile(taskPath)).toEqual(original);
				} finally {
					await safeCleanup(directory);
				}
			},
			30_000,
		);
	}
});
