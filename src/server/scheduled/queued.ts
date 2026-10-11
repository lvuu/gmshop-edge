import {
	OperationTaskAlreadyRunningError,
	runTrackedTask,
} from "#/features/operations/server/task-runs";
import { runScheduledCommerceWork } from "#/server/scheduled";

const TASK = "commerce.maintenance";
const SCHEDULE = "* * * * *";

export async function runQueuedScheduledCommerceWork(
	env: Env,
	scheduledAt: number,
) {
	try {
		return await runTrackedTask(
			env.DB,
			{ task: TASK, trigger: "scheduled", schedule: SCHEDULE },
			async () => {
				// Check under the existing D1 task lease. A successful newer tick
				// already covered delayed messages and transport duplicates.
				const completed = await env.DB.prepare(
					`SELECT id FROM operation_task_runs
					 WHERE task = ? AND status = 'succeeded' AND started_at >= ?
					 AND json_extract(result, '$.skipped') IS NULL
					 ORDER BY started_at DESC, id DESC LIMIT 1`,
				)
					.bind(TASK, scheduledAt)
					.first();
				if (completed) return { skipped: "already_completed" };
				// Expiration and due-work checks use consumption time, even if the
				// queue was delayed. Nothing waits for a service order to finish.
				return runScheduledCommerceWork(env, SCHEDULE, Date.now());
			},
		);
	} catch (error) {
		// Like Bun's scheduler, overlapping ticks are coalesced. A later Cron
		// tick continues recovery; failed work still follows queue retries.
		if (
			error instanceof OperationTaskAlreadyRunningError &&
			error.task === TASK
		)
			return { skipped: "already_running" };
		throw error;
	}
}
