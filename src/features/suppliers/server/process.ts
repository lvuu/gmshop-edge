import {
	fingerprintInventorySecret,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	OperationTaskAlreadyRunningError,
	runTrackedTask,
} from "#/features/operations/server/task-runs";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { multiplyMinor } from "../money";
import { providerRequestNumber } from "../providers/signatures";
import {
	type SupplierPurchaseResult,
	supplierServiceOrderInputSchema,
	supplierSuppliedResultSchema,
} from "../schema";
import {
	adapterForSupplierAccount,
	type SupplierAccountRuntimeRow,
} from "./account-runtime";
import { claimSupplierApiBudget } from "./rate-limit";

type SupplierOrderContext = {
	id: string;
	order_item_id: string;
	delivery_record_id: string;
	quantity: number;
	currency: string;
	state:
		| "pending"
		| "selecting"
		| "submitting"
		| "uncertain"
		| "supplied"
		| "failed"
		| "refunded";
	selected_account_id: string | null;
	selected_credentials_revision: number | null;
	account_locked_at: number | null;
	provider_request_no: string | null;
	upstream_order_id: string | null;
	binding_snapshot_json: string;
	updated_at: number;
};

type BindingSnapshot = {
	provider: "acg" | "dujiao_next" | "gmshop_edge" | "dhru";
	normalizedApiOrigin: string;
	protocolVersion: string;
	upstreamProductId: string;
	upstreamSkuId: string;
	maxCostMinor: string;
	currencyDecimals?: number;
};

type CandidateAccount = SupplierAccountRuntimeRow & {
	normalized_api_origin: string;
	protocol_version: string;
	balance_minor: string | null;
	reserve_balance_minor: string;
	max_order_cost_minor: string | null;
	consecutive_failures: number;
	last_selected_at: number | null;
};

export async function processSupplierOrder(
	db: D1Database,
	supplierOrderId: string,
	options: {
		fetcher?: typeof fetch;
		now?: number;
		callbackOrigin?: string;
	} = {},
) {
	return runTrackedTask(
		db,
		{
			task: `supplier.order.${supplierOrderId}`,
			trigger: "scheduled",
			now: options.now,
		},
		() => processSupplierOrderUnlocked(db, supplierOrderId, options),
	);
}

export async function completeSupplierOrderFromCallback(
	db: D1Database,
	supplierOrderId: string,
	result: Extract<SupplierPurchaseResult, { status: "supplied" }>,
) {
	result = supplierSuppliedResultSchema.parse(result);
	const order = await loadOrder(db, supplierOrderId);
	if (!order)
		throw new DomainError(
			"supplier_order_not_found",
			404,
			"Supplier order not found",
		);
	if (order.state === "supplied")
		return { id: order.id, state: "supplied", duplicate: true };
	if (order.state !== "submitting" && order.state !== "uncertain")
		throw new DomainError(
			"supplier_order_callback_state_invalid",
			409,
			"Supplier order cannot accept this callback",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"supplier_configuration_unavailable",
			503,
			"Supplier configuration unavailable",
		);
	return fulfillSupplierOrder(db, order, result, runtime.commerceSecret);
}

