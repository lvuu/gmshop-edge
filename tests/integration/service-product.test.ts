import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDelivery } from "#/features/fulfillment/server/process";
import { completeManualStoreOrder } from "#/features/shop-payments/server/service";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { handleDhruSupplierCallback } from "#/features/suppliers/server/dhru-callback";
import {
	listSupplierOrders,
	queueSupplierOrderAction,
} from "#/features/suppliers/server/orders-admin";
import {
	publishPendingSupplierOrders,
	queueDueSupplierReconciliations,
} from "#/features/suppliers/server/outbox";
import {
	completeSupplierOrderFromCallback,
	processSupplierOrder,
} from "#/features/suppliers/server/process";
import {
	bindServiceSupplier,
	previewServiceSupplier,
} from "#/features/suppliers/server/service-binding";
import { handleQueue } from "#/server/queue/routing";
import type { SupplierQueueMessage } from "#/server/queue/types";
import {
	createInitialRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

vi.mock("#/server/outbound-fetch", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/outbound-fetch")>();
	return {
		...actual,
		fetchOutbound: (
			input: string | URL,
			init: RequestInit,
			options: import("#/server/outbound-fetch").OutboundFetchOptions,
		) =>
			actual.fetchOutbound(input, init, {
				...options,
				validateDestination: false,
			}),
	};
});

