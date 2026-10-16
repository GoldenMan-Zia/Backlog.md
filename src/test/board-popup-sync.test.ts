import { describe, expect, it } from "bun:test";
import type { ScreenInterface } from "neo-neo-bblessed";
import type { Core, TuiTaskEditResult } from "../core/backlog.ts";
import type { Task } from "../types/index.ts";
import { renderBoardTui } from "../ui/board.ts";
import { createScreen } from "../ui/tui.ts";
import { AmbiguousTaskIdError } from "../utils/task-path.ts";
import { attachSubtaskSummaries } from "../utils/task-subtasks.ts";
import { withTimeout } from "./test-utils.ts";

type EmittingWidget = {
	emit: (event: string, ch?: string, key?: { name: string; full: string; shift?: boolean }) => boolean;
};
type TestWidget = {
	type?: string;
	children?: TestWidget[];
	getContent?: () => string;
	childBase?: number;
	setScroll?: (offset: number) => void;
	selected?: number;
} & EmittingWidget;

const BOARD_STATUSES = ["To Do", "In Progress", "Done"];
const OPEN_TASK_ID = "TASK-1";

function createTask(overrides: Partial<Task> = {}): Task {
	return {
		id: OPEN_TASK_ID,
		title: "Popup task",
		status: "To Do",
		assignee: [],
		createdDate: "2025-01-01",
		labels: [],
		dependencies: [],
		description: "ORIGINAL-BODY",
		...overrides,
	};
}

const OTHER_TASK = createTask({ id: "TASK-2", title: "Other task", status: "Done", description: "OTHER-BODY" });

function pressKey(widget: EmittingWidget | undefined, full: string, name = full.replace(/^S-/, "")): void {
	if (!widget) throw new Error(`No widget to receive key ${full}`);
	const key = { name, full, shift: full.startsWith("S-") };
	widget.emit("keypress", "", key);
	widget.emit(`key ${full}`, "", key);
}

function collectWidgets(root: TestWidget): TestWidget[] {
	const widgets: TestWidget[] = [];
	const visit = (node: TestWidget) => {
		for (const child of node.children ?? []) {
			widgets.push(child);
			visit(child);
		}
	};
	visit(root);
	return widgets;
}

/**
 * The popup body is the only widget rendering a task's checklists, so its presence says the
 * popup is open and its identity says whether the board rebuilt it.
 */
function findPopupBody(screen: ScreenInterface): TestWidget | undefined {
	return collectWidgets(screen as unknown as TestWidget).find((widget) =>
		widget.getContent?.().includes("Acceptance Criteria"),
	);
}

function screenText(screen: ScreenInterface): string {
	return collectWidgets(screen as unknown as TestWidget)
		.map((widget) => widget.getContent?.() ?? "")
		.join("\n");
}

