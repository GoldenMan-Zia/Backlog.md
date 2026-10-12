import { describe, expect, it } from "bun:test";
import type { ScreenInterface } from "neo-neo-bblessed";
import type { Core, TuiTaskEditResult } from "../core/backlog.ts";
import type { Task } from "../types/index.ts";
import { renderBoardTui } from "../ui/board.ts";
import { createScreen } from "../ui/tui.ts";
import { withTimeout } from "./test-utils.ts";

type EmittingWidget = {
	emit: (event: string, ch?: string, key?: { name: string; full: string; shift?: boolean }) => boolean;
};
type TestWidget = {
	type?: string;
	children?: TestWidget[];
	getContent?: () => string;
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
		editTaskInTui?: () => Promise<TuiTaskEditResult>;
		onTaskLaunch?: (task: Task, onProgress: (stage: string) => void) => Promise<{ tabId: string }>;
		openPopup?: boolean;
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
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	const screen = createScreen({ smartCSR: false }) as ScreenInterface & EmittingWidget;
	let subscriber: ((nextTasks: Task[], nextStatuses: string[]) => void) | undefined;
	try {
		const core = { editTaskInTui: options.editTaskInTui ?? (async () => ({ changed: false })) } as unknown as Core;
		const boardPromise = renderBoardTui(options.tasks ?? [createTask(), OTHER_TASK], BOARD_STATUSES, "horizontal", 20, {
			screen,
			core,
			onTaskLaunch: options.onTaskLaunch,
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
		for (let attempt = 0; attempt < 2 && findPopupBody(screen); attempt++) {
			pressKey((screen as unknown as { focused?: EmittingWidget }).focused, "escape");
			await Bun.sleep(20);
		}
		pressKey(screen, "q");
		await withTimeout(boardPromise, "board close", 5000);
	} finally {
		screen.destroy();
		if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
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
