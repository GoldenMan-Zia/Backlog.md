import type { Core } from "../core/backlog.ts";
import type { Task } from "../types/index.ts";
import { extractAnyPrefix } from "../utils/prefix-config.ts";
import { canonicalTaskId, isNumericTaskId } from "../utils/task-id.ts";
import { isAmbiguousTaskIdError } from "../utils/task-path.ts";
import { isTerminalStatus } from "../utils/terminal-status.ts";
import type { FilterPopupChoice } from "./components/filter-popup.ts";
import { formatStatusWithIcon, getStatusColor, wrapStatusColor } from "./status-icon.ts";

export async function loadRelatedTaskChoices(
	core: Core,
	task: Pick<Task, "id">,
	statuses: readonly string[],
): Promise<FilterPopupChoice[]> {
	const source = await core.getTaskWithSubtasks(task.id);
	if (!source) throw new Error(`${task.id} not found`);
	const ids = new Set<string>();
	const prefix = extractAnyPrefix(source.id) ?? "task";
	for (const reference of source.references ?? []) {
		// Only whole numeric task IDs qualify; paths, URLs and prose remain plain references.
		if (isNumericTaskId(reference)) ids.add(canonicalTaskId(reference, prefix));
	}
	if (source.parentTaskId) ids.add(canonicalTaskId(source.parentTaskId));
	for (const id of source.subtasks ?? []) ids.add(canonicalTaskId(id));
	ids.delete(canonicalTaskId(source.id));

	const completedIds = new Set<string>();
	const choices = await Promise.all(
		Array.from(ids, async (id) => {
			try {
				const target = await core.getTask(id, { refreshCrossBranch: false });
				if (!target) return { value: id, label: `${id} - Not found` };
				if (isTerminalStatus(target.status, statuses)) completedIds.add(id);
				const status = wrapStatusColor(`[${formatStatusWithIcon(target.status)}]`, getStatusColor(target.status));
				return { value: id, label: `${status} ${id} - ${target.title}` };
			} catch (error) {
				return {
					value: id,
					label: `${id} - ${isAmbiguousTaskIdError(error) ? "Ambiguous ID" : "Could not read task"}`,
				};
			}
		}),
	);
	return choices.sort((a, b) => Number(completedIds.has(a.value)) - Number(completedIds.has(b.value)));
}