async function processSupplierOrderUnlocked(
	db: D1Database,
	supplierOrderId: string,
	options: { fetcher?: typeof fetch; now?: number; callbackOrigin?: string },
) {
	const order = await loadOrder(db, supplierOrderId);
	if (!order)
		throw new DomainError(
			"supplier_order_not_found",
			404,
			"Supplier order not found",
		);
	if (order.state === "supplied")
		return { id: order.id, state: "supplied", duplicate: true };
	if (order.state === "failed" || order.state === "refunded")
		throw new DomainError(
			"supplier_order_terminal",
			409,
			"Supplier order cannot be processed",
		);
	const fulfillable = await db
		.prepare(`SELECT 1 AS ready FROM shop_order_items oi
	 JOIN shop_orders o ON o.id = oi.order_id WHERE oi.id = ? AND o.status IN ('paid', 'fulfilling')`)
		.bind(order.order_item_id)
		.first();
	if (!fulfillable)
		throw new DomainError(
			"supplier_order_terminal",
			409,
			"Order cannot be supplied",
			{ retryable: false },
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"supplier_configuration_unavailable",
			503,
			"Supplier configuration unavailable",
		);
	const snapshot = parseBindingSnapshot(order.binding_snapshot_json);
	if (
		snapshot.provider === "dhru" &&
		order.selected_account_id &&
		!order.upstream_order_id
	)
		return applyPurchaseResult(
			db,
			order,
			{
				status: "uncertain",
				upstreamOrderId: null,
				errorCode: "supplier_order_id_missing",
			},
			runtime.commerceSecret,
		);
	const service = await loadServiceInput(
		db,
		order.order_item_id,
		snapshot,
		runtime.commerceSecret,
	);
	if (order.selected_account_id) {
		const account = await loadSelectedAccount(db, order.selected_account_id);
		if (!account || !order.selected_credentials_revision)
			throw new DomainError(
				"supplier_locked_account_unavailable",
				409,
				"Locked supplier account unavailable",
				{ retryable: true },
			);
		const adapter = await adapterForSupplierAccount(account, runtime, {
			revision: order.selected_credentials_revision,
			fetcher: options.fetcher,
		});
		await claimSupplierApiBudget(db, {
			provider: snapshot.provider,
			normalizedApiOrigin: snapshot.normalizedApiOrigin,
			protocolVersion: snapshot.protocolVersion,
			accountId: account.id,
		});
		const result = await adapter.reconcileOrder({
			upstreamOrderId: order.upstream_order_id,
			skuId: snapshot.upstreamSkuId,
			quantity: order.quantity,
			requestNo: order.provider_request_no ?? "",
			callbackUrl: service
				? serviceCallbackUrl(
						options.callbackOrigin ?? runtime.betterAuthUrl,
						account.id,
					)
				: callbackUrl(options.callbackOrigin, account.id),
			traceId: order.id,
			service,
		});
		return applyPurchaseResult(db, order, result, runtime.commerceSecret);
	}

	const now = options.now ?? Date.now();
	await db
		.prepare(
			`UPDATE supplier_orders SET state = 'selecting', updated_at = ?
			 WHERE id = ? AND state = 'pending' AND selected_account_id IS NULL`,
		)
		.bind(now, order.id)
		.run();
	const candidates = await candidateAccounts(
		db,
		snapshot,
		now,
		service ? order.currency : null,
	);
	for (const candidate of candidates) {
		let submissionStarted = false;
		let receivedOrderId: string | null = null;
		try {
			return await runTrackedTask(
				db,
				{
					task: `supplier.account.${candidate.id}`,
					trigger: "scheduled",
					now,
				},
				async () => {
					await claimSupplierApiBudget(db, {
						provider: snapshot.provider,
						normalizedApiOrigin: snapshot.normalizedApiOrigin,
						protocolVersion: snapshot.protocolVersion,
						accountId: candidate.id,
						now,
					});
					const adapter = await adapterForSupplierAccount(candidate, runtime, {
						fetcher: options.fetcher,
					});
					const [connection, sku] = await Promise.all([
						adapter.testConnection(),
						service
							? serviceQuote(adapter, snapshot.upstreamProductId)
							: adapter.getSku(
									snapshot.upstreamProductId,
									snapshot.upstreamSkuId,
								),
					]);
					const totalCostMinor = multiplyMinor(sku.costMinor, order.quantity);
					await assertCandidateBudget(
						db,
						candidate,
						connection.balance.amountMinor,
						totalCostMinor,
						service ? order.quantity : sku.stockQuantity,
						order.quantity,
						sku.active,
						sku.costMinor,
						snapshot.maxCostMinor,
					);
					const requestNo = providerRequestNumber(
						snapshot.provider,
						order.id,
						candidate.id,
					);
					const claimed = await db
						.prepare(
							`UPDATE supplier_orders SET selected_account_id = ?,
							 selected_credentials_revision = ?, provider_request_no = ?,
							 quoted_unit_cost_minor = ?, total_cost_minor = ?,
							 state = 'submitting', attempt_count = attempt_count + 1,
							 selection_count = selection_count + 1, submitted_at = ?,
							 next_retry_at = NULL, last_error_code = NULL, updated_at = ?
							 WHERE id = ? AND selected_account_id IS NULL
							 AND state IN ('pending', 'selecting')
 AND EXISTS (SELECT 1 FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id WHERE oi.id = supplier_orders.order_item_id AND o.status IN ('paid', 'fulfilling'))`,
						)
						.bind(
							candidate.id,
							candidate.credentials_revision,
							requestNo,
							sku.costMinor,
							totalCostMinor,
							now,
							now,
							order.id,
						)
						.run();
					if (Number(claimed.meta.changes) !== 1)
						throw new DomainError(
							"supplier_order_claim_conflict",
							409,
							"Supplier order was claimed concurrently",
							{ retryable: true },
						);
					await db
						.prepare(
							`UPDATE supplier_accounts SET balance_minor = ?,
							 balance_synced_at = ?, health_status = 'healthy',
							 consecutive_failures = 0, last_selected_at = ?,
							 last_error_code = NULL, updated_at = ? WHERE id = ?`,
						)
						.bind(connection.balance.amountMinor, now, now, now, candidate.id)
						.run();
					// After this boundary, only a persisted definitive rejection may release
					// the account. A local persistence failure says nothing about the purchase.
					submissionStarted = true;
					const result = await adapter.submitOrder({
						skuId: snapshot.upstreamSkuId,
						quantity: order.quantity,
						requestNo,
						callbackUrl: service
							? serviceCallbackUrl(
									options.callbackOrigin ?? runtime.betterAuthUrl,
									candidate.id,
								)
							: callbackUrl(options.callbackOrigin, candidate.id),
						traceId: order.id,
						service,
					});
					receivedOrderId =
						"upstreamOrderId" in result ? result.upstreamOrderId : null;
					return applyPurchaseResult(
						db,
						{
							...order,
							selected_account_id: candidate.id,
							selected_credentials_revision: candidate.credentials_revision,
							provider_request_no: requestNo,
							state: "submitting",
						},
						result,
						runtime.commerceSecret,
					);
				},
			);
		} catch (error) {
			if (
				!submissionStarted &&
				error instanceof OperationTaskAlreadyRunningError
			)
				continue;
			const current = await loadOrder(db, order.id);
			if (current?.selected_account_id === candidate.id) {
				if (!["submitting", "uncertain"].includes(current.state)) throw error;
				if (current.state === "uncertain") throw error;
				if (submissionStarted || isUncertainError(error)) {
					await markUncertain(
						db,
						current,
						"supplier_request_uncertain",
						receivedOrderId,
					);
					throw new DomainError(
						"supplier_request_uncertain",
						503,
						"Supplier request outcome requires reconciliation",
					);
				}
				await releaseDefinitiveFailure(
					db,
					current,
					candidate.id,
					errorCode(error),
					now,
				);
			}
		}
	}
	await db
		.prepare(
			`UPDATE supplier_orders SET state = 'failed',
			 last_error_code = 'supplier_accounts_exhausted',
			 next_retry_at = NULL, updated_at = ?
			 WHERE id = ? AND selected_account_id IS NULL
			 AND state IN ('pending', 'selecting')`,
		)
		.bind(now, order.id)
		.run();
	throw new DomainError(
		"supplier_accounts_exhausted",
		409,
		"No supplier account can fulfill this order",
	);
}

