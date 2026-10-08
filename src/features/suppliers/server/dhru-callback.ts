import { z } from "zod";
import { readBoundedRequestJson } from "#/lib/bounded-stream";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

/** Unsigned notice can only advance the next authenticated reconciliation. */
export async function handleDhruSupplierCallback(
	request: Request,
	accountId: string,
	db: D1Database,
) {
	if (!z.uuid().safeParse(accountId).success)
		return Response.json({ ok: false }, { status: 400 });
	const rate = await claimFixedWindowRateLimit(db, {
		bucketKey: `dhru-notice:${accountId}`,
		limit: 60,
		windowMs: 60_000,
	});
	if (!rate.allowed) return Response.json({ ok: false }, { status: 429 });
	let body: unknown;
	try {
		body = await readBoundedRequestJson(request, 64 * 1024);
	} catch {
		return Response.json({ ok: false }, { status: 400 });
	}
	const notice = z
		.object({ reference_id: z.uuid(), order_uuid: z.string().min(1).max(512) })
		.safeParse(body);
	if (!notice.success) return Response.json({ ok: false }, { status: 400 });
	const now = Date.now();
	await db
		.prepare(`UPDATE supplier_orders SET next_retry_at = ?, updated_at = ?
 WHERE id = ? AND selected_account_id = ? AND upstream_order_id = ? AND state = 'uncertain'
 AND EXISTS (SELECT 1 FROM supplier_accounts WHERE id = ? AND provider = 'dhru')`)
		.bind(
			now,
			now,
			notice.data.reference_id,
			accountId,
			notice.data.order_uuid,
			accountId,
		)
		.run();
	return Response.json({ ok: true }, { status: 202 });
}
