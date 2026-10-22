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
	// Fusion Pro calls the echoed order identifier `order_id` in the callback
	// body (the GET query parameter stays `order_uuid`). Accept both names and
	// prefer the documented field. `reference_id` is always the supplier order
	// UUID this worker sent in `POST /order`, so a strict UUID match rejects
	// forged or mismatched notices before any reconciliation is scheduled.
	const notice = z
		.object({
			reference_id: z.uuid(),
			order_id: z.string().min(1).max(512).optional(),
			order_uuid: z.string().min(1).max(512).optional(),
		})
		.refine((value) => Boolean(value.order_id ?? value.order_uuid), {
			message: "order identifier required",
		})
		.transform((value) => ({
			reference_id: value.reference_id,
			order_uuid: value.order_id ?? value.order_uuid ?? "",
		}))
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