describe("service products", { timeout: 30_000 }, () => {
	let mf: Miniflare, db: D1Database;
	const runtime = createInitialRuntimeConfig("https://shop.example");
	const productId = crypto.randomUUID(),
		itemId = crypto.randomUUID(),
		accountId = crypto.randomUUID();
	let posts: number, postedFields: Record<string, unknown>;
	const fetcher: typeof fetch = async (input, init) => {
		const r = new Request(input, init),
			url = new URL(r.url);
		let data: unknown;
		if (url.pathname.endsWith("/account"))
			data = {
				currency: "USD",
				balance: "100.00",
				name: "Test",
				email: "test@example.com",
			};
		else if (url.pathname.endsWith("/products"))
			data = {
				product_id: 123,
				name: "Test service",
				type: "imei",
				price: "1.00",
				fields: [],
			};
		else if (r.method === "POST") {
			posts++;
			const body = (await r.json()) as Array<{
				fields: Array<Record<string, unknown>>;
			}>;
			postedFields = body[0]?.fields[0] ?? {};
			data = [
				[
					{
						order_uuid: "D1",
						reference_id: postedFields.reference_id,
						amount: "1.00",
						currency_code: "USD",
					},
				],
			];
		} else data = { quantity: 1, replay: "Status: Clean", status: "success" };
		return Response.json({ status: "success", code: 200, data });
	};
	beforeEach(async () => {
		posts = 0;
		postedFields = {};
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		const encrypted = await createSupplierCredentialVault(
			"dhru",
			{ apiToken: "test-token" },
			runtime.commerceSecret,
		);
		await db.batch([
			db
				.prepare(
					"INSERT INTO users (id, name, email) VALUES (?, 'Admin', 'admin@example.com')",
				)
				.bind(accountId),
			...runtimeConfigEntries(runtime).map((e) =>
				db
					.prepare(
						"INSERT INTO system_settings (key, value, is_secret) VALUES (?, ?, ?)",
					)
					.bind(e.key, JSON.stringify(e.value), e.isSecret),
			),
			db
				.prepare(
					"INSERT INTO products (id, name, product_type, status) VALUES (?, 'Service', 'service', 'active')",
				)
				.bind(productId),
			db
				.prepare(
					"INSERT INTO product_sellable_items (id, product_id, name, fulfillment_source, supplier_status, price_minor, currency, currency_decimals, renewal_mode) VALUES (?, ?, 'Service', 'supplier', 'available', '100', 'USD', 2, 'disabled')",
				)
				.bind(itemId, productId),
			db
				.prepare(`INSERT INTO supplier_accounts (id, provider, base_url, normalized_api_origin, protocol_version, currency, currency_decimals, name, credentials_encrypted, credential_fingerprint, balance_minor, health_status, enabled)
     VALUES (?, 'dhru', 'https://supplier.example', 'https://supplier.example', 'dhru-reseller-v1', 'USD', 2, 'Test', ?, 'test', '10000', 'healthy', 1)`)
				.bind(accountId, encrypted),
			db
				.prepare(`INSERT INTO supplier_bindings (id, sellable_item_id, provider, normalized_api_origin, protocol_version, upstream_product_id, upstream_sku_id, upstream_product_name, upstream_sku_name, reference_cost_minor, max_cost_minor, stock_quantity, remote_status, last_synced_at)
     VALUES (?, ?, 'dhru', 'https://supplier.example', 'dhru-reseller-v1', '123', '123', 'Service', 'Service', '100', '150', 0, 'active', 0)`)
				.bind(crypto.randomUUID(), itemId),
		]);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await mf.dispose();
	});
	const checkout = () =>
		createMultiStoreOrder(db, {
			email: "buyer@example.com",
			idempotencyKey: crypto.randomUUID(),
			items: [{ sellableItemId: itemId, quantity: 1 }],
		});
	const pay = async (orderId: string) =>
		completeManualStoreOrder(db, {
			orderId,
			version: 1,
			actorUserId: null,
			note: "Test payment",
			ipAddress: null,
			requestId: null,
		});

	it("purchases a service with zero stock, submits once, reconciles and privately delivers", async () => {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare(
				"SELECT id, delivery_record_id FROM supplier_orders WHERE order_id = ?",
			)
			.bind(order.id)
			.first<{ id: string; delivery_record_id: string }>();
		if (!supplier) throw new Error("missing supplier task");
		expect(
			await db
				.prepare(
					"SELECT delivery_type, status FROM delivery_records WHERE id = ?",
				)
				.bind(supplier.delivery_record_id)
				.first(),
		).toMatchObject({ delivery_type: "service", status: "awaiting_supply" });
		expect(
			await db
				.prepare(
					"SELECT event_type, payload FROM outbox_events WHERE event_type = 'supplier.requested'",
				)
				.first(),
		).toMatchObject({
			event_type: "supplier.requested",
			payload: JSON.stringify({ supplierOrderId: supplier.id }),
		});
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(posts).toBe(1);
		expect(postedFields.reference_id).toBe(supplier.id);
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).resolves.toMatchObject({ state: "supplied" });
		await processDelivery(db, supplier.delivery_record_id);
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).resolves.toMatchObject({ duplicate: true });
		expect(posts).toBe(1);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM stock_entries").first("n"),
		).toBe(0);
		expect(
			await db
				.prepare("SELECT entitlement_type, status FROM customer_entitlements")
				.first(),
		).toMatchObject({ entitlement_type: "service", status: "active" });
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "wrong@example.com",
			}),
		).rejects.toThrow();
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "buyer@example.com",
			}),
		).resolves.toMatchObject({ content: "Status: Clean" });
		await db.prepare("UPDATE entitlement_grants SET status = 'revoked'").run();
		expect(
			(
				await getStoreOrder(db, {
					orderNumber: order.orderNumber,
					email: "buyer@example.com",
				})
			).deliveries[0]?.hasContent,
		).toBe(false);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "buyer@example.com",
			}),
		).rejects.toMatchObject({ code: "delivery_not_found" });
		await db.prepare("UPDATE entitlement_grants SET status = 'active'").run();
		await db
			.prepare("UPDATE shop_orders SET status = 'refunded' WHERE id = ?")
			.bind(order.id)
			.run();
		expect(
			(
				await getStoreOrder(db, {
					orderNumber: order.orderNumber,
					email: "buyer@example.com",
				})
			).deliveries[0]?.hasContent,
		).toBe(false);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "buyer@example.com",
			}),
		).rejects.toMatchObject({ code: "delivery_not_found" });
	});

	it("shows terminal procurement failure and clears it after manual reselection", async () => {
		const order = await checkout();
		await pay(order.id);
		await db
			.prepare(
				"UPDATE supplier_orders SET state = 'failed', last_error_code = 'private-provider-error' WHERE order_id = ?",
			)
			.bind(order.id)
			.run();
		const failed = await getStoreOrder(db, {
			orderNumber: order.orderNumber,
			email: "buyer@example.com",
		});
		expect(failed.deliveries[0]).toMatchObject({
			type: "service",
			status: "failed",
			hasContent: false,
		});
		expect(JSON.stringify(failed)).not.toContain("private-provider-error");
		expect(
			await db
				.prepare(
					"SELECT dr.status FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id WHERE oi.order_id = ?",
				)
				.bind(order.id)
				.first("status"),
		).toBe("awaiting_supply");
		await db
			.prepare(
				"UPDATE supplier_orders SET state = 'pending' WHERE order_id = ?",
			)
			.bind(order.id)
			.run();
		const retry = await getStoreOrder(db, {
			orderNumber: order.orderNumber,
			email: "buyer@example.com",
		});
		expect(retry.deliveries[0]?.status).toBe("awaiting_supply");
		const plan = await db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT 1 FROM supplier_orders WHERE order_item_id = ? AND delivery_record_id = ? AND state = 'failed'",
			)
			.bind("item", "delivery")
			.all();
		expect(JSON.stringify(plan.results)).toContain(
			"supplier_orders_order_item_uidx",
		);
	});

	it("refuses a mismatched product record before binding or paid procurement", async () => {
		const wrongProduct: typeof fetch = async (input, init) => {
			const response = await fetcher(input, init);
			if (new URL(String(input)).pathname.endsWith("/products")) {
				const body = (await response.json()) as {
					data: Record<string, unknown>;
				};
				body.data.product_id = 999;
				return Response.json(body);
			}
			return response;
		};
		const count = () =>
			db.prepare("SELECT COUNT(*) AS n FROM supplier_bindings").first("n");
		const before = await count();
		await expect(
			previewServiceSupplier(
				db,
				{
					sellableItemId: itemId,
					accountId,
					expectedRevision: 1,
					productId: "123",
					maxCostMinor: "150",
				},
				{ fetcher: wrongProduct },
			),
		).rejects.toMatchObject({ outcome: "read_failed" });
		expect(await count()).toBe(before);
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
			.bind(order.id)
			.first<{ id: string }>();
		if (!supplier) throw new Error("missing supplier");
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher: wrongProduct }),
		).rejects.toMatchObject({ code: "supplier_accounts_exhausted" });
		expect(posts).toBe(0);
	});
	it("holds an explicitly wrong queried order and later delivers the correct order without another POST", async () => {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare(
				"SELECT id, delivery_record_id FROM supplier_orders WHERE order_id = ?",
			)
			.bind(order.id)
			.first<{ id: string; delivery_record_id: string }>();
		if (!supplier) throw new Error("missing supplier");
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const wrongOrder: typeof fetch = async (input, init) => {
			if (new URL(String(input)).pathname.endsWith("/order"))
				return Response.json({
					status: "success",
					code: 200,
					data: {
						quantity: 1,
						status: "success",
						order_uuid: "OTHER",
						replay: "Wrong private result",
					},
				});
			return fetcher(input, init);
		};
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher: wrongOrder }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(
			await db
				.prepare(
					"SELECT state, upstream_order_id, last_error_code FROM supplier_orders WHERE id = ?",
				)
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "uncertain",
			upstream_order_id: "D1",
			last_error_code: "dhru_order_read_failed",
		});
		expect(
			await db
				.prepare("SELECT content_encrypted FROM delivery_records WHERE id = ?")
				.bind(supplier.delivery_record_id)
				.first("content_encrypted"),
		).toBeNull();
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'delivery.requested'",
				)
				.first("n"),
		).toBe(0);
		await processSupplierOrder(db, supplier.id, { fetcher });
		await processDelivery(db, supplier.delivery_record_id);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "buyer@example.com",
			}),
		).resolves.toMatchObject({ content: "Status: Clean" });
		expect(posts).toBe(1);
	});
	it("locks an invalid receipt UUID as uncertain without querying or resubmitting it", async () => {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
			.bind(order.id)
			.first<{ id: string }>();
		if (!supplier) throw new Error("missing supplier");
		let gets = 0;
		const invalidReceipt: typeof fetch = async (input, init) => {
			const response = await fetcher(input, init);
			if (new URL(String(input)).pathname.endsWith("/order")) {
				if (init?.method === "POST") {
					const body = (await response.json()) as {
						data: { order_uuid: string }[][];
					};
					const receipt = body.data[0]?.[0];
					if (!receipt) throw new Error("missing receipt");
					receipt.order_uuid = "bad/order";
					return Response.json(body);
				}
				gets++;
			}
			return response;
		};
		for (let attempt = 0; attempt < 2; attempt++)
			await expect(
				processSupplierOrder(db, supplier.id, { fetcher: invalidReceipt }),
			).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(
			await db
				.prepare(
					"SELECT state, selected_account_id, upstream_order_id, next_retry_at FROM supplier_orders WHERE id = ?",
				)
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "uncertain",
			selected_account_id: accountId,
			upstream_order_id: null,
			next_retry_at: null,
		});
		expect(
			await queueDueSupplierReconciliations(db, 25, Date.now() + 60_000),
		).toEqual({ queued: 0 });
		expect(posts).toBe(1);
		expect(gets).toBe(0);
	});

	it("retains an accepted receipt when its first persistence fails and reconciles without another purchase", async () => {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare(
				"SELECT id, delivery_record_id FROM supplier_orders WHERE order_id = ?",
			)
			.bind(order.id)
			.first<{ id: string; delivery_record_id: string }>();
		if (!supplier) throw new Error("missing supplier");
		await db
			.prepare(`CREATE TRIGGER fail_processing_receipt
		 BEFORE UPDATE ON supplier_orders
		 WHEN NEW.last_error_code = 'supplier_order_processing'
		 BEGIN SELECT RAISE(ABORT, 'receipt write unavailable'); END`)
			.run();
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		expect(
			await db
				.prepare("SELECT * FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "uncertain",
			selected_account_id: accountId,
			selected_credentials_revision: 1,
			upstream_order_id: "D1",
			selection_count: 1,
			attempt_count: 1,
			last_error_code: "supplier_request_uncertain",
		});
		await processSupplierOrder(db, supplier.id, { fetcher });
		await processDelivery(db, supplier.delivery_record_id);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "buyer@example.com",
			}),
		).resolves.toMatchObject({ content: "Status: Clean" });
		expect(posts).toBe(1);
	});

	it("keeps the selected account when even uncertainty persistence fails and never submits again", async () => {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
			.bind(order.id)
			.first<{ id: string }>();
		if (!supplier) throw new Error("missing supplier");
		await db
			.prepare(`CREATE TRIGGER fail_all_receipt_writes
		 BEFORE UPDATE ON supplier_orders WHEN NEW.state = 'uncertain'
		 BEGIN SELECT RAISE(ABORT, 'receipt write unavailable'); END`)
			.run();
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).rejects.toThrow();
		expect(
			await db
				.prepare("SELECT * FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "submitting",
			selected_account_id: accountId,
			selected_credentials_revision: 1,
			upstream_order_id: null,
			selection_count: 1,
			attempt_count: 1,
		});
		await db.prepare("DROP TRIGGER fail_all_receipt_writes").run();
		let reads = 0;
		await expect(
			processSupplierOrder(db, supplier.id, {
				fetcher: async (...args) => {
					reads++;
					return fetcher(...args);
				},
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(reads).toBe(0);
		expect(posts).toBe(1);
		expect(
			await db
				.prepare(
					"SELECT state, selected_account_id FROM supplier_orders WHERE id = ?",
				)
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "uncertain",
			selected_account_id: accountId,
		});
	});

	const pollQueue = () =>
		({
			sendBatch: vi.fn().mockResolvedValue(undefined),
		}) as unknown as Queue<SupplierQueueMessage>;
	async function pollingSupplier() {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare(
				"SELECT id, delivery_record_id FROM supplier_orders WHERE order_id = ?",
			)
			.bind(order.id)
			.first<{ id: string; delivery_record_id: string }>();
		if (!supplier) throw new Error("missing supplier");
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		await publishPendingSupplierOrders(db, pollQueue());
		await db
			.prepare("UPDATE supplier_orders SET next_retry_at = 1 WHERE id = ?")
			.bind(supplier.id)
			.run();
		return { order, supplier };
	}

	it("polls prolonged processing through durable messages and acknowledges each poll before eventual delivery", async () => {
		const order = await checkout();
		await pay(order.id);
		const supplier = await db
			.prepare(
				"SELECT id, delivery_record_id FROM supplier_orders WHERE order_id = ?",
			)
			.bind(order.id)
			.first<{ id: string; delivery_record_id: string }>();
		if (!supplier) throw new Error("missing supplier");
		let complete = false;
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (
					new URL(String(input)).pathname.endsWith("/order") &&
					init?.method !== "POST"
				)
					return Response.json({
						status: "success",
						code: 200,
						data: {
							quantity: 1,
							replay: complete ? "Status: Clean" : "",
							status: complete ? "success" : "processing",
						},
					});
				return fetcher(input, init);
			},
		);
		const body: SupplierQueueMessage = {
			kind: "commerce.supplier",
			version: 1,
			supplierOrderId: supplier.id,
		};
		const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
		await publishPendingSupplierOrders(
			db,
			queue as unknown as Queue<SupplierQueueMessage>,
		);
		for (let cycle = 0; cycle < 9; cycle++) {
			complete = cycle === 8;
			const ack = vi.fn(),
				retry = vi.fn();
			await handleQueue(
				{
					queue: "commerce",
					messages: [
						{
							body,
							ack,
							retry,
							id: crypto.randomUUID(),
							timestamp: new Date(),
							attempts: 20,
						},
					],
				} as unknown as MessageBatch<SupplierQueueMessage>,
				{ DB: db } as unknown as Env,
			);
			expect(ack).toHaveBeenCalledTimes(1);
			expect(retry).not.toHaveBeenCalled();
			if (!complete) {
				const due = await db
					.prepare("SELECT next_retry_at FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first<number>("next_retry_at");
				if (due === null) throw new Error("missing scheduled poll");
				expect(await queueDueSupplierReconciliations(db, 25, due)).toEqual({
					queued: 1,
				});
				await publishPendingSupplierOrders(
					db,
					queue as unknown as Queue<SupplierQueueMessage>,
				);
				expect(queue.sendBatch.mock.calls.at(-1)?.[0]).toEqual([{ body }]);
			}
		}
		expect(posts).toBe(1);
		expect(
			await queueDueSupplierReconciliations(db, 25, Date.now() + 60_000),
		).toEqual({ queued: 0 });
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'queue.message_failed'",
				)
				.first("n"),
		).toBe(0);
		await processDelivery(db, supplier.delivery_record_id);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: supplier.delivery_record_id,
				email: "buyer@example.com",
			}),
		).resolves.toMatchObject({ content: "Status: Clean" });
	});

	it("deduplicates concurrent pollers, holds a pending transport event and recovers an abandoned published message", async () => {
		await pollingSupplier();
		const now = Date.now();
		const results = await Promise.all([
			queueDueSupplierReconciliations(db, 25, now),
			queueDueSupplierReconciliations(db, 25, now),
		]);
		expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(1);
		const sendBatch = vi
			.fn()
			.mockRejectedValue(new Error("transport unavailable"));
		const queue = { sendBatch } as unknown as Queue<SupplierQueueMessage>;
		await expect(publishPendingSupplierOrders(db, queue)).rejects.toThrow();
		expect(await queueDueSupplierReconciliations(db, 25, now + 60_000)).toEqual(
			{ queued: 0 },
		);
		sendBatch.mockResolvedValue(undefined);
		await publishPendingSupplierOrders(db, queue);
		// Even if the published message never reaches a worker, the due row remains recoverable.
		expect(await queueDueSupplierReconciliations(db, 25, now + 60_000)).toEqual(
			{ queued: 1 },
		);
	});

	it("excludes future polls, missing Dhru IDs and ineligible customer or procurement states", async () => {
		const { order, supplier } = await pollingSupplier();
		const now = Date.now();
		for (const status of [
			"pending_payment",
			"cancelled",
			"refunded",
			"completed",
		]) {
			await db
				.prepare("UPDATE shop_orders SET status = ? WHERE id = ?")
				.bind(status, order.id)
				.run();
			expect(await queueDueSupplierReconciliations(db, 25, now)).toEqual({
				queued: 0,
			});
		}
		await db
			.prepare("UPDATE shop_orders SET status = 'fulfilling' WHERE id = ?")
			.bind(order.id)
			.run();
		for (const state of ["submitting", "supplied", "failed", "refunded"]) {
			await db
				.prepare("UPDATE supplier_orders SET state = ? WHERE id = ?")
				.bind(state, supplier.id)
				.run();
			expect(await queueDueSupplierReconciliations(db, 25, now)).toEqual({
				queued: 0,
			});
		}
		await db
			.prepare(
				"UPDATE supplier_orders SET state = 'uncertain', next_retry_at = ?, upstream_order_id = 'D1' WHERE id = ?",
			)
			.bind(now + 1, supplier.id)
			.run();
		expect(await queueDueSupplierReconciliations(db, 25, now)).toEqual({
			queued: 0,
		});
		await db
			.prepare(
				"UPDATE supplier_orders SET next_retry_at = 1, upstream_order_id = NULL WHERE id = ?",
			)
			.bind(supplier.id)
			.run();
		expect(await queueDueSupplierReconciliations(db, 25, now)).toEqual({
			queued: 0,
		});
		await db
			.prepare(
				"UPDATE supplier_orders SET upstream_order_id = 'D1' WHERE id = ?",
			)
			.bind(supplier.id)
			.run();
		expect(await queueDueSupplierReconciliations(db, 25, now)).toEqual({
			queued: 1,
		});
	});

	it("does not enqueue or change rows after completion, refund or a newer retry wins the polling race", async () => {
		for (const change of ["complete", "refund", "retry"]) {
			const { order, supplier } = await pollingSupplier();
			const now = Date.now();
			const racingDb = {
				prepare: db.prepare.bind(db),
				batch: async (statements: D1PreparedStatement[]) => {
					if (change === "complete")
						await db
							.prepare(
								"UPDATE supplier_orders SET state = 'supplied' WHERE id = ?",
							)
							.bind(supplier.id)
							.run();
					if (change === "refund")
						await db
							.prepare(
								"UPDATE shop_orders SET status = 'refunded' WHERE id = ?",
							)
							.bind(order.id)
							.run();
					if (change === "retry")
						await db
							.prepare(
								"UPDATE supplier_orders SET next_retry_at = ? WHERE id = ?",
							)
							.bind(now + 120_000, supplier.id)
							.run();
					return db.batch(statements);
				},
			} as D1Database;
			expect(await queueDueSupplierReconciliations(racingDb, 25, now)).toEqual({
				queued: 0,
			});
			expect(
				await db
					.prepare("SELECT next_retry_at FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first("next_retry_at"),
			).toBe(change === "retry" ? now + 120_000 : 1);
			await db
				.prepare("UPDATE supplier_orders SET next_retry_at = NULL WHERE id = ?")
				.bind(supplier.id)
				.run();
		}
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE idempotency_key LIKE 'supplier-poll:%'",
				)
				.first("n"),
		).toBe(0);
	});

	it("rolls back the polling event when retry scheduling fails", async () => {
		const { supplier } = await pollingSupplier();
		await db
			.prepare(
				"CREATE TRIGGER fail_poll_schedule BEFORE UPDATE ON supplier_orders BEGIN SELECT RAISE(ABORT, 'schedule failed'); END",
			)
			.run();
		await expect(queueDueSupplierReconciliations(db)).rejects.toThrow();
		expect(
			await db
				.prepare("SELECT next_retry_at FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first("next_retry_at"),
		).toBe(1);
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE idempotency_key LIKE 'supplier-poll:%'",
				)
				.first("n"),
		).toBe(0);
	});

	it("uses the retry and aggregate indexes to find due polls", async () => {
		let selection = "";
		await queueDueSupplierReconciliations({
			prepare: (sql: string) => {
				selection = sql;
				return db.prepare(sql);
			},
		} as D1Database);
		const plan = await db
			.prepare(`EXPLAIN QUERY PLAN ${selection}`)
			.bind(Date.now(), 25)
			.all<{ detail: string }>();
		const detail = plan.results.map((row) => row.detail).join("\n");
		expect(detail).toContain("supplier_orders_state_retry_idx");
		expect(detail).toContain("outbox_events_aggregate_idx");
	});

	const rejectedOrderFetcher: typeof fetch = async (input, init) => {
		if (
			new URL(String(input)).pathname.endsWith("/order") &&
			init?.method !== "POST"
		)
			return Response.json({
				status: "success",
				code: 200,
				data: {
					order_uuid: "D1",
					quantity: 1,
					replay: "private-rejection-detail",
					status: "rejected",
				},
			});
		return fetcher(input, init);
	};
	it("ends an accepted Dhru rejection without resubmission and exposes only a safe customer failure", async () => {
		const { order, supplier } = await pollingSupplier();
		vi.stubGlobal("fetch", rejectedOrderFetcher);
		const ack = vi.fn(),
			retry = vi.fn();
		await handleQueue(
			{
				queue: "commerce",
				messages: [
					{
						body: {
							kind: "commerce.supplier",
							version: 1,
							supplierOrderId: supplier.id,
						},
						id: crypto.randomUUID(),
						timestamp: new Date(),
						attempts: 1,
						ack,
						retry,
					},
				],
			} as unknown as MessageBatch<SupplierQueueMessage>,
			{ DB: db } as unknown as Env,
		);
		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
		expect(
			await db
				.prepare("SELECT * FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "failed",
			next_retry_at: null,
			upstream_order_id: "D1",
			selected_account_id: accountId,
			selected_credentials_revision: 1,
			attempt_count: 1,
			selection_count: 1,
			last_error_code: "dhru_order_rejected",
		});
		expect(
			await db
				.prepare(
					"SELECT health_status, consecutive_failures FROM supplier_accounts WHERE id = ?",
				)
				.bind(accountId)
				.first(),
		).toMatchObject({ health_status: "healthy", consecutive_failures: 0 });
		const customer = await getStoreOrder(db, {
			orderNumber: order.orderNumber,
			email: "buyer@example.com",
		});
		expect(customer.deliveries[0]).toMatchObject({
			type: "service",
			status: "failed",
			hasContent: false,
		});
		expect(JSON.stringify(customer)).not.toContain("private-rejection-detail");
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				email: "buyer@example.com",
				deliveryId: supplier.delivery_record_id,
			}),
		).rejects.toMatchObject({ code: "delivery_not_found" });
		for (const action of ["reconcile", "reselect"] as const)
			await expect(
				queueSupplierOrderAction(db, { id: supplier.id, action }, adminAudit()),
			).rejects.toMatchObject({ code: "supplier_order_action_unavailable" });
		expect(
			await queueDueSupplierReconciliations(db, 25, Date.now() + 60_000),
		).toEqual({ queued: 0 });
		const network = vi.fn(rejectedOrderFetcher);
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher: network }),
		).rejects.toMatchObject({ code: "supplier_order_terminal" });
		expect(network).not.toHaveBeenCalled();
		expect(posts).toBe(1);
		expect(
			await db
				.prepare("SELECT content_encrypted FROM delivery_records WHERE id = ?")
				.bind(supplier.delivery_record_id)
				.first("content_encrypted"),
		).toBeNull();
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'delivery.requested'",
				)
				.first("n"),
		).toBe(0);
		expect(
			JSON.stringify(
				(
					await db
						.prepare(
							"SELECT after FROM audit_logs WHERE action = 'queue.message_failed'",
						)
						.all()
				).results,
			),
		).not.toContain("private-rejection-detail");
	});

	it("does not finalize an unrelated rejection or a rejection whose quantity does not match", async () => {
		const { supplier } = await pollingSupplier();
		for (const data of [
			{ order_uuid: "OTHER", quantity: 1 },
			{ order_uuid: "D1", quantity: 2 },
		]) {
			await expect(
				processSupplierOrder(db, supplier.id, {
					fetcher: async () =>
						Response.json({
							status: "success",
							code: 200,
							data: {
								...data,
								status: "rejected",
								replay: "private-rejection-detail",
							},
						}),
				}),
			).rejects.toMatchObject({ code: "supplier_order_pending" });
			expect(
				await db
					.prepare(
						"SELECT state, upstream_order_id FROM supplier_orders WHERE id = ?",
					)
					.bind(supplier.id)
					.first(),
			).toMatchObject({ state: "uncertain", upstream_order_id: "D1" });
		}
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher: rejectedOrderFetcher }),
		).rejects.toMatchObject({ code: "dhru_order_rejected", retryable: false });
		expect(posts).toBe(1);
	});

	it("preserves the accepted purchase after failed terminal persistence and can reconcile again", async () => {
		const { supplier } = await pollingSupplier();
		await db
			.prepare(
				"CREATE TRIGGER fail_final_rejection BEFORE UPDATE ON supplier_orders WHEN NEW.state = 'failed' BEGIN SELECT RAISE(ABORT, 'terminal write failed'); END",
			)
			.run();
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher: rejectedOrderFetcher }),
		).rejects.toThrow();
		expect(
			await db
				.prepare(
					"SELECT state, upstream_order_id, selected_account_id, next_retry_at FROM supplier_orders WHERE id = ?",
				)
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "uncertain",
			upstream_order_id: "D1",
			selected_account_id: accountId,
			next_retry_at: 1,
		});
		await db.prepare("DROP TRIGGER fail_final_rejection").run();
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher: rejectedOrderFetcher }),
		).rejects.toMatchObject({ code: "dhru_order_rejected", retryable: false });
		expect(posts).toBe(1);
	});

	it("preserves fulfillment, refunds and a changed identity that win the final rejection write race", async () => {
		for (const change of ["fulfill", "refund", "identity"]) {
			const { order, supplier } = await pollingSupplier();
			const racingDb = {
				prepare: (sql: string) => {
					const statement = db.prepare(sql);
					if (!sql.includes("SET state = 'failed', next_retry_at = NULL"))
						return statement;
					return {
						bind: (...values: unknown[]) => {
							const bound = statement.bind(...values);
							return {
								run: async () => {
									if (change === "fulfill")
										await completeSupplierOrderFromCallback(db, supplier.id, {
											status: "supplied",
											upstreamOrderId: "D1",
											fulfillment: {
												type: "service",
												resultText: "Verified result",
											},
										});
									if (change === "refund")
										await db.batch([
											db
												.prepare(
													"UPDATE shop_orders SET status = 'refunded' WHERE id = ?",
												)
												.bind(order.id),
											db
												.prepare(
													"UPDATE supplier_orders SET state = 'refunded' WHERE id = ?",
												)
												.bind(supplier.id),
										]);
									if (change === "identity")
										await db
											.prepare(
												"UPDATE supplier_orders SET upstream_order_id = 'NEW' WHERE id = ?",
											)
											.bind(supplier.id)
											.run();
									return bound.run();
								},
							};
						},
					} as D1PreparedStatement;
				},
				batch: db.batch.bind(db),
			} as D1Database;
			await expect(
				processSupplierOrder(racingDb, supplier.id, {
					fetcher: rejectedOrderFetcher,
				}),
			).rejects.toMatchObject({
				code: "supplier_order_changed",
				retryable: true,
			});
			expect(
				await db
					.prepare(
						"SELECT state, upstream_order_id FROM supplier_orders WHERE id = ?",
					)
					.bind(supplier.id)
					.first(),
			).toMatchObject({
				state:
					change === "fulfill"
						? "supplied"
						: change === "refund"
							? "refunded"
							: "uncertain",
				upstream_order_id: change === "identity" ? "NEW" : "D1",
			});
			if (change === "fulfill") {
				await processDelivery(db, supplier.delivery_record_id);
				await expect(
					revealStoreDelivery(db, {
						orderNumber: order.orderNumber,
						email: "buyer@example.com",
						deliveryId: supplier.delivery_record_id,
					}),
				).resolves.toMatchObject({ content: "Verified result" });
			}
		}
		expect(posts).toBe(3);
	});

	it("rejects stale successful service reads after purchase identity, version or fulfillment eligibility changes", async () => {
		await db
			.prepare(`INSERT INTO supplier_accounts
		 (id, provider, base_url, normalized_api_origin, protocol_version, currency, currency_decimals,
		 name, credentials_encrypted, credential_fingerprint)
		 SELECT ?, provider, base_url, normalized_api_origin, protocol_version, currency, currency_decimals,
		 'Other', credentials_encrypted, 'other-test' FROM supplier_accounts WHERE id = ?`)
			.bind(crypto.randomUUID(), accountId)
			.run();
		const changes = [
			[
				"upstream",
				"UPDATE supplier_orders SET upstream_order_id = 'NEW' WHERE id = ?",
			],
			[
				"account",
				"UPDATE supplier_orders SET selected_account_id = (SELECT id FROM supplier_accounts WHERE id <> supplier_orders.selected_account_id LIMIT 1) WHERE id = ?",
			],
			[
				"credentials",
				"UPDATE supplier_orders SET selected_credentials_revision = 2 WHERE id = ?",
			],
			[
				"lock",
				"UPDATE supplier_orders SET account_locked_at = account_locked_at + 1 WHERE id = ?",
			],
			[
				"reference",
				"UPDATE supplier_orders SET provider_request_no = 'NEW' WHERE id = ?",
			],
			[
				"version",
				"UPDATE supplier_orders SET updated_at = updated_at + 1 WHERE id = ?",
			],
			["refund", "UPDATE shop_orders SET status = 'refunded' WHERE id = ?"],
			["cancel", "UPDATE shop_orders SET status = 'cancelled' WHERE id = ?"],
			[
				"delivery",
				"UPDATE delivery_records SET status = 'failed' WHERE id = ?",
			],
		] as const;
		for (const [change, sql] of changes) {
			const { order, supplier } = await pollingSupplier();
			let expectedPurchase: unknown;
			const racingDb = {
				prepare: db.prepare.bind(db),
				batch: async (statements: D1PreparedStatement[]) => {
					if (statements.length === 3) {
						await db
							.prepare(sql)
							.bind(
								change === "refund" || change === "cancel"
									? order.id
									: change === "delivery"
										? supplier.delivery_record_id
										: supplier.id,
							)
							.run();
						expectedPurchase = await db
							.prepare("SELECT * FROM supplier_orders WHERE id = ?")
							.bind(supplier.id)
							.first();
					}
					return db.batch(statements);
				},
			} as D1Database;
			await expect(
				processSupplierOrder(racingDb, supplier.id, { fetcher }),
				change,
			).rejects.toMatchObject({ code: "supplier_service_delivery_conflict" });
			expect(
				await db
					.prepare("SELECT * FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first(),
				change,
			).toEqual(expectedPurchase);
			expect(
				await db
					.prepare(
						"SELECT status, content_encrypted FROM delivery_records WHERE id = ?",
					)
					.bind(supplier.delivery_record_id)
					.first(),
				change,
			).toMatchObject({
				status: change === "delivery" ? "failed" : "awaiting_supply",
				content_encrypted: null,
			});
			expect(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND event_type = 'delivery.requested'",
					)
					.bind(supplier.delivery_record_id)
					.first("n"),
				change,
			).toBe(0);
		}
		expect(posts).toBe(changes.length);
	});

	it("preserves a winning service result and leaves incomplete supplied history untouched", async () => {
		for (const complete of [true, false]) {
			const { order, supplier } = await pollingSupplier();
			const racingDb = {
				prepare: db.prepare.bind(db),
				batch: async (statements: D1PreparedStatement[]) => {
					if (statements.length === 3) {
						if (complete)
							await completeSupplierOrderFromCallback(db, supplier.id, {
								status: "supplied",
								upstreamOrderId: "D1",
								fulfillment: {
									type: "service",
									resultText: "Winning private result",
								},
							});
						else
							await db
								.prepare(
									"UPDATE supplier_orders SET state = 'supplied' WHERE id = ?",
								)
								.bind(supplier.id)
								.run();
					}
					return db.batch(statements);
				},
			} as D1Database;
			await expect(
				processSupplierOrder(racingDb, supplier.id, { fetcher }),
			).resolves.toMatchObject({ state: "supplied", duplicate: true });
			expect(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND event_type = 'delivery.requested'",
					)
					.bind(supplier.delivery_record_id)
					.first("n"),
			).toBe(complete ? 1 : 0);
			if (complete) {
				await processDelivery(db, supplier.delivery_record_id);
				await expect(
					revealStoreDelivery(db, {
						orderNumber: order.orderNumber,
						email: "buyer@example.com",
						deliveryId: supplier.delivery_record_id,
					}),
				).resolves.toMatchObject({ content: "Winning private result" });
			} else {
				expect(
					await db
						.prepare(
							"SELECT status, content_encrypted FROM delivery_records WHERE id = ?",
						)
						.bind(supplier.delivery_record_id)
						.first(),
				).toMatchObject({ status: "awaiting_supply", content_encrypted: null });
			}
		}
		expect(posts).toBe(2);
	});

	it("rolls back every service commit stage and recovers by GET without another purchase", async () => {
		const failures = [
			"BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'delivery.requested'",
			"BEFORE UPDATE ON supplier_orders WHEN NEW.state = 'supplied'",
			"BEFORE UPDATE ON delivery_records WHEN NEW.status = 'pending' AND NEW.delivery_type = 'service'",
		];
		for (const failure of failures) {
			const { order, supplier } = await pollingSupplier();
			const before = await db
				.prepare("SELECT * FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first();
			await db
				.prepare(`CREATE TRIGGER fail_service_commit ${failure}
			 BEGIN SELECT RAISE(ABORT, 'service commit unavailable'); END`)
				.run();
			await expect(
				processSupplierOrder(db, supplier.id, { fetcher }),
			).rejects.toThrow();
			expect(
				await db
					.prepare("SELECT * FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first(),
			).toEqual(before);
			expect(
				await db
					.prepare(
						"SELECT status, content_encrypted FROM delivery_records WHERE id = ?",
					)
					.bind(supplier.delivery_record_id)
					.first(),
			).toMatchObject({ status: "awaiting_supply", content_encrypted: null });
			expect(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND event_type = 'delivery.requested'",
					)
					.bind(supplier.delivery_record_id)
					.first("n"),
			).toBe(0);
			await db.prepare("DROP TRIGGER fail_service_commit").run();
			await processSupplierOrder(db, supplier.id, { fetcher });
			await processDelivery(db, supplier.delivery_record_id);
			await expect(
				revealStoreDelivery(db, {
					orderNumber: order.orderNumber,
					email: "buyer@example.com",
					deliveryId: supplier.delivery_record_id,
				}),
			).resolves.toMatchObject({ content: "Status: Clean" });
		}
		expect(posts).toBe(failures.length);
	});

	it("refuses a service result for a different accepted order before any delivery write", async () => {
		const { supplier } = await pollingSupplier();
		await expect(
			completeSupplierOrderFromCallback(db, supplier.id, {
				status: "supplied",
				upstreamOrderId: "OTHER",
				fulfillment: {
					type: "service",
					resultText: "Unrelated private result",
				},
			}),
		).rejects.toMatchObject({
			code: "supplier_service_delivery_conflict",
			retryable: false,
		});
		expect(
			await db
				.prepare(
					"SELECT state, upstream_order_id FROM supplier_orders WHERE id = ?",
				)
				.bind(supplier.id)
				.first(),
		).toMatchObject({ state: "uncertain", upstream_order_id: "D1" });
		expect(
			await db
				.prepare("SELECT content_encrypted FROM delivery_records WHERE id = ?")
				.bind(supplier.delivery_record_id)
				.first("content_encrypted"),
		).toBeNull();
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'delivery.requested'",
				)
				.first("n"),
		).toBe(0);
		expect(posts).toBe(1);
	});

	it("claims service delivery using indexed purchase and delivery lookups", async () => {
		const { supplier } = await pollingSupplier();
		let claimSql = "";
		let bindings: unknown[] = [];
		const observedDb = {
			prepare: (sql: string) => {
				const statement = db.prepare(sql);
				if (!sql.includes("FROM supplier_orders so JOIN delivery_records dr"))
					return statement;
				claimSql = sql;
				return {
					bind: (...values: unknown[]) => {
						bindings = values;
						return statement.bind(...values);
					},
				} as D1PreparedStatement;
			},
			batch: db.batch.bind(db),
		} as D1Database;
		await processSupplierOrder(observedDb, supplier.id, { fetcher });
		expect(claimSql).not.toBe("");
		const plan = await db
			.prepare(`EXPLAIN QUERY PLAN ${claimSql}`)
			.bind(...bindings)
			.all<{ detail: string }>();
		const detail = plan.results.map((row) => row.detail).join("\n");
		for (const alias of ["so", "dr", "oi", "o"]) {
			expect(detail).toMatch(new RegExp(`SEARCH ${alias} USING INDEX`));
			expect(detail).not.toMatch(new RegExp(`SCAN ${alias}\\b`));
		}
		expect(posts).toBe(1);
	});

	it.each(["processing", "uncertain"])(
		"preserves a changed purchase instead of saving a stale %s GET",
		async (outcome) => {
			const changes = [
				"upstream_order_id = 'NEW'",
				"selected_credentials_revision = 2",
				"account_locked_at = account_locked_at + 1",
				"provider_request_no = 'NEW'",
				"updated_at = updated_at + 1",
				"state = 'failed', next_retry_at = NULL",
				"refund",
				"cancel",
				"complete",
			];
			for (const change of changes) {
				const { order, supplier } = await pollingSupplier();
				let expected: unknown;
				const racingDb = {
					prepare: (sql: string) => {
						const statement = db.prepare(sql);
						if (!sql.includes("SET state = 'uncertain'")) return statement;
						return {
							bind: (...values: unknown[]) => {
								const bound = statement.bind(...values);
								return {
									run: async () => {
										if (change === "complete")
											await completeSupplierOrderFromCallback(db, supplier.id, {
												status: "supplied",
												upstreamOrderId: "D1",
												fulfillment: {
													type: "service",
													resultText: "Winning result",
												},
											});
										else if (change === "refund" || change === "cancel")
											await db
												.prepare(
													"UPDATE shop_orders SET status = ? WHERE id = ?",
												)
												.bind(
													change === "refund" ? "refunded" : "cancelled",
													order.id,
												)
												.run();
										else
											await db
												.prepare(
													`UPDATE supplier_orders SET ${change} WHERE id = ?`,
												)
												.bind(supplier.id)
												.run();
										expected = await db
											.prepare("SELECT * FROM supplier_orders WHERE id = ?")
											.bind(supplier.id)
											.first();
										return bound.run();
									},
								};
							},
						} as D1PreparedStatement;
					},
					batch: db.batch.bind(db),
				} as D1Database;
				const pendingRead: typeof fetch = async (input, init) => {
					if (new URL(String(input)).pathname.endsWith("/order")) {
						if (outcome === "uncertain")
							throw new Error("Private provider detail");
						return Response.json({
							status: "success",
							code: 200,
							data: { quantity: 1, status: "in-process", replay: "" },
						});
					}
					return fetcher(input, init);
				};
				await expect(
					processSupplierOrder(racingDb, supplier.id, { fetcher: pendingRead }),
					change,
				).rejects.toMatchObject({
					code: "supplier_order_changed",
					retryable: true,
				});
				expect(
					await db
						.prepare("SELECT * FROM supplier_orders WHERE id = ?")
						.bind(supplier.id)
						.first(),
					change,
				).toEqual(expected);
				expect(
					await db
						.prepare(
							"SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND event_type = 'delivery.requested'",
						)
						.bind(supplier.delivery_record_id)
						.first("n"),
					change,
				).toBe(change === "complete" ? 1 : 0);
			}
			expect(posts).toBe(changes.length);
		},
	);

	it("does not attach a POST receipt to a changed claim during primary or fallback persistence", async () => {
		for (const change of [
			"selected_credentials_revision = 2",
			"provider_request_no = 'NEW'",
			"updated_at = updated_at + 1",
		]) {
			const order = await checkout();
			await pay(order.id);
			const supplier = await db
				.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
				.bind(order.id)
				.first<{ id: string }>();
			if (!supplier) throw new Error("missing supplier");
			let writes = 0;
			let expected: unknown;
			const racingDb = {
				prepare: (sql: string) => {
					const statement = db.prepare(sql);
					if (!sql.includes("SET state = 'uncertain'")) return statement;
					return {
						bind: (...values: unknown[]) => {
							const bound = statement.bind(...values);
							return {
								run: async () => {
									if (++writes === 1) {
										await db
											.prepare(
												`UPDATE supplier_orders SET ${change} WHERE id = ?`,
											)
											.bind(supplier.id)
											.run();
										expected = await db
											.prepare("SELECT * FROM supplier_orders WHERE id = ?")
											.bind(supplier.id)
											.first();
									}
									return bound.run();
								},
							};
						},
					} as D1PreparedStatement;
				},
				batch: db.batch.bind(db),
			} as D1Database;
			await expect(
				processSupplierOrder(racingDb, supplier.id, { fetcher }),
			).rejects.toMatchObject({
				code: "supplier_order_changed",
				retryable: true,
			});
			expect(writes).toBe(2);
			expect(
				await db
					.prepare("SELECT * FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first(),
			).toEqual(expected);
			let requests = 0;
			await expect(
				processSupplierOrder(db, supplier.id, {
					fetcher: async (...args) => {
						requests++;
						return fetcher(...args);
					},
				}),
			).rejects.toMatchObject({ code: "supplier_order_pending" });
			expect(requests).toBe(0);
			expect(
				await db
					.prepare(
						"SELECT state, upstream_order_id, next_retry_at FROM supplier_orders WHERE id = ?",
					)
					.bind(supplier.id)
					.first(),
			).toMatchObject({
				state: "uncertain",
				upstream_order_id: null,
				next_retry_at: null,
			});
		}
		expect(posts).toBe(3);
	});

	it("preserves newer state when the fallback write races after receipt storage fails", async () => {
		for (const change of [
			"updated_at = updated_at + 1",
			"upstream_order_id = 'NEW'",
			"refund",
		]) {
			const order = await checkout();
			await pay(order.id);
			const supplier = await db
				.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
				.bind(order.id)
				.first<{ id: string }>();
			if (!supplier) throw new Error("missing supplier");
			await db
				.prepare(`CREATE TRIGGER fail_primary_receipt BEFORE UPDATE ON supplier_orders
			 WHEN NEW.last_error_code = 'supplier_order_processing'
			 BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
				.run();
			let writes = 0;
			let expected: unknown;
			const racingDb = {
				prepare: (sql: string) => {
					const statement = db.prepare(sql);
					if (!sql.includes("SET state = 'uncertain'")) return statement;
					return {
						bind: (...values: unknown[]) => {
							const bound = statement.bind(...values);
							return {
								run: async () => {
									if (++writes === 2) {
										if (change === "refund")
											await db
												.prepare(
													"UPDATE shop_orders SET status = 'refunded' WHERE id = ?",
												)
												.bind(order.id)
												.run();
										else
											await db
												.prepare(
													`UPDATE supplier_orders SET ${change} WHERE id = ?`,
												)
												.bind(supplier.id)
												.run();
										expected = await db
											.prepare("SELECT * FROM supplier_orders WHERE id = ?")
											.bind(supplier.id)
											.first();
									}
									return bound.run();
								},
							};
						},
					} as D1PreparedStatement;
				},
				batch: db.batch.bind(db),
			} as D1Database;
			await expect(
				processSupplierOrder(racingDb, supplier.id, { fetcher }),
			).rejects.toMatchObject({
				code: "supplier_order_changed",
				retryable: true,
			});
			expect(writes).toBe(2);
			expect(
				await db
					.prepare("SELECT * FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first(),
			).toEqual(expected);
			await db.prepare("DROP TRIGGER fail_primary_receipt").run();
		}
		expect(posts).toBe(3);
	});

	it("retries a queue reconciliation conflict and later delivers by GET using indexed writes", async () => {
		const { order, supplier } = await pollingSupplier();
		let updateSql = "";
		let bindings: unknown[] = [];
		const racingDb = {
			prepare: (sql: string) => {
				const statement = db.prepare(sql);
				if (!sql.includes("SET state = 'uncertain'")) return statement;
				updateSql = sql;
				return {
					bind: (...values: unknown[]) => {
						bindings = values;
						const bound = statement.bind(...values);
						return {
							run: async () => {
								await db
									.prepare(
										"UPDATE supplier_orders SET updated_at = updated_at + 1 WHERE id = ?",
									)
									.bind(supplier.id)
									.run();
								return bound.run();
							},
						};
					},
				} as D1PreparedStatement;
			},
			batch: db.batch.bind(db),
		} as D1Database;
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (new URL(String(input)).pathname.endsWith("/order"))
					return Response.json({
						status: "success",
						code: 200,
						data: { quantity: 1, status: "pending", replay: "" },
					});
				return fetcher(input, init);
			},
		);
		const body: SupplierQueueMessage = {
			kind: "commerce.supplier",
			version: 1,
			supplierOrderId: supplier.id,
		};
		const ack = vi.fn(),
			retry = vi.fn();
		const batch = {
			queue: "commerce",
			messages: [
				{
					body,
					ack,
					retry,
					id: crypto.randomUUID(),
					timestamp: new Date(),
					attempts: 1,
				},
			],
		} as unknown as MessageBatch<SupplierQueueMessage>;
		await handleQueue(batch, { DB: racingDb } as unknown as Env);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(ack).not.toHaveBeenCalled();
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'queue.message_failed'",
				)
				.first("n"),
		).toBe(0);
		const plan = await db
			.prepare(`EXPLAIN QUERY PLAN ${updateSql}`)
			.bind(...bindings)
			.all<{ detail: string }>();
		const detail = plan.results.map((row) => row.detail).join("\n");
		for (const alias of ["so", "o"]) {
			expect(detail).toMatch(new RegExp(`SEARCH ${alias} USING INDEX`));
			expect(detail).not.toMatch(new RegExp(`SCAN ${alias}\\b`));
		}
		vi.stubGlobal("fetch", fetcher);
		await handleQueue(batch, { DB: db } as unknown as Env);
		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).toHaveBeenCalledTimes(1);
		await processDelivery(db, supplier.delivery_record_id);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				email: "buyer@example.com",
				deliveryId: supplier.delivery_record_id,
			}),
		).resolves.toMatchObject({ content: "Status: Clean" });
		expect(posts).toBe(1);
	});

	const adminAudit = () => ({
		request: new Request("https://shop.example/admin/suppliers/orders"),
		actorUserId: accountId,
	});
	async function failedSupplier() {
		const order = await checkout();
		await pay(order.id);
		await db
			.prepare("UPDATE supplier_orders SET state = 'failed' WHERE order_id = ?")
			.bind(order.id)
			.run();
		const supplier = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
			.bind(order.id)
			.first<{ id: string }>();
		if (!supplier) throw new Error("missing supplier");
		return { order, supplier };
	}
	it("refuses manual-hold Dhru recovery using the immutable snapshot even after the binding provider changes", async () => {
		const { order, supplier } = await pollingSupplier();
		await db.batch([
			db
				.prepare(
					"UPDATE supplier_orders SET upstream_order_id = NULL, next_retry_at = NULL WHERE id = ?",
				)
				.bind(supplier.id),
			db.prepare(
				"UPDATE supplier_bindings SET provider = 'gmshop_edge', normalized_api_origin = 'https://moved.example'",
			),
		]);
		const before = await db
			.prepare("SELECT * FROM supplier_orders WHERE id = ?")
			.bind(supplier.id)
			.first();
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reconcile" },
				adminAudit(),
			),
		).rejects.toMatchObject({ code: "supplier_order_id_missing" });
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
			),
		).rejects.toMatchObject({ code: "supplier_order_action_unavailable" });
		expect(
			await db
				.prepare("SELECT * FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first(),
		).toEqual(before);
		await db
			.prepare("UPDATE shop_orders SET status = 'cancelled' WHERE id = ?")
			.bind(order.id)
			.run();
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reconcile" },
				adminAudit(),
			),
		).rejects.toMatchObject({ code: "supplier_order_action_unavailable" });
		expect(await adminEffects()).toEqual({ outbox: 0, audit: 0 });
		expect(posts).toBe(1);
	});

	it("finds the original Dhru purchase reference and origin after a mutable binding changes", async () => {
		const { order, supplier } = await pollingSupplier();
		await db
			.prepare(
				"UPDATE supplier_bindings SET provider = 'gmshop_edge', normalized_api_origin = 'https://moved.example'",
			)
			.run();
		for (const search of [supplier.id, order.orderNumber, "D1"]) {
			const result = await listSupplierOrders(db, {
				search,
				pageIndex: 0,
				pageSize: 20,
			});
			expect(result.total).toBe(1);
			expect(result.data[0]).toMatchObject({
				id: supplier.id,
				provider: "dhru",
				normalized_api_origin: "https://supplier.example",
			});
			expect(JSON.stringify(result)).not.toContain("test-token");
		}
		expect(
			await listSupplierOrders(db, {
				search: "missing-reference",
				pageIndex: 0,
				pageSize: 20,
			}),
		).toMatchObject({ total: 0, data: [] });
	});

	it("does not queue or audit reconciliation when its known order ID disappears in the write race", async () => {
		const { supplier } = await pollingSupplier();
		const racingDb = {
			prepare: db.prepare.bind(db),
			batch: async (statements: D1PreparedStatement[]) => {
				await db
					.prepare(
						"UPDATE supplier_orders SET upstream_order_id = NULL, next_retry_at = NULL WHERE id = ?",
					)
					.bind(supplier.id)
					.run();
				return db.batch(statements);
			},
		} as D1Database;
		await expect(
			queueSupplierOrderAction(
				racingDb,
				{ id: supplier.id, action: "reconcile" },
				adminAudit(),
			),
		).rejects.toMatchObject({ code: "supplier_order_changed" });
		expect(await adminEffects()).toEqual({ outbox: 0, audit: 0 });
		expect(
			await db
				.prepare(
					"SELECT state, upstream_order_id, next_retry_at FROM supplier_orders WHERE id = ?",
				)
				.bind(supplier.id)
				.first(),
		).toMatchObject({
			state: "uncertain",
			upstream_order_id: null,
			next_retry_at: null,
		});
	});

	it("refuses reselection of a historical known order without a selected account", async () => {
		const { supplier } = await pollingSupplier();
		await db
			.prepare(`UPDATE supplier_orders SET state = 'failed',
		 selected_account_id = NULL, selected_credentials_revision = NULL,
		 provider_request_no = NULL, account_locked_at = NULL WHERE id = ?`)
			.bind(supplier.id)
			.run();
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
			),
		).rejects.toMatchObject({ code: "supplier_order_action_unavailable" });
		expect(await adminEffects()).toEqual({ outbox: 0, audit: 0 });
	});

	async function adminEffects() {
		return {
			outbox: await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE idempotency_key LIKE 'supplier-admin-%'",
				)
				.first("n"),
			audit: await db
				.prepare(
					"SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('supplier_order.reselect', 'supplier_order.reconcile')",
				)
				.first("n"),
		};
	}
	it("reselects a failed purchase and reconciles the selected Dhru order without resubmission", async () => {
		const { supplier } = await failedSupplier();
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
			),
		).resolves.toMatchObject({ queued: true });
		expect(
			await db
				.prepare("SELECT state FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first("state"),
		).toBe("pending");
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
			),
		).rejects.toMatchObject({ code: "supplier_order_action_unavailable" });
		await queueSupplierOrderAction(
			db,
			{ id: supplier.id, action: "reconcile" },
			adminAudit(),
		);
		await expect(
			processSupplierOrder(db, supplier.id, { fetcher }),
		).resolves.toMatchObject({ state: "supplied" });
		expect(posts).toBe(1);
		expect(await adminEffects()).toEqual({ outbox: 2, audit: 2 });
		const events = await db
			.prepare(
				"SELECT payload FROM outbox_events WHERE idempotency_key LIKE 'supplier-admin-%'",
			)
			.all<{ payload: string }>();
		expect(events.results.map((event) => JSON.parse(event.payload))).toEqual([
			{ supplierOrderId: supplier.id },
			{ supplierOrderId: supplier.id },
		]);
	});
	it("refuses recovery after refund, cancellation or completion with no queued or audited action", async () => {
		const { supplier, order } = await failedSupplier();
		for (const status of ["refunded", "cancelled", "completed"]) {
			await db
				.prepare("UPDATE shop_orders SET status = ? WHERE id = ?")
				.bind(status, order.id)
				.run();
			await expect(
				queueSupplierOrderAction(
					db,
					{ id: supplier.id, action: "reselect" },
					adminAudit(),
				),
			).rejects.toMatchObject({ code: "supplier_order_action_unavailable" });
		}
		expect(await adminEffects()).toEqual({ outbox: 0, audit: 0 });
	});
	it("does not overwrite completion, account locking or refund that wins the read/write race", async () => {
		for (const change of ["completed", "locked", "refunded"]) {
			const { supplier, order } = await failedSupplier();
			const racingDb = {
				prepare: db.prepare.bind(db),
				batch: async (statements: D1PreparedStatement[]) => {
					if (change === "completed")
						await db
							.prepare(
								"UPDATE supplier_orders SET state = 'supplied' WHERE id = ?",
							)
							.bind(supplier.id)
							.run();
					if (change === "locked")
						await db
							.prepare(
								"UPDATE supplier_orders SET state = 'uncertain', selected_account_id = ?, selected_credentials_revision = 1, provider_request_no = 'locked-request', account_locked_at = 1, upstream_order_id = 'D1' WHERE id = ?",
							)
							.bind(accountId, supplier.id)
							.run();
					if (change === "refunded")
						await db
							.prepare(
								"UPDATE shop_orders SET status = 'refunded' WHERE id = ?",
							)
							.bind(order.id)
							.run();
					return db.batch(statements);
				},
			} as D1Database;
			await expect(
				queueSupplierOrderAction(
					racingDb,
					{ id: supplier.id, action: "reselect" },
					adminAudit(),
				),
			).rejects.toMatchObject({ code: "supplier_order_changed" });
			expect(
				await db
					.prepare("SELECT state FROM supplier_orders WHERE id = ?")
					.bind(supplier.id)
					.first("state"),
			).toBe(
				change === "completed"
					? "supplied"
					: change === "locked"
						? "uncertain"
						: "failed",
			);
		}
		expect(await adminEffects()).toEqual({ outbox: 0, audit: 0 });
	});
	it("rolls back the queue and state update when audit persistence fails", async () => {
		const { supplier } = await failedSupplier();
		await db
			.prepare(
				"CREATE TRIGGER fail_supplier_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'supplier_order.reselect' BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
			)
			.run();
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
			),
		).rejects.toThrow();
		expect(
			await db
				.prepare("SELECT state FROM supplier_orders WHERE id = ?")
				.bind(supplier.id)
				.first("state"),
		).toBe("failed");
		expect(await adminEffects()).toEqual({ outbox: 0, audit: 0 });
	});

	it("reports durable recovery when transport fails and publishes it later", async () => {
		const { supplier } = await failedSupplier();
		const sendBatch = vi
			.fn()
			.mockRejectedValue(new Error("private-transport-error"));
		const queue = { sendBatch } as unknown as Queue<
			import("#/server/queue/types").SupplierQueueMessage
		>;
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
				queue,
			),
		).resolves.toMatchObject({ queued: true, dispatch: "pending" });
		expect(await adminEffects()).toEqual({ outbox: 1, audit: 1 });
		expect(
			await db
				.prepare(
					"SELECT status FROM outbox_events WHERE idempotency_key LIKE 'supplier-admin-%'",
				)
				.first("status"),
		).toBe("pending");
		sendBatch.mockResolvedValue(undefined);
		await publishPendingSupplierOrders(db, queue);
		expect(
			await db
				.prepare(
					"SELECT status FROM outbox_events WHERE idempotency_key LIKE 'supplier-admin-%'",
				)
				.first("status"),
		).toBe("published");
	});
	it("publishes exactly the recovery event without consuming an older pending event", async () => {
		const { supplier } = await failedSupplier();
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const queue = { sendBatch } as unknown as Queue<
			import("#/server/queue/types").SupplierQueueMessage
		>;
		await expect(
			queueSupplierOrderAction(
				db,
				{ id: supplier.id, action: "reselect" },
				adminAudit(),
				queue,
			),
		).resolves.toMatchObject({ queued: true, dispatch: "published" });
		expect(sendBatch).toHaveBeenCalledTimes(1);
		expect(sendBatch.mock.calls[0]?.[0]).toEqual([
			{
				body: {
					kind: "commerce.supplier",
					version: 1,
					supplierOrderId: supplier.id,
				},
			},
		]);
		expect(
			await db
				.prepare(
					"SELECT status FROM outbox_events WHERE idempotency_key LIKE 'supplier-admin-%'",
				)
				.first("status"),
		).toBe("published");
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'supplier.requested' AND status = 'pending' AND idempotency_key NOT LIKE 'supplier-admin-%'",
				)
				.first("n"),
		).toBe(1);
	});

	it("decrypts only the immutable customer input snapshot at submission", async () => {
		const definition = {
			key: "IMEI",
			name: "IMEI",
			description: "",
			inputType: "text",
			scope: "order",
			required: true,
			sensitive: true,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "",
			exampleValue: "",
			sortOrder: 0,
			options: [],
		};
		await db
			.prepare(
				"INSERT INTO product_definition_versions (id, product_id, sellable_item_id, version, schema_json, published_at) VALUES (?, ?, ?, 1, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				productId,
				itemId,
				JSON.stringify([definition]),
				Date.now(),
			)
			.run();
		const order = await createMultiStoreOrder(db, {
			email: "buyer@example.com",
			idempotencyKey: crypto.randomUUID(),
			items: [
				{
					sellableItemId: itemId,
					quantity: 1,
					inputValues: { IMEI: "490154203237518" },
				},
			],
		});
		const stored = await db
			.prepare(
				"SELECT input_values_json, sensitive_input_values_json FROM shop_order_items WHERE order_id = ?",
			)
			.bind(order.id)
			.first();
		expect(JSON.stringify(stored)).not.toContain("490154203237518");
		await pay(order.id);
		const id = await db
			.prepare("SELECT id FROM supplier_orders")
			.first<string>("id");
		await expect(
			processSupplierOrder(db, id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(postedFields.IMEI).toBe("490154203237518");
		expect(
			JSON.stringify(
				(await db.prepare("SELECT payload FROM outbox_events").all()).results,
			),
		).not.toContain("490154203237518");
	});
	it("rejects unbound and local services before creating orders", async () => {
		await db.prepare("UPDATE supplier_bindings SET enabled = 0").run();
		await expect(checkout()).rejects.toMatchObject({
			code: "supplier_inventory_unavailable",
		});
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source = 'local', supplier_status = NULL",
			)
			.run();
		await expect(checkout()).rejects.toMatchObject({
			code: "supplier_binding_unavailable",
		});
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM shop_orders").first("n"),
		).toBe(0);
	});
	it("does not submit canceled paid service orders", async () => {
		const order = await checkout();
		await pay(order.id);
		await db
			.prepare("UPDATE shop_orders SET status = 'cancelled' WHERE id = ?")
			.bind(order.id)
			.run();
		const id = await db
			.prepare("SELECT id FROM supplier_orders")
			.first<string>("id");
		await expect(
			processSupplierOrder(db, id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_terminal" });
		expect(posts).toBe(0);
	});
	it("previews a single service without database writes or paid requests", async () => {
		const state = () =>
			db
				.prepare(`SELECT p.revision, p.status, item.cost_minor, account.balance_minor, account.health_status,
   (SELECT COUNT(*) FROM supplier_bindings) AS bindings, (SELECT COUNT(*) FROM product_definition_versions) AS definitions,
   (SELECT COUNT(*) FROM audit_logs) AS audits
   FROM products p JOIN product_sellable_items item ON item.product_id = p.id JOIN supplier_accounts account ON account.id = ? WHERE item.id = ?`)
				.bind(accountId, itemId)
				.first();
		const before = await state();
		const args = {
			sellableItemId: itemId,
			accountId,
			expectedRevision: 1,
			productId: "123",
			maxCostMinor: "150",
		};
		const preview = await previewServiceSupplier(db, args, { fetcher });
		expect(preview).toMatchObject({
			name: "Test service",
			costMinor: "100",
			currency: "USD",
			currencyDecimals: 2,
			fields: [],
		});
		expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(await state()).toEqual(before);
		expect(JSON.stringify(preview)).not.toContain("test-token");
		expect(posts).toBe(0);
		await expect(
			bindServiceSupplier(
				db,
				{ ...args, expectedServiceFingerprint: preview.fingerprint },
				{ actorUserId: accountId, fetcher },
			),
		).resolves.toMatchObject({ revision: 2 });
	});
	it.each(["price", "fields", "name"])(
		"rejects changed upstream %s after preview without any binding writes",
		async (changed) => {
			const args = {
				sellableItemId: itemId,
				accountId,
				expectedRevision: 1,
				productId: "123",
				maxCostMinor: "150",
			};
			const preview = await previewServiceSupplier(db, args, { fetcher });
			const drift: typeof fetch = async (input, init) => {
				const response = await fetcher(input, init);
				if (new URL(String(input)).pathname.endsWith("/products")) {
					const body = (await response.json()) as {
						data: Record<string, unknown>;
					};
					body.data[changed] =
						changed === "price"
							? "1.01"
							: changed === "name"
								? "Changed service"
								: [{ name: "IMEI", type: "imei", required: true }];
					return Response.json(body);
				}
				return response;
			};
			await expect(
				bindServiceSupplier(
					db,
					{ ...args, expectedServiceFingerprint: preview.fingerprint },
					{ actorUserId: accountId, fetcher: drift },
				),
			).rejects.toMatchObject({ code: "supplier_service_preview_changed" });
			expect(
				await db
					.prepare("SELECT revision FROM products WHERE id = ?")
					.bind(productId)
					.first("revision"),
			).toBe(1);
			expect(
				await db
					.prepare("SELECT COUNT(*) AS n FROM supplier_bindings")
					.first("n"),
			).toBe(1);
			expect(
				await db
					.prepare("SELECT COUNT(*) AS n FROM product_definition_versions")
					.first("n"),
			).toBe(0);
			expect(posts).toBe(0);
		},
	);

	it("binds only one service with live quote and an explicit spend cap", async () => {
		await expect(
			bindServiceSupplier(
				db,
				{
					sellableItemId: itemId,
					accountId,
					expectedRevision: 1,
					productId: "123",
					maxCostMinor: "99",
				},
				{ actorUserId: accountId, fetcher },
			),
		).rejects.toMatchObject({ code: "supplier_cost_limit_exceeded" });
		await expect(
			bindServiceSupplier(
				db,
				{
					sellableItemId: itemId,
					accountId,
					expectedRevision: 1,
					productId: "123",
					maxCostMinor: "150",
				},
				{ actorUserId: accountId, fetcher },
			),
		).resolves.toMatchObject({ revision: 2 });
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM supplier_bindings WHERE enabled = 1",
				)
				.first("n"),
		).toBe(1);
		expect(posts).toBe(0);
		await expect(
			bindServiceSupplier(
				db,
				{
					sellableItemId: itemId,
					accountId,
					expectedRevision: 1,
					productId: "123",
					maxCostMinor: "150",
				},
				{ actorUserId: accountId, fetcher },
			),
		).rejects.toMatchObject({ code: "product_revision_conflict" });
	});
	it("imports required fields atomically and keeps previous order definitions immutable", async () => {
		const importFetcher: typeof fetch = async (input, init) => {
			const response = await fetcher(input, init);
			if (new URL(String(input)).pathname.endsWith("/products")) {
				const body = (await response.json()) as {
					data: Record<string, unknown>;
				};
				body.data.fields = [{ name: "IMEI", type: "imei", required: true }];
				return Response.json(body);
			}
			return response;
		};
		const args = {
			sellableItemId: itemId,
			accountId,
			expectedRevision: 1,
			productId: "123",
			maxCostMinor: "150",
		};
		await bindServiceSupplier(db, args, {
			actorUserId: accountId,
			fetcher: importFetcher,
		});
		expect(
			await db
				.prepare("SELECT status FROM products WHERE id = ?")
				.bind(productId)
				.first("status"),
		).toBe("draft");
		await db.prepare("UPDATE products SET status = 'active'").run();
		await expect(checkout()).rejects.toThrow();
		const order = await createMultiStoreOrder(db, {
			email: "buyer@example.com",
			idempotencyKey: crypto.randomUUID(),
			items: [
				{
					sellableItemId: itemId,
					quantity: 1,
					inputValues: { IMEI: "012345678901234" },
				},
			],
		});
		const snapshot = await db
			.prepare(
				"SELECT definition_version_id, input_values_json, sensitive_input_values_json FROM shop_order_items WHERE order_id = ?",
			)
			.bind(order.id)
			.first();
		expect(JSON.stringify(snapshot)).not.toContain("012345678901234");
		await expect(
			bindServiceSupplier(
				db,
				{ ...args, expectedRevision: 2 },
				{ actorUserId: accountId, fetcher },
			),
		).rejects.toMatchObject({ code: "supplier_service_unpaid_orders" });
		await pay(order.id);

		await bindServiceSupplier(
			db,
			{ ...args, expectedRevision: 2 },
			{ actorUserId: accountId, fetcher },
		);
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM product_definition_versions")
				.first("n"),
		).toBe(2);
		expect(
			await db
				.prepare(
					"SELECT definition_version_id FROM shop_order_items WHERE order_id = ?",
				)
				.bind(order.id)
				.first("definition_version_id"),
		).toBe(snapshot?.definition_version_id);
		const old = await db
			.prepare(
				"SELECT schema_json FROM product_definition_versions WHERE id = ?",
			)
			.bind(snapshot?.definition_version_id)
			.first<string>("schema_json");
		expect(JSON.parse(old ?? "[]")[0]).toMatchObject({
			key: "IMEI",
			required: true,
			sensitive: true,
		});
		const job = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = ?")
			.bind(order.id)
			.first<string>("id");
		await expect(
			processSupplierOrder(db, job ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(postedFields.IMEI).toBe("012345678901234");
	});
	it("unsupported upstream fields leave product revision, bindings and definitions untouched", async () => {
		const invalid: typeof fetch = async (input, init) => {
			const response = await fetcher(input, init);
			if (new URL(String(input)).pathname.endsWith("/products")) {
				const body = (await response.json()) as {
					data: Record<string, unknown>;
				};
				body.data.fields = [{ name: "Upload", type: "file", required: true }];
				return Response.json(body);
			}
			return response;
		};
		await expect(
			bindServiceSupplier(
				db,
				{
					sellableItemId: itemId,
					accountId,
					expectedRevision: 1,
					productId: "123",
					maxCostMinor: "150",
				},
				{ actorUserId: accountId, fetcher: invalid },
			),
		).rejects.toMatchObject({ code: "supplier_service_fields_unsupported" });
		expect(
			await db
				.prepare("SELECT revision FROM products WHERE id = ?")
				.bind(productId)
				.first("revision"),
		).toBe(1);
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM product_definition_versions")
				.first("n"),
		).toBe(0);
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM supplier_bindings WHERE enabled = 1",
				)
				.first("n"),
		).toBe(1);
		expect(posts).toBe(0);
	});

	it("unsigned feedback cannot deliver results or replace the upstream ID", async () => {
		const order = await checkout();
		await pay(order.id);
		const id = await db
			.prepare("SELECT id FROM supplier_orders")
			.first<string>("id");
		await expect(
			processSupplierOrder(db, id ?? "", { fetcher }),
		).rejects.toThrow();
		const response = await handleDhruSupplierCallback(
			new Request("https://shop.example", {
				method: "POST",
				body: JSON.stringify({
					reference_id: id,
					order_uuid: "FORGED",
					status: "success",
					replay: "attacker result",
				}),
			}),
			accountId,
			db,
		);
		expect(response.status).toBe(202);
		expect(
			await db
				.prepare("SELECT state, upstream_order_id FROM supplier_orders")
				.first(),
		).toMatchObject({ state: "uncertain", upstream_order_id: "D1" });
		expect(
			await db
				.prepare("SELECT content_encrypted FROM delivery_records")
				.first("content_encrypted"),
		).toBeNull();
	});
});
