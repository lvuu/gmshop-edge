import { z } from "zod";
import type { SupplierQueueMessage } from "#/server/queue/types";

const payloadSchema = z.object({
	supplierOrderId: z.string().min(1).max(128),
});

export async function publishPendingSupplierOrders(
	db: D1Database,
	queue: Queue<SupplierQueueMessage>,
	limit = 25,
	outboxId?: string,
) {
	const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	const rows = await db
		.prepare(
			`SELECT id, payload FROM outbox_events
			 WHERE event_type = 'supplier.requested' AND status = 'pending'
			 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
		 ${outboxId ? "AND id = ?" : ""}
			 ORDER BY created_at, id LIMIT ?`,
		)
		.bind(Date.now(), ...(outboxId ? [outboxId] : []), boundedLimit)
		.all<{ id: string; payload: string }>();
	if (!rows.results.length) return { published: 0 };
	const messages = rows.results.map((row) => ({
		outboxId: row.id,
		body: {
			kind: "commerce.supplier",
			version: 1,
			supplierOrderId: payloadSchema.parse(JSON.parse(row.payload))
				.supplierOrderId,
		} satisfies SupplierQueueMessage,
	}));
	await queue.sendBatch(messages.map(({ body }) => ({ body })));
	const now = Date.now();
	await db.batch(
		messages.map(({ outboxId }) =>
			db
				.prepare(
					`UPDATE outbox_events SET status = 'published',
					 published_at = ?, updated_at = ?
					 WHERE id = ? AND status = 'pending'`,
				)
				.bind(now, now, outboxId),
		),
	);
	return { published: messages.length };
}