async function withBoardPopup(
	options: {
		onTaskLaunch?: (task: Task, onProgress: (stage: string) => void) => Promise<{ tabId: string }>;
		openPopup?: boolean;
		editTaskInTui?: (id: string) => Promise<TuiTaskEditResult>;
		completeTask?: (id: string) => Promise<boolean>;
		archiveTask?: (id: string) => Promise<{ success: boolean; cleanedTaskIds: string[] }>;
		readTask?: (id: string) => Promise<Task | null>;
		readTasks?: Task[];
		filters?: { searchQuery: string };
		tasks?: Task[];
		hideEmptyColumns?: boolean;
		/** Columns to step right through before opening the popup. */
		startColumn?: number;
	},
	run: (context: {
		screen: ScreenInterface & EmittingWidget;
		/** Push a new task list through the board's update funnel, exactly as the watcher does. */
		publishTasks: (tasks: Task[]) => Promise<void>;
		popupBody: () => TestWidget | undefined;
		text: () => string;
		focused: () => EmittingWidget | undefined;
	}) => Promise<void>,
): Promise<void> {
	const descriptors = new Map(
		["isTTY", "columns", "rows"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]),
	);
	for (const [key, value] of Object.entries({ isTTY: true, columns: 120, rows: 40 })) {
		Object.defineProperty(process.stdout, key, { configurable: true, value });
	}
	const screen = createScreen({ smartCSR: false, width: 120, height: 40 }) as ScreenInterface & EmittingWidget;
	let subscriber: ((nextTasks: Task[], nextStatuses: string[]) => void) | undefined;
	try {
		const readTasks = options.readTasks ?? options.tasks ?? [createTask(), OTHER_TASK];
		const readTask = options.readTask ?? (async (id: string) => readTasks.find((task) => task.id === id) ?? null);
		const core = {
			editTaskInTui: options.editTaskInTui ?? (async () => ({ changed: false })),
			completeTask: options.completeTask,
			archiveTask: options.archiveTask,
			filesystem: { loadConfig: async () => ({ statuses: BOARD_STATUSES, autoCommit: false }) },
			fs: { loadConfig: async () => ({ statuses: BOARD_STATUSES, autoCommit: false }) },
			getTask: readTask,
			getTaskWithSubtasks: async (id: string) => {
				const task = await readTask(id);
				return task ? attachSubtaskSummaries(task, readTasks) : null;
			},
		} as unknown as Core;
		const boardPromise = renderBoardTui(options.tasks ?? [createTask(), OTHER_TASK], BOARD_STATUSES, "horizontal", 20, {
			screen,
			core,
			onTaskLaunch: options.onTaskLaunch,
			filters: options.filters
				? { priorityFilter: "", labelFilter: [], milestoneFilter: "", ...options.filters }
				: undefined,
			hideEmptyColumns: options.hideEmptyColumns,
			subscribeUpdates: (update) => {
				subscriber = update;
			},
		});
		await Bun.sleep(20);

		for (let step = 0; step < (options.startColumn ?? 0); step++) {
			pressKey(screen, "right");
			await Bun.sleep(10);
		}

		// Open the popup on the selected task in the focused column.
		if (options.openPopup !== false) {
			pressKey(screen, "enter");
			await Bun.sleep(30);
			expect(findPopupBody(screen)).toBeDefined();
		}

		await run({
			screen,
			publishTasks: async (tasks) => {
				expect(subscriber).toBeDefined();
				subscriber?.(tasks, BOARD_STATUSES);
				await Bun.sleep(30);
			},
			popupBody: () => findPopupBody(screen),
			text: () => screenText(screen),
			focused: () => (screen as unknown as { focused?: EmittingWidget }).focused,
		});

		// The board ignores q while a popup or modal is open, so dismiss them first.
		for (let attempt = 0; attempt < 10 && findPopupBody(screen); attempt++) {
			pressKey((screen as unknown as { focused?: EmittingWidget }).focused, "escape");
			await Bun.sleep(20);
		}
		pressKey(screen, "q");
		await withTimeout(boardPromise, "board close", 5000);
	} finally {
		screen.destroy();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else Reflect.deleteProperty(process.stdout, key);
		}
	}
}

