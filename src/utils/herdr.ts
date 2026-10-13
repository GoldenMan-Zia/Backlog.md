import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Task } from "../types/index.ts";

export interface HerdrOptions {
	session: string;
	workspace?: string;
	cwd: string;
	onProgress?: (stage: string) => void;
	timeoutMs?: number;
}

type HerdrResponse = {
	result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
};

async function runHerdr(args: string[], timeoutMs: number): Promise<HerdrResponse> {
	const executable = Bun.which("herdr", { PATH: process.env.PATH });
	if (!executable) throw new Error("Herdr executable was not found in PATH.");
	const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (timedOut) throw new Error("Herdr handoff timed out; inspect Herdr before retrying.");
		if (exitCode !== 0) {
			let code: string | undefined;
			try {
				code = JSON.parse(stderr).error?.code;
			} catch {
				/* Non-JSON CLI errors keep their original text. */
			}
			throw Object.assign(new Error(stderr.trim() || `Herdr exited with code ${exitCode}`), { code });
		}
		return stdout.trim() ? (JSON.parse(stdout) as HerdrResponse) : {};
	} finally {
		clearTimeout(timeout);
	}
}

export async function launchTaskInHerdr(
	task: Pick<Task, "id" | "title">,
	options: HerdrOptions,
	run: (args: string[], timeoutMs: number) => Promise<HerdrResponse> = runHerdr,
): Promise<{ tabId: string; paneId: string }> {
	const isControl = (character: string) => {
		const code = character.charCodeAt(0);
		return code < 32 || (code >= 127 && code <= 159);
	};
	const hasControls = (value: string) => Array.from(value).some(isControl);
	if (!options.session.trim() || hasControls(options.session)) throw new Error("Configure a target Herdr session.");
	if (!/^[a-zA-Z0-9_.-]+$/.test(task.id)) throw new Error("Task ID is not valid for a Herdr handoff.");
	if (!isAbsolute(options.cwd) || hasControls(options.cwd)) throw new Error("Invalid working directory.");
	if (options.workspace && hasControls(options.workspace)) throw new Error("Invalid Herdr workspace.");
	const timeoutMs = options.timeoutMs ?? 75_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid handoff timeout.");
	const deadline = Date.now() + timeoutMs;
	const remaining = () => {
		const time = deadline - Date.now();
		if (time <= 0) throw new Error("Herdr handoff timed out; inspect Herdr before retrying.");
		return time;
	};
	const execute = (args: string[]) => run(args, remaining());

	const session = ["--session", options.session];
	const title = Array.from(task.title, (character) => (isControl(character) ? " " : character))
		.join("")
		.trim();
	const label = `${task.id.toLowerCase()} + ${title}`;
	options.onProgress?.("Creating Herdr tab...");
	const created = await execute([
		...session,
		"tab",
		"create",
		...(options.workspace ? ["--workspace", options.workspace] : []),
		"--cwd",
		options.cwd,
		"--label",
		label,
		"--no-focus",
	]);
	const tabId = created?.result?.tab?.tab_id;
	const paneId = created?.result?.root_pane?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string" || !tabId || !paneId) {
		throw new Error(
			`${typeof tabId === "string" && tabId ? `Herdr tab ${tabId}` : "Herdr"} did not return a tab and pane identity; inspect Herdr before retrying.`,
		);
	}

	const ledgerPath = `'${options.cwd.replaceAll("'", `'"'"'`)}'`;
	const prompt = `请从本机工作总账读取 ${task.id}，所有 Backlog 操作显式设置 BACKLOG_CWD=${ledgerPath}。先阅读 Backlog 操作指引，获取任务的描述、计划、进展和已有结果，按需查看关联任务及相关资料。结合当前实际情况，说明这项任务要解决什么、目前做到哪里、接下来有哪些工作项值得推进，以及需要我确认的问题。先与我确认本次工作范围，确认前不要实施，也不要仅因开始讨论就修改任务状态。确认后再读取目标仓库的指令、记录计划并开展工作；有实质进展时更新 task，暂停或结束前写回结果、验证依据、未完成事项和下一步。`;
	try {
		options.onProgress?.("Starting Codex...");
		const startArgs = [
			...session,
			"agent",
			"start",
			`backlog-${randomUUID().slice(0, 12)}`,
			"--kind",
			"codex",
			"--pane",
			paneId,
			"--timeout",
			String(Math.min(60_000, remaining())),
		];
		const shellDeadline = Date.now() + 5000;
		while (true) {
			try {
				await execute(startArgs);
				break;
			} catch (error) {
				// New tabs return before shell initialization finishes. Only this rejection proves
				// that no agent started, so startup timeouts and blocked agents are never retried.
				if (
					!error ||
					typeof error !== "object" ||
					!("code" in error) ||
					error.code !== "agent_pane_busy" ||
					Date.now() >= shellDeadline
				)
					throw error;
				await Bun.sleep(Math.min(150, remaining()));
			}
		}
		// This local slash command names the session without starting a model turn.
		// Ordered terminal input lets the editable task template follow without Enter.
		options.onProgress?.("Naming Codex session...");
		await execute([...session, "agent", "prompt", paneId, `/rename ${label}`]);
		// Single-line raw input leaves the message in the composer; never submit Enter here.
		options.onProgress?.("Prefilling task template...");
		await execute([...session, "pane", "send-text", paneId, prompt]);
		options.onProgress?.("Focusing Herdr tab...");
		await execute([...session, "tab", "focus", tabId]);
		remaining();
	} catch (error) {
		throw new Error(
			`Herdr tab ${tabId} was created; inspect it before retrying. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { tabId, paneId };
}
