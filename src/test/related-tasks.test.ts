import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import blessed from "neo-neo-bblessed";
import { Core } from "../core/backlog.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { Task } from "../types/index.ts";
import { loadRelatedTaskChoices } from "../ui/related-tasks.ts";
import { AmbiguousTaskIdError } from "../utils/task-path.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

const { stripTags } = blessed.helpers;

const task: Task = {
	id: "BACK-35",
	title: "Parent",
	status: "To Do",
	assignee: [],
	createdDate: "2026-10-12",
	labels: [],
	dependencies: [],
};

describe("related task choices", () => {
	it("merges references, parent and native subtasks by canonical identity", async () => {
		const source = {
			...task,
			references: [
				" back-035.01 ",
				"BACK-35.1",
				"BACK-35",
				"/tmp/task-9",
				"https://example.com/BACK-9",
				"notes.md",
				"docs-guide",
			],
			parentTaskId: "BACK-3",
			subtasks: ["BACK-35.1", "BACK-35.2"],
		};
		const core = {
			getTaskWithSubtasks: async () => source,
			getTask: async (id: string) => ({ ...task, id, title: `Title ${id}` }),
		} as unknown as Core;
		const choices = await loadRelatedTaskChoices(core, task);
		expect(choices.map((choice) => choice.value)).toEqual(["BACK-35.1", "BACK-3", "BACK-35.2"]);
		expect(stripTags(choices[0]?.label)).toBe("[○ To Do] BACK-35.1 - Title BACK-35.1");
	});

	it("shows each target's status before its ID, including custom statuses", async () => {
		const statuses = ["To Do", "In Progress", "Done", "Awaiting approval"];
		const ids = statuses.map((_, index) => `BACK-35.${index + 1}`);
		const core = {
			getTaskWithSubtasks: async () => ({ ...task, subtasks: ids }),
			getTask: async (id: string) => ({ ...task, id, status: statuses[ids.indexOf(id)], title: "Child" }),
		} as unknown as Core;
		expect((await loadRelatedTaskChoices(core, task)).map((choice) => stripTags(choice.label))).toEqual([
			"[○ To Do] BACK-35.1 - Child",
			"[◒ In Progress] BACK-35.2 - Child",
			"[✔ Done] BACK-35.3 - Child",
			"[○ Awaiting approval] BACK-35.4 - Child",
		]);
	});

	it("uses the source prefix for unprefixed numeric references", async () => {
		const core = {
			getTaskWithSubtasks: async () => ({ ...task, references: ["35.1", "BACK-35.01"] }),
			getTask: async (id: string) => ({ ...task, id }),
		} as unknown as Core;
		expect((await loadRelatedTaskChoices(core, task)).map((choice) => choice.value)).toEqual(["BACK-35.1"]);
	});

	it("keeps unavailable targets selectable with a readable warning", async () => {
		const core = {
			getTaskWithSubtasks: async () => ({ ...task, references: ["TASK-9", "TASK-10", "TASK-11"] }),
			getTask: async (id: string) => {
				if (id === "TASK-10") throw new AmbiguousTaskIdError(id, ["a.md", "b.md"]);
				if (id === "TASK-11") throw new Error("Unreadable");
				return null;
			},
		} as unknown as Core;
		const choices = await loadRelatedTaskChoices(core, task);
		expect(choices.map((choice) => choice.label)).toEqual([
			"TASK-9 - Not found",
			"TASK-10 - Ambiguous ID",
			"TASK-11 - Could not read task",
		]);
	});

	it("does not use a stale snapshot when the source task disappeared or is ambiguous", async () => {
		const core = { getTaskWithSubtasks: async () => null } as unknown as Core;
		await expect(loadRelatedTaskChoices(core, task)).rejects.toThrow("BACK-35 not found");
		core.getTaskWithSubtasks = async () => {
			throw new AmbiguousTaskIdError(task.id, ["a.md", "b.md"]);
		};
		await expect(loadRelatedTaskChoices(core, task)).rejects.toThrow("ambiguous");
	});
});

describe("related tasks through real Core identity resolution", () => {
	let root: string;
	let core: Core;
	const parent = { ...task, id: "TASK-35" };
	const child = { ...task, id: "TASK-35.1", parentTaskId: parent.id, title: "Native child" };
	beforeEach(async () => {
		root = createUniqueTestDir("related-tasks");
		core = new Core(root);
		await initializeFilesystemTestProject(core, "Related tasks");
		await core.filesystem.saveTask(parent);
		await core.filesystem.saveTask(child);
	});
	afterEach(async () => {
		core.disposeContentStore();
		await safeCleanup(root);
	});

	it("discovers native children without references and resolves their parent", async () => {
		const children = await loadRelatedTaskChoices(core, parent);
		expect(children.map((choice) => ({ ...choice, label: stripTags(choice.label) }))).toEqual([
			{ value: child.id, label: `[○ To Do] ${child.id} - Native child` },
		]);
		const parents = await loadRelatedTaskChoices(core, child);
		expect(parents.map((choice) => ({ ...choice, label: stripTags(choice.label) }))).toEqual([
			{ value: parent.id, label: `[○ To Do] ${parent.id} - Parent` },
		]);
	});

	it("reads the latest child status when reopening the list without changing task files", async () => {
		expect(stripTags((await loadRelatedTaskChoices(core, parent))[0]?.label)).toStartWith("[○ To Do]");
		const path = await core.filesystem.saveTask({ ...child, status: "In Progress" });
		const before = await Bun.file(path).text();
		expect(stripTags((await loadRelatedTaskChoices(core, parent))[0]?.label)).toStartWith("[◒ In Progress]");
		expect(await Bun.file(path).text()).toBe(before);
	});

	it("does not pick a task when canonical IDs collide on disk", async () => {
		// saveTask updates an existing canonical identity, so create the corrupt duplicate directly.
		await Bun.write(
			join(core.filesystem.tasksDir, "task-035.01 - Conflicting child.md"),
			serializeTask({ ...child, id: "TASK-035.01", title: "Conflicting child" }),
		);
		expect(await loadRelatedTaskChoices(core, parent)).toEqual([
			{ value: child.id, label: `${child.id} - Ambiguous ID` },
		]);
		await expect(core.getTaskWithSubtasks(child.id)).rejects.toBeInstanceOf(AmbiguousTaskIdError);
	});
});
