import { describe, expect, it } from "bun:test";
import type { ScreenInterface } from "neo-neo-bblessed";
import { box } from "neo-neo-bblessed";
import { createHandoffFeedback } from "../ui/components/handoff-feedback.ts";
import { createScreen } from "../ui/tui.ts";

type Widget = {
	type?: string;
	hidden?: boolean;
	children?: Widget[];
	getContent?: () => string;
	width?: number;
	height?: number;
};

function widgets(root: Widget): Widget[] {
	return (root.children ?? []).flatMap((child) => (child.hidden ? [] : [child, ...widgets(child)]));
}

function content(screen: ScreenInterface): string {
	return widgets(screen as unknown as Widget)
		.map((child) => child.getContent?.() ?? "")
		.join("\n");
}

function press(screen: ScreenInterface, name: string): void {
	(screen.program as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit("keypress", "", {
		name,
		full: name,
	});
}

describe("Herdr handoff feedback", () => {
	it("automatically removes a success notice after five seconds", async () => {
		const screen = createScreen({ smartCSR: false });
		const feedback = createHandoffFeedback(screen);
		try {
			await feedback.run("TASK-47", async () => ({ tabId: "w1:t2" }));
			expect(content(screen)).toContain("w1:t2");
			await Bun.sleep(5100);
			expect(content(screen)).not.toContain("w1:t2");
		} finally {
			feedback.destroy();
			screen.destroy();
		}
	});

	it("lets a long error scroll after resize and closes it with Enter", async () => {
		const screen = createScreen({ smartCSR: false });
		const feedback = createHandoffFeedback(screen);
		try {
			const pending = feedback.run("TASK-47", async () => {
				throw new Error(`Partial tab w1:t2: {original error}\n${"Error details\n".repeat(30)}`);
			});
			await Bun.sleep(20);
			Object.defineProperty(screen, "width", { configurable: true, value: 40 });
			Object.defineProperty(screen, "height", { configurable: true, value: 10 });
			(screen as unknown as { emit: (event: string) => void }).emit("resize");
			expect(content(screen)).toContain("{original error}");
			press(screen, "down");
			press(screen, "enter");
			await pending;
			expect(content(screen)).not.toContain("Partial tab");
		} finally {
			feedback.destroy();
			screen.destroy();
		}
	});

	it("locks real key delivery during loading, updates in place, and restores focus on success", async () => {
		const screen = createScreen({ smartCSR: false });
		const focus = box({ parent: screen, keys: true });
		focus.focus();
		const feedback = createHandoffFeedback(screen);
		let delivered = 0;
		screen.key(["w", "q", "tab", "escape", "right"], () => {
			delivered++;
		});
		let finish: ((result: { tabId: string }) => void) | undefined;
		let update: ((stage: string) => void) | undefined;
		try {
			const pending = feedback.run("TASK-47", (onProgress) => {
				update = onProgress;
				return new Promise((resolve) => {
					finish = resolve;
				});
			});
			for (const key of ["w", "q", "tab", "escape", "right"]) press(screen, key);
			expect(delivered).toBe(0);
			expect((screen as unknown as { lockKeys: boolean }).lockKeys).toBe(true);
			update?.("Starting Codex...");
			update?.("Prefilling task template...");
			expect(content(screen)).toContain("Prefilling task template...");
			expect(widgets(screen as unknown as Widget).filter((widget) => widget.type === "loading")).toHaveLength(1);
			finish?.({ tabId: "w1:t2" });
			await pending;
			expect((screen as unknown as { lockKeys: boolean }).lockKeys).toBe(false);
			expect(content(screen)).toContain("w1:t2");
			expect(content(screen)).toContain("not submitted");
			expect((screen as unknown as { focused: unknown }).focused).toBe(focus);
			press(screen, "right");
			expect(delivered).toBe(1);
		} finally {
			feedback.destroy();
			screen.destroy();
		}
	});

	it("unlocks on failure and requires acknowledgment without leaking Escape to the board", async () => {
		const screen = createScreen({ smartCSR: false });
		const focus = box({ parent: screen, keys: true });
		focus.focus();
		const feedback = createHandoffFeedback(screen);
		let escaped = 0;
		screen.key(["escape"], () => {
			escaped++;
		});
		try {
			const pending = feedback.run("TASK-47", async () => {
				throw new Error("Herdr tab w1:t2 was created; timed out");
			});
			await Bun.sleep(20);
			expect((screen as unknown as { lockKeys: boolean }).lockKeys).toBe(false);
			expect(content(screen)).toContain("timed out");
			expect(content(screen)).toContain("w1:t2");
			press(screen, "escape");
			await pending;
			expect(escaped).toBe(0);
			expect((screen as unknown as { focused: unknown }).focused).toBe(focus);
			expect(content(screen)).not.toContain("timed out");
		} finally {
			feedback.destroy();
			screen.destroy();
		}
	});

	it("keeps the loading visible on resize and cleans up a pending launch on screen destruction", async () => {
		const screen = createScreen({ smartCSR: false });
		const feedback = createHandoffFeedback(screen);
		let finish: ((result: { tabId: string }) => void) | undefined;
		const pending = feedback.run(
			"TASK-47",
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		Object.defineProperty(screen, "width", { configurable: true, value: 30 });
		Object.defineProperty(screen, "height", { configurable: true, value: 6 });
		(screen as unknown as { emit: (event: string) => void }).emit("resize");
		const loading = widgets(screen as unknown as Widget).find((widget) => widget.type === "loading");
		expect(loading?.width).toBeLessThanOrEqual(30);
		expect(loading?.height).toBeLessThanOrEqual(6);
		screen.destroy();
		finish?.({ tabId: "w1:t2" });
		await pending;
		expect((screen as unknown as { lockKeys: boolean }).lockKeys).toBe(false);
	});

	it("replaces the previous success notice rather than stacking notifications", async () => {
		const screen = createScreen({ smartCSR: false });
		const feedback = createHandoffFeedback(screen);
		try {
			await feedback.run("TASK-47", async () => ({ tabId: "w1:t2" }));
			await feedback.run("TASK-48", async () => ({ tabId: "w1:t3" }));
			box({ parent: screen, content: "Late task detail refresh" });
			screen.render();
			expect(content(screen)).not.toContain("w1:t2");
			expect(content(screen)).toContain("w1:t3");
			expect((screen as unknown as Widget).children?.at(-1)?.getContent?.()).toContain("w1:t3");
		} finally {
			feedback.destroy();
			screen.destroy();
		}
	});
});