async function applyPurchaseResult(
	db: D1Database,
	order: SupplierOrderContext,
	result: SupplierPurchaseResult,
	commerceSecret: string,
) {
	if (result.status === "supplied")
		return fulfillSupplierOrder(db, order, result, commerceSecret);
	if (result.status === "processing" || result.status === "uncertain") {
		const isDhru =
			parseBindingSnapshot(order.binding_snapshot_json).provider === "dhru";
		await db
			.prepare(
				`UPDATE supplier_orders SET state = 'uncertain',
				 upstream_order_id = COALESCE(?, upstream_order_id),
				 account_locked_at = COALESCE(account_locked_at, ?),
				 next_retry_at = CASE WHEN ? AND COALESCE(?, upstream_order_id) IS NULL
				  THEN NULL ELSE ? END, last_error_code = ?, updated_at = ?
				 WHERE id = ? AND selected_account_id IS NOT NULL
				 AND state IN ('submitting', 'uncertain')`,
			)
			.bind(
				result.upstreamOrderId,
				Date.now(),
				isDhru ? 1 : 0,
				result.upstreamOrderId,
				Date.now() + 15_000,
				result.status === "processing"
					? "supplier_order_processing"
					: result.errorCode,
				Date.now(),
				order.id,
			)
			.run();
		throw new DomainError(
			"supplier_order_pending",
			503,
			"Supplier order is still pending",
		);
	}
	if (order.account_locked_at !== null || order.upstream_order_id !== null) {
		// A final rejection of an accepted purchase is terminal. Its identity and
		// credential revision remain locked; another account must never buy again.
		const rejected = await db
			.prepare(`UPDATE supplier_orders AS so
			 SET state = 'failed', next_retry_at = NULL, last_error_code = ?, updated_at = ?
			 WHERE so.id = ? AND so.state = ? AND so.updated_at = ?
			 AND so.state IN ('submitting', 'uncertain')
			 AND so.selected_account_id IS ? AND so.selected_credentials_revision IS ?
			 AND so.account_locked_at IS ? AND so.provider_request_no IS ?
			 AND so.upstream_order_id IS ?
			 AND EXISTS (SELECT 1 FROM shop_orders o WHERE o.id = so.order_id
			  AND o.status IN ('paid', 'fulfilling'))`)
			.bind(
				result.errorCode,
				Math.max(Date.now(), order.updated_at + 1),
				order.id,
				order.state,
				order.updated_at,
				order.selected_account_id,
				order.selected_credentials_revision,
				order.account_locked_at,
				order.provider_request_no,
				order.upstream_order_id,
			)
			.run();
		if (rejected.meta.changes !== 1)
			throw new DomainError(
				"supplier_order_changed",
				409,
				"Supplier order changed during reconciliation",
				{ retryable: true },
			);
	} else {
		await releaseDefinitiveFailure(
			db,
			order,
			order.selected_account_id ?? "",
			result.errorCode,
			Date.now(),
		);
	}
	throw new DomainError(
		result.errorCode,
		409,
		"Supplier definitively rejected the order",
	);
}

