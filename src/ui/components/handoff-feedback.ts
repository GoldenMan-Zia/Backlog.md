import type { EventEmitter } from "node:events";
import type { BoxInterface, ScreenInterface } from "neo-neo-bblessed";
import blessed, { box } from "neo-neo-bblessed";
import { addScrollKeys } from "../tui.ts";
import { createPopupChrome, createScrollableViewport } from "./filter-popup.ts";

/** Owns the loading and its result so subsequent launches never stack notices. */
export function createHandoffFeedback(screen: ScreenInterface): {
	run: (taskId: string, launch: (onProgress: (stage: string) => void) => Promise<{ tabId: string }>) => Promise<void>;
	destroy: () => void;
} {
	const events = screen as unknown as EventEmitter;
	let disposed = false;
	let cleanup: (() => void) | undefined;
	const clear = () => {
		cleanup?.();
		cleanup = undefined;
	};
	const destroy = () => {
		disposed = true;
		clear();
		events.removeListener("destroy", destroy);
	};
	events.once("destroy", destroy);

	const run = async (taskId: string, launch: (onProgress: (stage: string) => void) => Promise<{ tabId: string }>) => {
		if (disposed) return;
		clear();
		// Loading is available on the default namespace, not as a named ESM export.
		const spinner = (blessed as unknown as { loading: typeof box }).loading({
			parent: screen,
			top: "center",
			left: "center",
			border: { type: "line" },
			label: " Opening Codex in Herdr ",
			align: "center",
			style: { border: { fg: "cyan" }, bg: "default" },
		}) as BoxInterface & { load: (text: string) => void; stop: () => void; setFront: () => void };
		const fit = () => {
			spinner.width = Math.max(1, Math.min(64, screen.width));
			spinner.height = Math.max(1, Math.min(7, screen.height));
			spinner.setFront();
		};
		fit();
		screen.on("resize", fit);
		cleanup = () => {
			events.removeListener("resize", fit);
			spinner.stop();
			spinner.destroy();
		};
		let result: { tabId: string } | undefined;
		let failure: Error | undefined;
		try {
			spinner.load(`${taskId}\n\n\nStarting handoff...`);
			screen.render();
			result = await launch((stage) => {
				if (disposed) return;
				spinner.setContent(`${taskId}\n\n\n${stage}`);
				screen.render();
			});
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		} finally {
			clear();
		}
		if (disposed) return;
		if (failure) {
			await new Promise<void>((resolve) => {
				const { popup, close, reflow } = createPopupChrome({
					screen,
					title: "Codex handoff failed",
					helpText: " {cyan-fg}[Enter/Esc]{/} Close | {cyan-fg}[Up/Down]{/} Scroll",
					width: 64,
					height: 14,
				});
				const viewport = createScrollableViewport({
					parent: popup,
					top: 1,
					left: 1,
					right: 1,
					bottom: 1,
					content: `${taskId}\n\n${failure.message}`,
					keys: true,
					tags: false,
				});
				addScrollKeys(viewport, screen);
				const onResize = () => {
					reflow(64, 14);
					screen.render();
				};
				// Grab keys while acknowledging the error, so Escape never reaches board exit.
				const keyScreen = screen as unknown as { grabKeys: boolean; saveFocus: () => void; restoreFocus: () => void };
				const grabbed = keyScreen.grabKeys;
				keyScreen.saveFocus();
				keyScreen.grabKeys = true;
				screen.on("resize", onResize);
				cleanup = () => {
					events.removeListener("resize", onResize);
					keyScreen.grabKeys = grabbed;
					close();
					if (!disposed) {
						keyScreen.restoreFocus();
						screen.render();
					}
					resolve();
				};
				viewport.key(["enter", "escape"], clear);
				viewport.focus();
				screen.render();
			});
		} else if (result) {
			const notice = box({
				parent: screen,
				top: 1,
				left: "center",
				height: 6,
				border: { type: "line" },
				label: " Codex ready ",
				align: "center",
				content: `${taskId} | Herdr ${result.tabId}\nTemplate not submitted.\nSwitch to Herdr to edit.`,
				style: { border: { fg: "green" }, bg: "default" },
			});
			const onResize = () => {
				notice.width = Math.max(1, Math.min(64, screen.width));
				notice.height = Math.max(1, Math.min(6, screen.height));
				notice.top = screen.height <= 6 ? 0 : 1;
			};
			onResize();
			screen.on("resize", onResize);
			const bringToFront = () => (notice as BoxInterface & { setFront: () => void }).setFront();
			events.on("prerender", bringToFront);
			const timer = setTimeout(() => {
				clear();
				if (!disposed) screen.render();
			}, 5000);
			cleanup = () => {
				clearTimeout(timer);
				events.removeListener("resize", onResize);
				events.removeListener("prerender", bringToFront);
				notice.destroy();
			};
			screen.render();
		}
	};
	return { run, destroy };
}
