import { z } from "zod";
import type { SupplierQueueMessage } from "#/server/queue/types";

const payloadSchema = z.object({
	supplierOrderId: z.string().min(1).max(128),
});

/** Durable polling continues independently of the queue's finite retry budget. */
export async function queueDueSupplierReconciliations(
	db: D1Database,
	limit = 25,
	now = Date.now(),
) {
	const eligible = `so.state = 'uncertain' AND so.selected_account_id IS NOT NULL
	 AND so.next_retry_at IS NOT NULL AND so.next_retry_at <= ?
	 AND (so.upstream_order_id IS NOT NULL OR
	  json_extract(so.binding_snapshot_json, '$.provider') IN ('acg', 'dujiao_next', 'gmshop_edge'))
	 AND o.status IN ('paid', 'fulfilling')
	 AND NOT EXISTS (SELECT 1 FROM outbox_events e
	  WHERE e.aggregate_type = 'supplier_order' AND e.aggregate_id = so.id
	  AND e.event_type = 'supplier.requested' AND e.status = 'pending')`;
	const rows = await db
		.prepare(`SELECT so.id, so.next_retry_at, so.updated_at
	 FROM supplier_orders so JOIN shop_orders o ON o.id = so.order_id
	 WHERE ${eligible} ORDER BY so.next_retry_at, so.id LIMIT ?`)
		.bind(now, Math.max(1, Math.min(100, Math.trunc(limit))))
		.all<{ id: string; next_retry_at: number; updated_at: number }>();
	if (!rows.results.length) return { queued: 0 };
	const statements = rows.results.flatMap((row) => {
		const id = crypto.randomUUID();
		return [
			db
				.prepare(`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			 status, attempt_count, created_at, updated_at)
			 SELECT ?, 'supplier.requested', 'supplier_order', so.id, ?, ?, 'pending', 0, ?, ?
			 FROM supplier_orders so JOIN shop_orders o ON o.id = so.order_id
			 WHERE so.id = ? AND so.next_retry_at = ? AND so.updated_at = ? AND ${eligible}`)
				.bind(
					id,
					`supplier-poll:${id}`,
					JSON.stringify({ supplierOrderId: row.id }),
					now,
					now,
					row.id,
					row.next_retry_at,
					row.updated_at,
					now,
				),
			db
				.prepare(`UPDATE supplier_orders SET next_retry_at = ?, updated_at = ?
			 WHERE id = ? AND EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)`)
				.bind(
					Math.max(now + 60_000, row.next_retry_at + 1),
					Math.max(now, row.updated_at + 1),
					row.id,
					id,
				),
		];
	});
	const results = await db.batch(statements);
	return {
		queued: results.filter(
			(result, index) => index % 2 === 0 && result.meta.changes === 1,
		).length,
	};
}

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