async function fulfillSupplierOrder(
	db: D1Database,
	order: SupplierOrderContext,
	result: Extract<SupplierPurchaseResult, { status: "supplied" }>,
	commerceSecret: string,
) {
	result = supplierSuppliedResultSchema.parse(result);
	const delivery = await db
		.prepare("SELECT delivery_type FROM delivery_records WHERE id = ?")
		.bind(order.delivery_record_id)
		.first<{ delivery_type: string }>();
	if (delivery?.delivery_type !== result.fulfillment.type)
		throw new DomainError(
			"supplier_delivery_type_mismatch",
			409,
			"Supplier result does not match the delivery type",
			{ retryable: false },
		);
	if (result.fulfillment.type === "service")
		return fulfillServiceSupplierOrder(db, order, result, commerceSecret);
	const cards = [
		...new Set(result.fulfillment.cards.map((value) => value.trim())),
	].filter(Boolean);
	if (cards.length !== order.quantity)
		throw new DomainError(
			"supplier_delivery_quantity_mismatch",
			502,
			"Supplier delivery quantity mismatch",
		);
	const prepared = await Promise.all(
		cards.map(async (card, index) => ({
			id: await deterministicSupplierStockId(order.id, index),
			encrypted: await encryptSecret(card, commerceSecret, "stock-entry"),
			fingerprint: await fingerprintInventorySecret(card, commerceSecret),
			mask: maskInventorySecret(card),
		})),
	);
	const now = Date.now();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE supplier_orders SET state = 'supplied',
				 upstream_order_id = ?, supplied_at = ?, next_retry_at = NULL,
				 last_error_code = NULL, updated_at = ?
				 WHERE id = ? AND state IN ('submitting', 'uncertain')`,
			)
			.bind(result.upstreamOrderId, now, now, order.id),
	];
	statements.push(
		...prepared.map((entry) =>
			db
				.prepare(
					`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  supplier_order_id, reserved_at, created_at, updated_at)
				 SELECT ?, oi.sellable_item_id, ?, 1, ?, ?, 'reserved', ?,
				  ?, ?, ?, ? FROM shop_order_items oi WHERE oi.id = ?
				 ON CONFLICT(id) DO NOTHING`,
				)
				.bind(
					entry.id,
					entry.encrypted,
					entry.fingerprint,
					entry.mask,
					order.order_item_id,
					order.id,
					now,
					now,
					now,
					order.order_item_id,
				),
		),
		db
			.prepare(
				`UPDATE delivery_records SET status = 'pending',
				 next_attempt_at = ?, error_code = NULL, updated_at = ?
				 WHERE id = ? AND status = 'awaiting_supply'`,
			)
			.bind(now, now, order.delivery_record_id),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
				  payload, status, attempt_count, created_at, updated_at)
				 VALUES (?, 'delivery.requested', 'delivery', ?, ?, ?, 'pending', 0, ?, ?)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				order.delivery_record_id,
				`supplier-delivery-requested:${order.delivery_record_id}`,
				JSON.stringify({
					deliveryId: order.delivery_record_id,
					orderItemId: order.order_item_id,
				}),
				now,
				now,
			),
	);
	const results = await db.batch(statements);
	const duplicate = Number(results[0]?.meta.changes ?? 0) !== 1;
	return { id: order.id, state: "supplied", duplicate };
}

async function fulfillServiceSupplierOrder(
	db: D1Database,
	order: SupplierOrderContext,
	result: Extract<SupplierPurchaseResult, { status: "supplied" }>,
	commerceSecret: string,
) {
	const encrypted = await encryptDeliveryContent(
		JSON.stringify(result.fulfillment),
		commerceSecret,
	);
	const now = Date.now();
	const results = await db.batch([
		db
			.prepare(`UPDATE supplier_orders SET state = 'supplied', upstream_order_id = ?,
   supplied_at = ?, next_retry_at = NULL, last_error_code = NULL, updated_at = ?
   WHERE id = ? AND state IN ('submitting', 'uncertain')
   AND EXISTS (SELECT 1 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
    JOIN shop_orders o ON o.id = oi.order_id WHERE dr.id = ?
    AND dr.delivery_type = 'service' AND dr.status = 'awaiting_supply'
    AND o.status IN ('paid', 'fulfilling'))`)
			.bind(
				result.upstreamOrderId,
				now,
				now,
				order.id,
				order.delivery_record_id,
			),
		db
			.prepare(`UPDATE delivery_records SET status = 'pending', content_encrypted = ?,
   content_key_version = 1, next_attempt_at = ?, error_code = NULL, updated_at = ?
   WHERE id = ? AND delivery_type = 'service' AND status = 'awaiting_supply'
   AND EXISTS (SELECT 1 FROM supplier_orders WHERE id = ? AND state = 'supplied')`)
			.bind(encrypted, now, now, order.delivery_record_id, order.id),
		db
			.prepare(`INSERT INTO outbox_events
   (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload, status, attempt_count, created_at, updated_at)
   SELECT ?, 'delivery.requested', 'delivery', ?, ?, ?, 'pending', 0, ?, ?
   FROM delivery_records WHERE id = ? AND delivery_type = 'service' AND status = 'pending'
   ON CONFLICT(idempotency_key) DO NOTHING`)
			.bind(
				crypto.randomUUID(),
				order.delivery_record_id,
				`supplier-delivery-requested:${order.delivery_record_id}`,
				JSON.stringify({
					deliveryId: order.delivery_record_id,
					orderItemId: order.order_item_id,
				}),
				now,
				now,
				order.delivery_record_id,
			),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1) {
		const current = await loadOrder(db, order.id);
		if (current?.state !== "supplied")
			throw new DomainError(
				"supplier_service_delivery_conflict",
				409,
				"Service order is not fulfillable",
				{ retryable: false },
			);
		return { id: order.id, state: "supplied", duplicate: true };
	}
	return { id: order.id, state: "supplied", duplicate: false };
}

async function deterministicSupplierStockId(orderId: string, index: number) {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`supplier-stock:${orderId}:${index}`),
		),
	).slice(0, 16);
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function candidateAccounts(
	db: D1Database,
	snapshot: BindingSnapshot,
	now: number,
	currency: string | null,
) {
	const rows = await db
		.prepare(
			`SELECT * FROM supplier_accounts WHERE provider = ?
			 AND normalized_api_origin = ? AND protocol_version = ?
			 AND enabled = 1 AND health_status <> 'unavailable'
			 AND (? IS NULL OR currency = ?)
			 AND (? IS NULL OR currency_decimals = ?)
			 AND (cooldown_until IS NULL OR cooldown_until <= ?)
			 ORDER BY consecutive_failures, COALESCE(last_selected_at, 0),
			 LENGTH(balance_minor) DESC, balance_minor DESC, id LIMIT 20`,
		)
		.bind(
			snapshot.provider,
			snapshot.normalizedApiOrigin,
			snapshot.protocolVersion,
			currency,
			currency,
			currency ? (snapshot.currencyDecimals ?? null) : null,
			currency ? (snapshot.currencyDecimals ?? null) : null,
			now,
		)
		.all<CandidateAccount>();
	return rows.results;
}

async function assertCandidateBudget(
	db: D1Database,
	account: CandidateAccount,
	balanceMinor: string,
	totalCostMinor: string,
	stockQuantity: number,
	quantity: number,
	active: boolean,
	unitCostMinor: string,
	maxCostMinor: string,
) {
	const commitments = await db
		.prepare(
			`SELECT total_cost_minor FROM supplier_orders
			 WHERE selected_account_id = ? AND state IN ('submitting', 'uncertain')`,
		)
		.bind(account.id)
		.all<{ total_cost_minor: string }>();
	const committed = commitments.results.reduce(
		(total, row) => total + BigInt(row.total_cost_minor),
		0n,
	);
	const effective =
		BigInt(balanceMinor) - BigInt(account.reserve_balance_minor) - committed;
	if (
		!active ||
		stockQuantity < quantity ||
		BigInt(unitCostMinor) > BigInt(maxCostMinor) ||
		effective < BigInt(totalCostMinor) ||
		(account.max_order_cost_minor !== null &&
			BigInt(totalCostMinor) > BigInt(account.max_order_cost_minor))
	)
		throw new DomainError(
			"supplier_account_ineligible",
			409,
			"Supplier account cannot fulfill this order",
		);
}

async function releaseDefinitiveFailure(
	db: D1Database,
	order: SupplierOrderContext,
	accountId: string,
	code: string,
	now: number,
) {
	await db.batch([
		db
			.prepare(
				`UPDATE supplier_orders SET selected_account_id = NULL,
				 selected_credentials_revision = NULL, provider_request_no = NULL,
				 upstream_order_id = NULL, quoted_unit_cost_minor = NULL,
				 total_cost_minor = NULL, account_locked_at = NULL, state = 'selecting',
				 last_error_code = ?, updated_at = ? WHERE id = ?
				 AND selected_account_id = ? AND account_locked_at IS NULL`,
			)
			.bind(code, now, order.id, accountId),
		db
			.prepare(
				`UPDATE supplier_accounts SET health_status = 'degraded',
				 consecutive_failures = consecutive_failures + 1,
				 cooldown_until = ?, last_error_code = ?, last_error_at = ?,
				 updated_at = ? WHERE id = ?`,
			)
			.bind(now + 60_000, code, now, now, accountId),
	]);
}

async function markUncertain(
	db: D1Database,
	order: SupplierOrderContext,
	code: string,
	upstreamOrderId: string | null = null,
) {
	const now = Date.now();
	const isDhru =
		parseBindingSnapshot(order.binding_snapshot_json).provider === "dhru";
	await db
		.prepare(
			`UPDATE supplier_orders SET state = 'uncertain',
			 upstream_order_id = COALESCE(upstream_order_id, ?),
			 account_locked_at = COALESCE(account_locked_at, ?),
			 next_retry_at = CASE WHEN ? AND COALESCE(upstream_order_id, ?) IS NULL
			  THEN NULL ELSE ? END, last_error_code = ?, updated_at = ?
			 WHERE id = ? AND selected_account_id = ?
			 AND state IN ('submitting', 'uncertain')`,
		)
		.bind(
			upstreamOrderId,
			now,
			isDhru ? 1 : 0,
			upstreamOrderId,
			now + 15_000,
			code,
			now,
			order.id,
			order.selected_account_id,
		)
		.run();
}

function loadOrder(db: D1Database, id: string) {
	return db
		.prepare("SELECT * FROM supplier_orders WHERE id = ? LIMIT 1")
		.bind(id)
		.first<SupplierOrderContext>();
}

function loadSelectedAccount(db: D1Database, id: string) {
	return db
		.prepare("SELECT * FROM supplier_accounts WHERE id = ? LIMIT 1")
		.bind(id)
		.first<CandidateAccount>();
}

function parseBindingSnapshot(value: string): BindingSnapshot {
	const parsed = JSON.parse(value) as Partial<BindingSnapshot>;
	if (
		!(["acg", "dujiao_next", "gmshop_edge", "dhru"] as const).includes(
			parsed.provider as "acg" | "dujiao_next" | "gmshop_edge" | "dhru",
		) ||
		!parsed.normalizedApiOrigin ||
		!parsed.protocolVersion ||
		!parsed.upstreamProductId ||
		!parsed.upstreamSkuId ||
		!parsed.maxCostMinor
	)
		throw new DomainError(
			"supplier_binding_snapshot_invalid",
			500,
			"Supplier binding snapshot invalid",
		);
	return parsed as BindingSnapshot;
}

function callbackUrl(origin: string | undefined, accountId: string) {
	return origin
		? new URL(
				`/api/suppliers/dujiao-next/callback/${encodeURIComponent(accountId)}`,
				origin,
			).toString()
		: "";
}

function isUncertainError(error: unknown) {
	return (
		error instanceof DomainError && error.code === "supplier_request_uncertain"
	);
}

function errorCode(error: unknown) {
	return error instanceof DomainError ? error.code : "supplier_request_failed";
}

async function serviceQuote(
	adapter: import("../providers/types").SupplierAdapter,
	productId: string,
) {
	if (!adapter.getServiceQuote)
		throw new DomainError(
			"supplier_service_not_ready",
			409,
			"Provider does not support service quotes",
			{ retryable: false },
		);
	const quote = await adapter.getServiceQuote(productId);
	return { ...quote, active: true, stockQuantity: 0 };
}
async function loadServiceInput(
	db: D1Database,
	orderItemId: string,
	snapshot: BindingSnapshot,
	secret: string,
) {
	const item = await db
		.prepare(
			"SELECT delivery_component_type, input_values_json, sensitive_input_values_json FROM shop_order_items WHERE id = ?",
		)
		.bind(orderItemId)
		.first<{
			delivery_component_type: string;
			input_values_json: string;
			sensitive_input_values_json: string;
		}>();
	if (item?.delivery_component_type !== "service") {
		if (snapshot.provider === "dhru")
			throw new DomainError(
				"supplier_delivery_type_mismatch",
				409,
				"Dhru requires a service product",
				{ retryable: false },
			);
		return undefined;
	}
	const inputData = JSON.parse(item.input_values_json) as Record<
		string,
		string
	>;
	const sensitive = JSON.parse(item.sensitive_input_values_json) as Record<
		string,
		{ envelope: string }
	>;
	for (const [key, value] of Object.entries(sensitive))
		inputData[key] = await decryptSecret(value.envelope, secret, "order-input");
	return supplierServiceOrderInputSchema.parse({
		productId: snapshot.upstreamProductId,
		inputData,
	});
}
function serviceCallbackUrl(origin: string, accountId: string) {
	return new URL(
		`/api/suppliers/dhru/callback/${encodeURIComponent(accountId)}`,
		origin,
	).toString();
}
