import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
import { getAdminRuntimeServerContext } from "#/server/context";
import { supplierOrderActionAllowed } from "../order-actions";
import { supplierOrderActionSchema, supplierOrderListSchema } from "../schema";
import { publishPendingSupplierOrders } from "./outbox";

type SupplierOrderAdminRow = {
	id: string;
	state: string;
	order_status: string;
	account_locked_at: number | null;
	quantity: number;
	currency: string;
	currency_decimals: number;
	quoted_unit_cost_minor: string | null;
	total_cost_minor: string | null;
	provider_request_no: string | null;
	upstream_order_id: string | null;
	attempt_count: number;
	selection_count: number;
	last_error_code: string | null;
	next_retry_at: number | null;
	submitted_at: number | null;
	supplied_at: number | null;
	created_at: number;
	order_id: string;
	order_number: string;
	product_name: string;
	sellable_item_name: string;
	provider: string;
	normalized_api_origin: string;
	upstream_product_name: string;
	upstream_sku_name: string;
	account_id: string | null;
	account_name: string | null;
};

export const listSupplierOrdersFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof supplierOrderListSchema>) =>
		supplierOrderListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "read"),
		);
		const search = data.search ? `%${data.search}%` : null;
		const where = search
			? `WHERE o.order_number LIKE ? OR so.upstream_order_id LIKE ?
			   OR sa.name LIKE ? OR sb.upstream_product_name LIKE ?
			   OR sb.upstream_sku_name LIKE ?`
			: "";
		const bindings = search ? [search, search, search, search, search] : [];
		const from = `FROM supplier_orders so
		 JOIN shop_orders o ON o.id = so.order_id
		 JOIN shop_order_items oi ON oi.id = so.order_item_id
		 JOIN supplier_bindings sb ON sb.id = so.supplier_binding_id
		 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
		 LEFT JOIN supplier_accounts sa ON sa.id = so.selected_account_id`;
		const [count, rows] = await db.batch([
			db.prepare(`SELECT COUNT(*) AS total ${from} ${where}`).bind(...bindings),
			db
				.prepare(
					`SELECT so.id, so.state, o.status AS order_status, so.account_locked_at, so.quantity, so.currency,
					        COALESCE(sa.currency_decimals, psi.currency_decimals, 2)
					          AS currency_decimals,
					        so.quoted_unit_cost_minor, so.total_cost_minor,
					        so.provider_request_no, so.upstream_order_id,
					        so.attempt_count, so.selection_count,
					        so.last_error_code, so.next_retry_at,
					        so.submitted_at, so.supplied_at, so.created_at,
					        o.id AS order_id, o.order_number,
					        oi.product_name, oi.sellable_item_name,
					        sb.provider, sb.normalized_api_origin,
					        sb.upstream_product_name, sb.upstream_sku_name,
					        sa.id AS account_id, sa.name AS account_name
					 ${from} ${where}
					 ORDER BY so.created_at DESC, so.id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...bindings, data.pageSize, data.pageIndex * data.pageSize),
		]);
		return {
			data: (rows?.results ?? []) as SupplierOrderAdminRow[],
			total: Number(
				(count?.results[0] as { total?: unknown } | undefined)?.total ?? 0,
			),
		};
	});

export const actSupplierOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierOrderActionSchema>) =>
		supplierOrderActionSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "test"),
		);
		const result = await queueSupplierOrderAction(context.db, data, {
			request: context.request,
			actorUserId: context.currentUser.id,
		});
		if (context.env.COMMERCE_QUEUE)
			await publishPendingSupplierOrders(
				context.db,
				context.env.COMMERCE_QUEUE,
				1,
			);
		return result;
	});

// The administrative server entry owns permission checks; this helper owns the transaction.
export async function queueSupplierOrderAction(
	db: D1Database,
	rawInput: z.input<typeof supplierOrderActionSchema>,
	audit: { request: Request; actorUserId: string },
) {
	const data = supplierOrderActionSchema.parse(rawInput);
	const order = await db
		.prepare(`SELECT so.id, so.state, so.selected_account_id,
	 so.account_locked_at, so.upstream_order_id, so.updated_at,
	 o.status AS order_status FROM supplier_orders so
	 JOIN shop_orders o ON o.id = so.order_id WHERE so.id = ?`)
		.bind(data.id)
		.first<{
			id: string;
			state: string;
			selected_account_id: string | null;
			account_locked_at: number | null;
			upstream_order_id: string | null;
			updated_at: number;
			order_status: string;
		}>();
	if (!order)
		throw new DomainError(
			"supplier_order_not_found",
			404,
			"Supplier order not found",
		);
	if (
		!supplierOrderActionAllowed(data.action, {
			state: order.state,
			orderStatus: order.order_status,
			accountId: order.selected_account_id,
			accountLockedAt: order.account_locked_at,
		})
	)
		throw new DomainError(
			"supplier_order_action_unavailable",
			409,
			"Supplier order action is unavailable",
		);
	if (data.action === "reselect" && order.upstream_order_id !== null)
		throw new DomainError(
			"supplier_order_account_locked",
			409,
			"A known upstream order cannot be reselected",
		);
	const now = Math.max(Date.now(), order.updated_at + 1);
	const outboxId = crypto.randomUUID();
	const eligible =
		data.action === "reselect"
			? "so.state IN ('pending', 'selecting', 'failed') AND so.selected_account_id IS NULL AND so.account_locked_at IS NULL AND so.upstream_order_id IS NULL"
			: "so.state IN ('submitting', 'uncertain') AND so.selected_account_id IS NOT NULL";
	const results = await db.batch([
		db
			.prepare(`INSERT INTO outbox_events
		 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
		 status, attempt_count, created_at, updated_at)
		 SELECT ?, 'supplier.requested', 'supplier_order', so.id, ?, ?, 'pending', 0, ?, ?
		 FROM supplier_orders so JOIN shop_orders o ON o.id = so.order_id
		 WHERE so.id = ? AND so.state = ? AND so.updated_at = ?
		 AND so.selected_account_id IS ? AND so.account_locked_at IS ?
		 AND so.upstream_order_id IS ? AND ${eligible}
		 AND o.status IN ('paid', 'fulfilling')`)
			.bind(
				outboxId,
				`supplier-admin-${data.action}:${outboxId}`,
				JSON.stringify({ supplierOrderId: data.id }),
				now,
				now,
				data.id,
				order.state,
				order.updated_at,
				order.selected_account_id,
				order.account_locked_at,
				order.upstream_order_id,
			),
		db
			.prepare(`UPDATE supplier_orders SET state = ?, next_retry_at = ?,
		 last_error_code = NULL, updated_at = ? WHERE id = ?
		 AND EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)`)
			.bind(
				data.action === "reselect" ? "pending" : order.state,
				now,
				now,
				data.id,
				outboxId,
			),
		db
			.prepare(`INSERT INTO audit_logs
		 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, before, after, created_at)
		 SELECT ?, ?, ?, 'supplier_order', ?, ?, ?, ?, ?, ?
		 WHERE EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)`)
			.bind(
				crypto.randomUUID(),
				audit.actorUserId,
				`supplier_order.${data.action}`,
				data.id,
				audit.request.headers.get("x-request-id"),
				clientIp(audit.request),
				JSON.stringify({
					state: order.state,
					selectedAccountId: order.selected_account_id,
				}),
				JSON.stringify({ queued: true }),
				now,
				outboxId,
			),
	]);
	if (results[0]?.meta.changes !== 1)
		throw new DomainError(
			"supplier_order_changed",
			409,
			"Supplier order changed; refresh and retry",
		);
	return { id: data.id, queued: true };
}
