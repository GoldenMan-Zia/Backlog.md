import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Core } from "../core/backlog.ts";
import { getTestCliPath } from "./test-cli.ts";

const cliPath = getTestCliPath();
const hookPath = resolve("scripts/backlog-codex-summary.ts");
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
let directory: string;
let environment: NodeJS.ProcessEnv;

async function cliIn(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd,
		env: { ...environment, BACKLOG_CWD: cwd },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`CLI ${args[0]} failed (${code}): ${stderr}\n${stdout}`);
	return stdout;
}

const cli = (...args: string[]) => cliIn(directory, ...args);

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(30);
	}
	throw new Error(`Timed out: ${label}`);
}

async function textOrEmpty(path: string): Promise<string> {
	return readFile(path, "utf8").catch(() => "");
}

async function task(id: string) {
	return JSON.parse(await cli("task", "view", id, "--json")).task;
}

async function createTask(status = "To Do"): Promise<string> {
	const output = await cli("task", "create", "Summary fixture", "-s", status, "--plain");
	const id = output.match(/^Task (\S+) - /m)?.[1];
	if (!id) throw new Error(`No task identity in ${output}`);
	return id;
}

async function hook(id: string, oldStatus: string, newStatus: string): Promise<number | null> {
	const child = Bun.spawn([process.execPath, hookPath], {
		cwd: directory,
		env: { ...environment, TASK_ID: id, OLD_STATUS: oldStatus, NEW_STATUS: newStatus },
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(stderr);
	return code;
}

async function finished(id: string): Promise<void> {
	await waitFor(
		async () => /Finished:/.test(await textOrEmpty(join(directory, "logs", `${id.toLowerCase()}.log`))),
		"background exit",
	);
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "backlog summary ' test-"));
	const mock = join(directory, "mock-codex");
	environment = {
		...process.env,
		BACKLOG_CWD: directory,
		BACKLOG_SUMMARY_LOG_DIR: join(directory, "logs"),
		BACKLOG_SUMMARY_CODEX: mock,
		BACKLOG_SUMMARY_HISTORY_DIR: join(directory, "history"),
	};
	await mkdir(join(directory, "history"));
	await writeFile(mock, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(directory, "mock.ts"))} "$@"\n`);
	await chmod(mock, 0o700);
	await writeFile(
		join(directory, "mock.ts"),
		`
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
const root = process.env.BACKLOG_CWD!;
const id = process.env.TASK_ID!;
const prompt = await Bun.stdin.text();
await Bun.write(join(root, "prompt.txt"), prompt);
await Bun.write(join(root, "args.json"), JSON.stringify(process.argv.slice(2)));
await appendFile(join(root, "calls"), id + "\\n");
while (!(await Bun.file(join(root, "release")).exists())) await Bun.sleep(25);
if (await Bun.file(join(root, "fail")).exists()) { console.error("fixture model failure"); process.exit(7); }
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, ${JSON.stringify(cliPath)}, ...args], {
    cwd: root, env: { ...process.env, BACKLOG_CWD: root }, stdout: "pipe", stderr: "pipe"
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(err);
  return out;
}
const current = JSON.parse(await cli("task", "view", id, "--json")).task;
if (current.status !== "Done") { console.log("Task reopened; skipped write-back"); process.exit(0); }
if (await Bun.file(join(root, "no-write")).exists()) process.exit(0);
const marker = prompt.match(/backlog-codex-summary:[a-f0-9-]+/)?.[0];
if (!marker) throw new Error("Missing write-back marker");
await cli("task", "edit", id, "--append-final-summary", "Simulated conclusion.\\n" + marker, "--plain");
console.log("Fixture wrote summary through the Backlog CLI");
`,
	);
	await cli("init", "Summary test", "--defaults", "--no-git", "--integration-mode", "none");
});

afterEach(async () => {
	// Let blocked detached fixtures exit before removing their directory.
	const demos = (await readdir(directory)).filter((name) => name.startsWith("backlog-summary-demo."));
	for (const root of [directory, ...demos.map((name) => join(directory, name))]) {
		await writeFile(join(root, "release"), "");
		await Bun.sleep(100);
		await waitFor(
			async () => !(await readdir(join(root, "logs")).catch(() => [])).some((name) => name.endsWith(".lock")),
			"fixture cleanup",
		);
	}
	await rm(directory, { recursive: true, force: true });
});

describe("local Codex completion summary", () => {
	it("sets, reads, lists and clears a callback with shell quotes through the CLI", async () => {
		const command = `${quote(process.execPath)} ${quote(hookPath)} && printf '%s' 'done'`;
		await cli("config", "set", "onStatusChange", command);
		expect((await cli("config", "get", "onStatusChange")).trim()).toBe(command);
		expect(await cli("config", "list")).toContain(command);
		const config = Bun.YAML.parse(await readFile(join(directory, "backlog", "config.yml"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(config.onStatusChange).toBe(command);
		await cli("config", "set", "onStatusChange", "");
		expect((await cli("config", "get", "onStatusChange")).trim()).toBe("");
	});

	for (const status of ["To Do", "In Progress"]) {
		it(`returns before Codex finishes after ${status} → Done and preserves the existing summary`, async () => {
			const id = await createTask(status);
			await cli("task", "edit", id, "--final-summary", "Existing human summary", "--plain");
			await cli("config", "set", "onStatusChange", `${quote(process.execPath)} ${quote(hookPath)}`);
			await cli("task", "edit", id, "-s", "Done", "--plain");
			await waitFor(async () => (await textOrEmpty(join(directory, "calls"))).includes(id), "Codex start");
			expect((await task(id)).finalSummary).toBe("Existing human summary");
			await writeFile(join(directory, "release"), "");
			await finished(id);
			const current = await task(id);
			expect(current.status).toBe("Done");
			expect(current.finalSummary).toContain("Existing human summary");
			expect(current.finalSummary).toContain("Simulated conclusion");
			expect(current.acceptanceCriteria).toEqual([]);
			const prompt = await textOrEmpty(join(directory, "prompt.txt"));
			expect(prompt).toContain(id);
			expect(prompt).toContain(directory);
			expect(prompt).toContain("不依赖会话名称");
			expect(prompt).toContain("--append-final-summary");
			expect(JSON.parse(await readFile(join(directory, "args.json"), "utf8"))).toContain("workspace-write");
		});
	}

	it("ignores Done → Done, nonterminal moves and creation without an old status", async () => {
		for (const [oldStatus, newStatus] of [
			["Done", "Done"],
			["Done", "To Do"],
			["To Do", "In Progress"],
			["", "Done"],
		]) {
			await hook("TASK-1", oldStatus ?? "", newStatus ?? "");
		}
		expect(await textOrEmpty(join(directory, "calls"))).toBe("");
	});

	it("does not trigger from a Done-column reorder or an ordinal-only edit", async () => {
		const id = await createTask("Done");
		await cli("config", "set", "onStatusChange", `${quote(process.execPath)} ${quote(hookPath)}`);
		const core = new Core(directory);
		await core.reorderTask({ taskId: id, targetStatus: "Done", orderedTaskIds: [id], autoCommit: false });
		await cli("task", "edit", id, "--ordinal", "1234", "--plain");
		expect(await textOrEmpty(join(directory, "calls"))).toBe("");
	});

	it("does not launch Codex when a status mutation fails", async () => {
		const id = await createTask();
		await cli("config", "set", "onStatusChange", `${quote(process.execPath)} ${quote(hookPath)}`);
		await expect(cli("task", "edit", id, "-s", "Unknown status", "--plain")).rejects.toThrow();
		expect((await task(id)).status).toBe("To Do");
		expect(await textOrEmpty(join(directory, "calls"))).toBe("");
	});

	it("refuses to run Codex when automatic Git commits are enabled", async () => {
		const id = await createTask("Done");
		await cli("config", "set", "autoCommit", "true");
		await hook(id, "To Do", "Done");
		await finished(id);
		expect(await textOrEmpty(join(directory, "calls"))).toBe("");
		expect(await textOrEmpty(join(directory, "logs", `${id.toLowerCase()}.log`))).toContain("Disable autoCommit");
	});

	it("prevents simultaneous Codex sessions for the same task", async () => {
		const id = await createTask("Done");
		await Promise.all([hook(id, "To Do", "Done"), hook(id, "In Progress", "Done")]);
		await waitFor(async () => (await textOrEmpty(join(directory, "calls"))).includes(id), "Codex start");
		await Bun.sleep(300);
		expect((await textOrEmpty(join(directory, "calls"))).trim().split("\n")).toEqual([id]);
		await writeFile(join(directory, "release"), "");
		await finished(id);
	});

	it("summarizes each actual transition in a batch move, excluding tasks already Done", async () => {
		const first = await createTask("To Do");
		const second = await createTask("In Progress");
		const staying = await createTask("Done");
		await cli("config", "set", "onStatusChange", `${quote(process.execPath)} ${quote(hookPath)}`);
		const move = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
import { Core } from ${JSON.stringify(resolve("src/core/backlog.ts"))};
await new Core(process.cwd()).moveTasksToStatus({
  taskIds: ${JSON.stringify([first, second, staying])}, targetStatus: "Done", autoCommit: false
});`,
			],
			{ cwd: directory, env: environment, stdout: "ignore", stderr: "pipe" },
		);
		expect(await move.exited).toBe(0);
		await waitFor(
			async () => (await textOrEmpty(join(directory, "calls"))).trim().split("\n").length === 2,
			"batch start",
		);
		expect((await textOrEmpty(join(directory, "calls"))).trim().split("\n").sort()).toEqual([first, second].sort());
		await writeFile(join(directory, "release"), "");
		await Promise.all([finished(first), finished(second)]);
		expect((await task(first)).finalSummary).toContain("Simulated conclusion");
		expect((await task(second)).finalSummary).toContain("Simulated conclusion");
		expect((await task(staying)).finalSummary).toBeNull();
	});

	it("keeps Done and logs failure, then allows manual retry", async () => {
		const id = await createTask("Done");
		await writeFile(join(directory, "fail"), "");
		await writeFile(join(directory, "release"), "");
		await hook(id, "To Do", "Done");
		await finished(id);
		expect((await task(id)).status).toBe("Done");
		expect((await task(id)).finalSummary).toBeNull();
		expect(await textOrEmpty(join(directory, "logs", `${id.toLowerCase()}.log`))).toContain("exit=7");
		await rm(join(directory, "fail"));
		await hook(id, "To Do", "Done");
		await waitFor(async () => Boolean((await task(id)).finalSummary), "retry write-back");
		await waitFor(
			async () =>
				(await textOrEmpty(join(directory, "logs", `${id.toLowerCase()}.log`))).includes("write-back confirmed"),
			"retry exit",
		);
	});

	it("does not report write-back success just because Codex exits zero", async () => {
		const id = await createTask("Done");
		await writeFile(join(directory, "no-write"), "");
		await writeFile(join(directory, "release"), "");
		await hook(id, "To Do", "Done");
		await finished(id);
		expect(await textOrEmpty(join(directory, "logs", `${id.toLowerCase()}.log`))).toContain("no summary marker");
	});

	it("skips write-back when the task has been reopened", async () => {
		const id = await createTask("Done");
		await hook(id, "To Do", "Done");
		await waitFor(async () => (await textOrEmpty(join(directory, "calls"))).includes(id), "Codex start");
		await cli("task", "edit", id, "-s", "In Progress", "--plain");
		await writeFile(join(directory, "release"), "");
		await finished(id);
		expect((await task(id)).finalSummary).toBeNull();
	});

	it("runs the user demo with a fixture model in its own disposable ledger", async () => {
		const expectPath = Bun.which("expect");
		if (!expectPath) throw new Error("Install expect to verify the user demo");
		const driver = join(directory, "demo.expect");
		await writeFile(
			driver,
			`set timeout 10
log_user 0
set env(TERM) xterm-256color
spawn bash {${resolve("scripts/test-codex-summary")}} --real
exec stty rows 32 columns 140 < $spawn_out(slave,name)
expect {
  -re {Move} {}
  eof { exit 91 }
  timeout { exit 92 }
}
sleep 0.2
send "m"
sleep 0.1
send "\\033\\133C"
sleep 0.1
send "\\033\\133C"
sleep 0.1
send "\\r"
sleep 0.3
send "q"
expect {
  eof {}
  timeout { exit 93 }
}
set result [wait]
exit [lindex $result 3]
`,
		);
		const child = Bun.spawn([expectPath, "-f", driver], {
			cwd: directory,
			env: { ...environment, TMPDIR: directory },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`Demo exited ${code}: ${stdout}\n${stderr}`);
		const name = (await readdir(directory)).find((entry) => entry.startsWith("backlog-summary-demo."));
		if (!name) throw new Error("Demo did not create a disposable ledger");
		const demo = join(directory, name);
		const id = JSON.parse(await cliIn(demo, "task", "list", "--json")).tasks[0].id;
		await waitFor(async () => (await textOrEmpty(join(demo, "calls"))).includes(id), "demo Codex start");
		const prompt = await textOrEmpty(join(demo, "prompt.txt"));
		expect(prompt).toContain(join(demo, "history"));
		expect(await readdir(join(demo, "history"))).toEqual(["sample-conversation.jsonl"]);
		await writeFile(join(demo, "release"), "");
		await waitFor(
			async () => (await textOrEmpty(join(demo, "logs", `${id.toLowerCase()}.log`))).includes("Finished:"),
			"demo exit",
		);
		const result = JSON.parse(await cliIn(demo, "task", "view", id, "--json")).task;
		expect(result.status).toBe("Done");
		expect(result.finalSummary).toContain("已有人工总结");
		expect(result.finalSummary).toContain("Simulated conclusion");
		expect(await cli("config", "get", "onStatusChange")).toBe("\n");
	});

	for (const hangup of [false, true]) {
		it(`writes after ${hangup ? "terminal hangup" : "quitting the board"} in a real terminal`, async () => {
			const expectPath = Bun.which("expect");
			if (!expectPath) throw new Error("Install expect to verify detached terminal execution");
			const id = await createTask();
			await cli("config", "set", "onStatusChange", `${quote(process.execPath)} ${quote(hookPath)}`);
			const driver = join(directory, "board.expect");
			await writeFile(
				driver,
				`set timeout 8
log_user 0
set env(TERM) xterm-256color
spawn {${process.execPath}} {${cliPath}} board
exec stty rows 32 columns 140 < $spawn_out(slave,name)
expect {
  -re {Summary fixture} {}
  timeout { exit 91 }
}
sleep 0.2
send "m"
sleep 0.1
send "\\033\\133C"
sleep 0.1
send "\\033\\133C"
sleep 0.1
send "\\r"
set deadline [expr {[clock milliseconds] + 6000}]
while {![file exists {${join(directory, "calls")}}] && [clock milliseconds] < $deadline} {
  expect -timeout 1 {
    -re {.+} {}
    timeout {}
    eof { exit 94 }
  }
}
if {![file exists {${join(directory, "calls")}}]} { exit 93 }
${
	hangup
		? `close
catch {wait}
exit 0`
		: `
send "q"
expect {
  eof {}
  timeout { exit 92 }
}
set result [wait]
exit [lindex $result 3]
`
}
`,
			);
			const terminal = Bun.spawn([expectPath, "-f", driver], {
				cwd: directory,
				env: environment,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stderr] = await Promise.all([terminal.exited, new Response(terminal.stderr).text()]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
			await waitFor(async () => (await textOrEmpty(join(directory, "calls"))).includes(id), "detached Codex start");
			expect((await task(id)).status).toBe("Done");
			expect((await task(id)).finalSummary).toBeNull();
			await writeFile(join(directory, "release"), "");
			await finished(id);
			expect((await task(id)).finalSummary).toContain("Simulated conclusion");
		});
	}
});