describe("board Herdr handoff", () => {
	it("restores real keyboard delivery to task details after an error is acknowledged", async () => {
		await withBoardPopup(
			{
				onTaskLaunch: async () => {
					throw new Error("fixture_start_failed");
				},
			},
			async ({ screen, popupBody }) => {
				const press = (bytes: string) => {
					(screen.program as unknown as { input: { emit: (event: string, ...args: unknown[]) => void } }).input.emit(
						"data",
						Buffer.from(bytes),
					);
				};
				press("w");
				await Bun.sleep(20);
				press("\r");
				await Bun.sleep(20);
				press("\x1b");
				await Bun.sleep(20);
				expect(popupBody()).toBeUndefined();
			},
		);
	});

	it("keeps task updates behind the loading and restores the latest detail after handoff", async () => {
		let finish: ((value: { tabId: string }) => void) | undefined;
		await withBoardPopup(
			{
				onTaskLaunch: (_task, onProgress) => {
					onProgress("Starting Codex...");
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
			},
			async ({ focused, popupBody, publishTasks, text }) => {
				pressKey(focused(), "w");
				await Bun.sleep(20);
				const original = popupBody();
				await publishTasks([createTask({ title: "Updated while starting", description: "UPDATED-BODY" }), OTHER_TASK]);
				expect(text()).toContain("Starting Codex...");
				expect(popupBody()).toBe(original);
				finish?.({ tabId: "w1:t2" });
				await Bun.sleep(30);
				expect(popupBody()?.getContent?.()).toContain("UPDATED-BODY");
			},
		);
	});

	it("hands the selected board task off without changing its status or closing the board", async () => {
		const launched: Task[] = [];
		await withBoardPopup(
			{
				openPopup: false,
				onTaskLaunch: async (task) => {
					launched.push(task);
					return { tabId: "w1:t2" };
				},
			},
			async ({ screen, text }) => {
				pressKey(screen, "w");
				await Bun.sleep(30);
				expect(launched.map((task) => task.id)).toEqual([OPEN_TASK_ID]);
				expect(launched[0]?.status).toBe("To Do");
				expect(text()).toContain("w1:t2");
				expect(text()).toContain("not submitted");
			},
		);
	});

	it("hands off the task in the detail popup and ignores repeated keys while starting", async () => {
		let finish: ((value: { tabId: string }) => void) | undefined;
		const launched: Task[] = [];
		await withBoardPopup(
			{
				onTaskLaunch: (task) => {
					launched.push(task);
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
			},
			async ({ focused, screen, popupBody, text }) => {
				pressKey(focused(), "w");
				pressKey(focused(), "w");
				pressKey(screen, "w");
				await Bun.sleep(20);
				expect(launched.map((task) => task.id)).toEqual([OPEN_TASK_ID]);
				finish?.({ tabId: "w1:t2" });
				await Bun.sleep(30);
				expect(popupBody()).toBeDefined();
				expect(text()).toContain("not submitted");
			},
		);
	});

	it("reports startup failure and keeps the popup available", async () => {
		await withBoardPopup(
			{
				onTaskLaunch: async () => {
					throw new Error("Herdr is not running");
				},
			},
			async ({ focused, popupBody, text }) => {
				pressKey(focused(), "w");
				await Bun.sleep(30);
				expect(text()).toContain("Herdr is not running");
				expect(popupBody()).toBeDefined();
				pressKey(focused(), "escape");
				await Bun.sleep(20);
				expect(popupBody()).toBeDefined();
				expect(text()).not.toContain("Herdr is not running");
			},
		);
	});
});

describe("board task popup stays in sync with live task state", () => {
	it("rebuilds the popup after an in-popup editor edit", async () => {
		const edited = createTask({ title: "Edited title", description: "UPDATED-BODY" });
		await withBoardPopup(
			{ editTaskInTui: async () => ({ changed: true, task: edited }) },
			async ({ popupBody, text, focused }) => {
				const original = popupBody();

				pressKey(focused(), "e");
				await Bun.sleep(40);

				const refreshed = popupBody();
				expect(refreshed).toBeDefined();
				expect(refreshed).not.toBe(original);
				expect(refreshed?.getContent?.()).toContain("UPDATED-BODY");
				expect(refreshed?.getContent?.()).not.toContain("ORIGINAL-BODY");
				expect(text()).toContain("Edited title");
			},
		);
	});

	it("rebuilds the popup when the task changes outside the board", async () => {
		await withBoardPopup({}, async ({ publishTasks, popupBody, text }) => {
			const original = popupBody();

			await publishTasks([createTask({ title: "Renamed by CLI", description: "UPDATED-BODY" }), OTHER_TASK]);

			const refreshed = popupBody();
			expect(refreshed).toBeDefined();
			expect(refreshed).not.toBe(original);
			expect(refreshed?.getContent?.()).toContain("UPDATED-BODY");
			expect(refreshed?.getContent?.()).not.toContain("ORIGINAL-BODY");
			expect(text()).toContain("Renamed by CLI");
		});
	});

	it("closes the popup with a notice when the task leaves the board", async () => {
		await withBoardPopup({}, async ({ publishTasks, popupBody, text }) => {
			await publishTasks([OTHER_TASK]);

			expect(popupBody()).toBeUndefined();
			expect(text()).toContain(`${OPEN_TASK_ID} is no longer on the board`);
		});
	});

	it("defers the rebuild while a confirmation dialog is stacked on the popup", async () => {
		await withBoardPopup({}, async ({ publishTasks, popupBody, text, focused }) => {
			pressKey(focused(), "c");
			await Bun.sleep(30);
			const dialog = focused();
			expect(text()).toContain("to completed?");

			// An external edit lands while the user is still answering the dialog.
			await publishTasks([createTask({ title: "Renamed by CLI", description: "UPDATED-BODY" }), OTHER_TASK]);

			// The dialog must keep both the screen and the keyboard until it is answered.
			expect(text()).toContain("to completed?");
			expect(focused()).toBe(dialog);

			// Answering it still works, and the deferred refresh lands afterwards.
			pressKey(focused(), "escape");
			await Bun.sleep(40);
			expect(text()).not.toContain("to completed?");
			expect(popupBody()?.getContent?.()).toContain("UPDATED-BODY");
		});
	});

	it("explains archive purpose and incoming link removal before confirmation", async () => {
		await withBoardPopup({}, async ({ text, focused, popupBody }) => {
			pressKey(focused(), "a");
			await Bun.sleep(30);
			expect(text()).toContain("Canceled, duplicate, or invalid work.");
			expect(text()).toContain("Removes incoming task links.");
			pressKey(focused(), "escape");
			await Bun.sleep(30);
			expect(popupBody()).toBeDefined();
			expect(text()).not.toContain("Removes incoming task links.");
		});
	});

	it("restores focus to a real column when the board loses columns as the task disappears", async () => {
		// hideEmptyColumns drops the Done lane once its only task is gone, so the column the
		// popup was opened from no longer exists when focus has to go somewhere.
		const todo = createTask({ id: "TASK-A", status: "To Do" });
		const inProgress = createTask({ id: "TASK-B", status: "In Progress" });
		const done = createTask({ id: "TASK-C", status: "Done" });
		await withBoardPopup(
			{ tasks: [todo, inProgress, done], hideEmptyColumns: true, startColumn: 2 },
			async ({ publishTasks, popupBody, text, focused }) => {
				await publishTasks([todo, inProgress]);

				expect(popupBody()).toBeUndefined();
				expect(text()).toContain("TASK-C is no longer on the board");
				// Focus must land on a surviving column list, not nowhere.
				expect((focused() as TestWidget | undefined)?.type).toBe("list");
			},
		);
	});

	it("leaves the popup untouched when an update carries no content change", async () => {
		await withBoardPopup({}, async ({ publishTasks, popupBody }) => {
			const original = popupBody();
			expect(original).toBeDefined();

			// The watcher echo of a just-saved task differs only in read metadata.
			await publishTasks([
				createTask({ lastModified: new Date("2030-01-01"), filePath: "/elsewhere/task-1.md" }),
				OTHER_TASK,
			]);

			expect(popupBody()).toBe(original);
		});
	});
});

describe("board related task navigation", () => {
	const parent = createTask({
		title: "Parent task",
		references: ["TASK-1.1", "task-01.01", "TASK-99", "/tmp/task.md", "https://example.com/TASK-2"],
		description: Array.from({ length: 100 }, (_, i) => `PARENT-LINE-${i}`).join("\n"),
	});
	const child = createTask({
		id: "TASK-1.1",
		title: "Hidden child",
		parentTaskId: parent.id,
		description: "CHILD-BODY",
	});
	const grandchild = createTask({
		id: "TASK-1.1.1",
		title: "Grandchild",
		parentTaskId: child.id,
		description: "GRANDCHILD-BODY",
	});

	for (const fail of [false, true]) {
		it(`hands off the refreshed related task and restores navigation after ${fail ? "failure" : "success"}`, async () => {
			const tasks = [parent, child];
			const launched: Task[] = [];
			let finish: (() => void) | undefined;
			await withBoardPopup(
				{
					tasks: [parent],
					readTasks: tasks,
					onTaskLaunch: (task, onProgress) => {
						launched.push(task);
						onProgress("Starting Codex...");
						return new Promise((resolve, reject) => {
							finish = () => (fail ? reject(new Error("related_start_failed")) : resolve({ tabId: "w1:t2" }));
						});
					},
				},
				async ({ focused, popupBody, publishTasks, text }) => {
					popupBody()?.setScroll?.(12);
					const scroll = popupBody()?.childBase;
					pressKey(focused(), "r");
					await Bun.sleep(30);
					pressKey(focused(), "enter");
					await Bun.sleep(30);
					tasks[1] = { ...child, description: "BEFORE-HANDOFF" };
					await publishTasks([parent]);
					pressKey(focused(), "w");
					await Bun.sleep(20);
					expect(launched.map((task) => task.id)).toEqual([child.id]);
					expect(launched[0]?.description).toBe("BEFORE-HANDOFF");
					const original = popupBody();
					tasks[1] = { ...child, description: "DURING-HANDOFF" };
					await publishTasks([parent]);
					expect(popupBody()).toBe(original);
					expect(text()).toContain("Starting Codex...");
					finish?.();
					await Bun.sleep(40);
					if (fail) {
						expect(text()).toContain("related_start_failed");
						pressKey(focused(), "enter");
						await Bun.sleep(20);
					}
					expect(popupBody()?.getContent?.()).toContain("DURING-HANDOFF");
					pressKey(focused(), "escape");
					await Bun.sleep(40);
					expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
					expect(popupBody()?.childBase).toBe(scroll);
					pressKey(focused(), "q");
					await Bun.sleep(20);
					expect(popupBody()).toBeUndefined();
				},
			);
		});
	}

	it("ignores handoff while a return destination is being read", async () => {
		let release: (() => void) | undefined;
		let returning = false;
		const launched: string[] = [];
		await withBoardPopup(
			{
				tasks: [parent],
				readTask: async (id) => {
					if (id === parent.id && returning)
						await new Promise<void>((resolve) => {
							release = resolve;
						});
					return id === parent.id ? parent : id === child.id ? child : null;
				},
				onTaskLaunch: async (task) => {
					launched.push(task.id);
					return { tabId: "w1:t2" };
				},
			},
			async ({ focused, popupBody }) => {
				pressKey(focused(), "r");
				await Bun.sleep(30);
				pressKey(focused(), "enter");
				await Bun.sleep(30);
				returning = true;
				pressKey(focused(), "escape");
				await Bun.sleep(10);
				pressKey(focused(), "w");
				await Bun.sleep(20);
				returning = false;
				release?.();
				await Bun.sleep(30);
				expect(launched).toEqual([]);
				expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
			},
		);
	});

	it("deduplicates references and native children, ignores paths, and opens a filtered-out task", async () => {
		await withBoardPopup(
			{
				tasks: [parent, child, OTHER_TASK],
				readTasks: [parent, child, OTHER_TASK],
				filters: { searchQuery: "Parent task" },
			},
			async ({ focused, text, popupBody }) => {
				pressKey(focused(), "r");
				await Bun.sleep(40);
				expect(text()).toContain("Related Tasks");
				const rows = (focused() as TestWidget)?.children?.map((row) => row.getContent?.() ?? "").join("\n") ?? "";
				expect(rows).toContain("TASK-1.1 - Hidden child");
				expect(rows).toContain("[○ To Do]");
				expect(rows).not.toContain("/tmp/task.md");
				expect(rows.match(/TASK-1\.1 -/g)).toHaveLength(1);
				pressKey(focused(), "enter");
				await Bun.sleep(40);
				expect(popupBody()?.getContent?.()).toContain("CHILD-BODY");
				expect(text()).not.toContain("Related Tasks");
				pressKey(focused(), "escape");
				await Bun.sleep(40);
				expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
			},
		);
	});

	it("puts completed children last and opens the first unfinished child by default", async () => {
		const done = { ...child, status: "Done" };
		const active = {
			...child,
			id: "TASK-1.2",
			title: "Active child",
			status: "In Progress",
			description: "ACTIVE-BODY",
		};
		await withBoardPopup(
			{ tasks: [parent], readTasks: [{ ...parent, references: [] }, done, active] },
			async ({ focused, popupBody }) => {
				pressKey(focused(), "r");
				await Bun.sleep(40);
				const rows = (focused() as TestWidget)?.children?.map((row) => row.getContent?.() ?? "") ?? [];
				expect(rows).toHaveLength(2);
				expect(rows[0]).toContain("TASK-1.2 - Active child");
				expect(rows[1]).toContain("TASK-1.1 - Hidden child");
				pressKey(focused(), "enter");
				await Bun.sleep(40);
				expect(popupBody()?.getContent?.()).toContain("ACTIVE-BODY");
			},
		);
	});

	it("restores scroll at each level and the original board selection", async () => {
		const longChild = { ...child, description: Array.from({ length: 100 }, (_, i) => `CHILD-LINE-${i}`).join("\n") };
		await withBoardPopup(
			{ tasks: [parent, OTHER_TASK], readTasks: [parent, longChild, grandchild, OTHER_TASK] },
			async ({ focused, popupBody, screen }) => {
				popupBody()?.setScroll?.(12);
				const parentScroll = popupBody()?.childBase;
				expect(parentScroll).toBeGreaterThan(0);
				pressKey(focused(), "r");
				await Bun.sleep(30);
				pressKey(focused(), "enter");
				await Bun.sleep(30);
				popupBody()?.setScroll?.(9);
				const childScroll = popupBody()?.childBase;
				pressKey(focused(), "r");
				await Bun.sleep(30);
				// Native parent is the first row; native grandchild is the next.
				pressKey(focused(), "j");
				pressKey(focused(), "enter");
				await Bun.sleep(40);
				expect(popupBody()?.getContent?.()).toContain("GRANDCHILD-BODY");
				pressKey(focused(), "escape");
				await Bun.sleep(40);
				expect(popupBody()?.getContent?.()).toContain("CHILD-LINE-0");
				expect(popupBody()?.childBase).toBe(childScroll);
				pressKey(focused(), "q");
				await Bun.sleep(40);
				expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
				expect(popupBody()?.childBase).toBe(parentScroll);
				pressKey(focused(), "escape");
				await Bun.sleep(40);
				expect(popupBody()).toBeUndefined();
				pressKey(screen, "enter");
				await Bun.sleep(30);
				expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
			},
		);
	});

	it("keeps details and scroll when the picker is cancelled or a reference is missing", async () => {
		await withBoardPopup({ tasks: [parent], readTasks: [parent, child] }, async ({ focused, text, popupBody }) => {
			popupBody()?.setScroll?.(8);
			const scroll = popupBody()?.childBase;
			pressKey(focused(), "r");
			await Bun.sleep(30);
			pressKey(focused(), "escape");
			await Bun.sleep(30);
			expect(popupBody()?.childBase).toBe(scroll);
			pressKey(focused(), "r");
			await Bun.sleep(30);
			pressKey(focused(), "j");
			pressKey(focused(), "enter");
			await Bun.sleep(40);
			expect(text()).toContain("TASK-99 not found");
			expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
			expect(popupBody()?.childBase).toBe(scroll);
		});
	});

	it("fails closed on ambiguous IDs and reads the chosen target again after selection", async () => {
		let fail = false;
		let childReads = 0;
		await withBoardPopup(
			{
				tasks: [parent],
				readTask: async (id) => {
					if (id === child.id) {
						childReads++;
						if (fail) throw new AmbiguousTaskIdError(id, ["first.md", "second.md"]);
						return child;
					}
					return id === parent.id ? parent : null;
				},
			},
			async ({ focused, popupBody, text }) => {
				pressKey(focused(), "r");
				await Bun.sleep(30);
				fail = true;
				pressKey(focused(), "enter");
				await Bun.sleep(40);
				expect(childReads).toBeGreaterThanOrEqual(2);
				expect(text()).toContain("Ambiguous");
				expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
			},
		);
	});

	it("defers watcher refresh under the picker and returns to the latest parent", async () => {
		const tasks = [parent, child];
		await withBoardPopup({ tasks, readTasks: tasks }, async ({ focused, publishTasks, popupBody, text }) => {
			pressKey(focused(), "r");
			await Bun.sleep(30);
			const picker = focused();
			tasks[0] = { ...parent, description: "UPDATED-PARENT" };
			await publishTasks([...tasks]);
			expect(focused()).toBe(picker);
			expect(text()).toContain("Related Tasks");
			pressKey(focused(), "enter");
			await Bun.sleep(50);
			expect(popupBody()?.getContent?.()).toContain("CHILD-BODY");
			pressKey(focused(), "escape");
			await Bun.sleep(50);
			expect(popupBody()?.getContent?.()).toContain("UPDATED-PARENT");
		});
	});

	it("refreshes a related task outside the board and edits the displayed task", async () => {
		const tasks = [parent, child];
		let editedId: string | undefined;
		await withBoardPopup(
			{
				tasks: [parent],
				readTasks: tasks,
				editTaskInTui: async (id) => {
					editedId = id;
					return { changed: true, task: { ...child, ...tasks[1], description: "EDITED-CHILD" } };
				},
			},
			async ({ focused, publishTasks, popupBody }) => {
				pressKey(focused(), "r");
				await Bun.sleep(30);
				pressKey(focused(), "enter");
				await Bun.sleep(40);
				tasks[1] = { ...child, description: "UPDATED-CHILD" };
				await publishTasks([{ ...parent, title: "Changed parent" }]);
				expect(popupBody()?.getContent?.()).toContain("UPDATED-CHILD");
				pressKey(focused(), "e");
				await Bun.sleep(40);
				expect(editedId).toBe(child.id);
				expect(popupBody()?.getContent?.()).toContain("EDITED-CHILD");
			},
		);
	});

	it("refreshes a hidden related task even when the board corpus did not change", async () => {
		const tasks = [parent, child];
		await withBoardPopup({ tasks: [parent], readTasks: tasks }, async ({ focused, publishTasks, popupBody }) => {
			pressKey(focused(), "r");
			await Bun.sleep(30);
			pressKey(focused(), "enter");
			await Bun.sleep(40);
			tasks[1] = { ...child, description: "HIDDEN-UPDATE" };
			await publishTasks([parent]);
			expect(popupBody()?.getContent?.()).toContain("HIDDEN-UPDATE");
		});
	});

	it("does not open duplicate pickers while resolving related task IDs", async () => {
		let reads = 0;
		await withBoardPopup(
			{
				tasks: [parent],
				readTask: async (id) => {
					if (id === parent.id) {
						reads++;
						await Bun.sleep(20);
						return parent;
					}
					return id === child.id ? child : null;
				},
			},
			async ({ focused, text, popupBody }) => {
				pressKey(focused(), "r");
				pressKey(focused(), "r");
				await Bun.sleep(70);
				expect(reads).toBe(1);
				expect(text().match(/Related Tasks/g)).toHaveLength(1);
				pressKey(focused(), "escape");
				await Bun.sleep(30);
				expect(popupBody()).toBeDefined();
			},
		);
	});

	it("explains empty relations without closing or scrolling the current task", async () => {
		await withBoardPopup({}, async ({ focused, text, popupBody }) => {
			const original = popupBody();
			pressKey(focused(), "r");
			await Bun.sleep(40);
			expect(text()).toContain("No related tasks");
			expect(popupBody()).toBe(original);
		});
	});

	it("returns to the parent when the viewed hidden task disappears", async () => {
		const tasks = [parent, child];
		await withBoardPopup({ tasks: [parent], readTasks: tasks }, async ({ focused, publishTasks, popupBody, text }) => {
			pressKey(focused(), "r");
			await Bun.sleep(30);
			pressKey(focused(), "enter");
			await Bun.sleep(40);
			tasks.pop();
			await publishTasks([parent]);
			expect(popupBody()?.getContent?.()).toContain("PARENT-LINE-0");
			expect(text()).toContain("TASK-1.1 not found");
		});
	});

	it("skips a deleted parent on back instead of trapping the user", async () => {
		const tasks = [parent, child];
		await withBoardPopup({ tasks: [parent], readTasks: tasks }, async ({ focused, popupBody, text }) => {
			pressKey(focused(), "r");
			await Bun.sleep(30);
			pressKey(focused(), "enter");
			await Bun.sleep(40);
			tasks.shift();
			pressKey(focused(), "escape");
			await Bun.sleep(40);
			expect(popupBody()).toBeUndefined();
			expect(text()).toContain("TASK-1 not found");
			expect((focused() as TestWidget)?.type).toBe("list");
		});
	});

	for (const action of ["complete", "archive"] as const) {
		it(`${action}s the displayed related task rather than the original board task`, async () => {
			const actedOn: string[] = [];
			await withBoardPopup(
				{
					tasks: [parent],
					readTasks: [parent, { ...child, status: "Done" }],
					completeTask: async (id) => {
						actedOn.push(id);
						return true;
					},
					archiveTask: async (id) => {
						actedOn.push(id);
						return { success: true, cleanedTaskIds: [] };
					},
				},
				async ({ focused, popupBody, text }) => {
					pressKey(focused(), "r");
					await Bun.sleep(30);
					// The unresolved reference stays above the completed child.
					pressKey(focused(), "j");
					pressKey(focused(), "enter");
					await Bun.sleep(40);
					pressKey(focused(), action === "complete" ? "c" : "a");
					await Bun.sleep(30);
					expect(text()).toContain(child.id);
					pressKey(focused(), "y");
					await Bun.sleep(40);
					expect(actedOn).toEqual([child.id]);
					expect(popupBody()).toBeUndefined();
				},
			);
		});
	}

	it("does not rebuild the returned parent from an older board snapshot", async () => {
		const tasks = [parent, child];
		await withBoardPopup({ tasks: [parent], readTasks: tasks }, async ({ focused, publishTasks, popupBody }) => {
			pressKey(focused(), "r");
			await Bun.sleep(30);
			pressKey(focused(), "enter");
			await Bun.sleep(40);
			tasks[0] = { ...parent, description: "LATEST-PARENT" };
			pressKey(focused(), "escape");
			await Bun.sleep(40);
			await publishTasks([parent]);
			expect(popupBody()?.getContent?.()).toContain("LATEST-PARENT");
		});
	});
});
