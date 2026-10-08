import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDelivery } from "#/features/fulfillment/server/process";
import { completeManualStoreOrder } from "#/features/shop-payments/server/service";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { handleDhruSupplierCallback } from "#/features/suppliers/server/dhru-callback";
import { processSupplierOrder } from "#/features/suppliers/server/process";
import { bindServiceSupplier } from "#/features/suppliers/server/service-binding";
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
	afterEach(async () => mf.dispose());
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
