import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTaskInHerdr } from "../utils/herdr.ts";

const task = { id: "TASK-35", title: "绩效：ngsafe 适配 Rocky Linux 9" };
const options = { session: "default", cwd: "/Users/test/git", workspace: "wE" };

function recordingRunner(failAt = -1) {
	const commands: string[][] = [];
	return {
		commands,
		run: async (args: string[]) => {
			commands.push(args);
			if (commands.length === failAt) throw new Error("agent_not_ready");
			return {
				result: { tab: { tab_id: "wE:t9" }, root_pane: { pane_id: "wE:p9" } },
			};
		},
	};
}

describe("Herdr task handoff", () => {
	it("reports actual handoff stages in command order", async () => {
		const events: string[] = [];
		const { run } = recordingRunner();
		await launchTaskInHerdr(task, { ...options, onProgress: (stage) => events.push(stage) }, async (args) => {
			events.push(`${args[2]} ${args[3]}`);
			return run(args);
		});
		expect(events).toEqual([
			"Creating Herdr tab...",
			"tab create",
			"Starting Codex...",
			"agent start",
			"Naming Codex session...",
			"agent prompt",
			"Prefilling task template...",
			"pane send-text",
			"Focusing Herdr tab...",
			"tab focus",
		]);
	});

	it("enforces a total deadline and preserves the identity of a partially created tab", async () => {
		const directory = await mkdtemp(join(tmpdir(), "backlog-herdr-deadline-"));
		const oldPath = process.env.PATH;
		try {
			const binary = join(directory, "herdr");
			await Bun.write(
				binary,
				`#!/bin/sh\nif [ "$3" = tab ] && [ "$4" = create ]; then\n  printf '%s' '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p2"}}}'\nelse\n  exec sleep 2\nfi\n`,
			);
			await chmod(binary, 0o755);
			process.env.PATH = `${directory}:${oldPath}`;
			const started = Date.now();
			await expect(launchTaskInHerdr(task, { ...options, timeoutMs: 600 })).rejects.toThrow(/w1:t2.*timed out/);
			expect(Date.now() - started).toBeLessThan(1800);
		} finally {
			process.env.PATH = oldPath;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not paste or focus after exhausting the overall deadline", async () => {
		const { commands, run } = recordingRunner();
		await expect(
			launchTaskInHerdr(task, { ...options, timeoutMs: 20 }, async (args) => {
				const response = await run(args);
				if (args[2] === "agent") await Bun.sleep(30);
				return response;
			}),
		).rejects.toThrow("timed out");
		expect(commands).toHaveLength(2);
	});

	it("accepts empty success output from non-creation Herdr commands", async () => {
		const directory = await mkdtemp(join(tmpdir(), "backlog-herdr-test-"));
		const oldPath = process.env.PATH;
		try {
			const binary = join(directory, "herdr");
			await Bun.write(
				binary,
				`#!/bin/sh\nif [ "$3" = tab ] && [ "$4" = create ]; then\n  printf '%s' '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p2"}}}'\nfi\n`,
			);
			await chmod(binary, 0o755);
			process.env.PATH = `${directory}:${oldPath}`;
			expect(Bun.which("herdr", { PATH: process.env.PATH })).toBe(binary);
			await expect(launchTaskInHerdr(task, { ...options, session: "backlog-unit-fixture" })).resolves.toEqual({
				tabId: "w1:t2",
				paneId: "w1:p2",
			});
		} finally {
			process.env.PATH = oldPath;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("creates a named tab in the explicit session, starts Codex, and prefills without Enter", async () => {
		const { commands, run } = recordingRunner();
		const result = await launchTaskInHerdr(task, options, run);
		expect(result).toEqual({ tabId: "wE:t9", paneId: "wE:p9" });
		expect(commands[0]).toEqual([
			"--session",
			"default",
			"tab",
			"create",
			"--workspace",
			"wE",
			"--cwd",
			options.cwd,
			"--label",
			`task-35 + ${task.title}`,
			"--no-focus",
		]);
		expect(commands[1]?.slice(0, 4)).toEqual(["--session", "default", "agent", "start"]);
		expect(commands[1]).toContain("codex");
		expect(commands[1]).toContain("wE:p9");
		expect(commands[2]).toEqual([
			"--session",
			"default",
			"agent",
			"prompt",
			"wE:p9",
			`/rename task-35 + ${task.title}`,
		]);
		expect(commands[3]?.slice(0, 5)).toEqual(["--session", "default", "pane", "send-text", "wE:p9"]);
		const prompt = commands[3]?.[5] ?? "";
		expect(prompt).toContain("TASK-35");
		expect(prompt).toContain("BACKLOG_CWD='/Users/test/git'");
		expect(prompt).toContain("确认前不要实施");
		expect(prompt).toContain("写回结果、验证依据");
		expect(
			Array.from(prompt).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
		).toBe(false);
		expect(commands[4]).toEqual(["--session", "default", "tab", "focus", "wE:t9"]);
		expect(commands).toHaveLength(5);
		expect(commands.flat()).not.toContain("send-keys");
		expect(commands.flat()).not.toContain("close");
		expect(task).toEqual({ id: "TASK-35", title: "绩效：ngsafe 适配 Rocky Linux 9" });
	});

	it("keeps titles as data and quotes the ledger path, without terminal controls", async () => {
		const { commands, run } = recordingRunner();
		await launchTaskInHerdr(
			{ ...task, title: "title $(touch /tmp/never) `command`\nnext\x1b" },
			{ session: "work", cwd: "/Users/test/it's work" },
			run,
		);
		expect(commands[0]).toContain("task-35 + title $(touch /tmp/never) `command` next");
		expect(commands[2]?.[5]).toBe("/rename task-35 + title $(touch /tmp/never) `command` next");
		expect(commands[3]?.[5]).toContain("BACKLOG_CWD='/Users/test/it'\"'\"'s work'");
		expect(commands[3]?.[5]).not.toContain("touch");
	});

	it("rejects a missing session or unsafe task identity before creating anything", async () => {
		const { commands, run } = recordingRunner();
		await expect(launchTaskInHerdr(task, { ...options, session: "" }, run)).rejects.toThrow("session");
		await expect(launchTaskInHerdr({ ...task, id: "TASK-35\nenter" }, options, run)).rejects.toThrow("Task ID");
		await expect(launchTaskInHerdr(task, { ...options, cwd: "/git\nenter" }, run)).rejects.toThrow("directory");
		await expect(launchTaskInHerdr(task, { ...options, timeoutMs: 0 }, run)).rejects.toThrow("timeout");
		expect(commands).toHaveLength(0);
	});

	it("does not paste into a blocked agent, retry, or close a partially created tab", async () => {
		const { commands, run } = recordingRunner(2);
		await expect(launchTaskInHerdr(task, options, run)).rejects.toThrow("wE:t9");
		expect(commands).toHaveLength(2);
	});

	it("does not prefill or focus when the rename command fails", async () => {
		const { commands, run } = recordingRunner(3);
		await expect(launchTaskInHerdr(task, options, run)).rejects.toThrow("wE:t9");
		expect(commands).toHaveLength(3);
		expect(commands[2]?.[3]).toBe("prompt");
	});

	it("does not guess missing pane identities", async () => {
		const commands: string[][] = [];
		await expect(
			launchTaskInHerdr(task, options, async (args) => {
				commands.push(args);
				return { result: { tab: { tab_id: "wE:t9" } } };
			}),
		).rejects.toThrow("pane");
		expect(commands).toHaveLength(1);
	});

	it("waits for a newly created shell without creating a second tab", async () => {
		const { commands, run } = recordingRunner();
		let starts = 0;
		await launchTaskInHerdr(task, options, async (args) => {
			if (args[2] === "agent" && starts++ === 0) {
				commands.push(args);
				throw Object.assign(new Error("shell is initializing"), { code: "agent_pane_busy" });
			}
			return run(args);
		});
		expect(commands.filter((args) => args[2] === "tab" && args[3] === "create")).toHaveLength(1);
		expect(commands.filter((args) => args[2] === "agent" && args[3] === "start")).toHaveLength(2);
		expect(commands.filter((args) => args[3] === "send-text")).toHaveLength(1);
	});
});
