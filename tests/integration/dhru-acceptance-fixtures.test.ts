import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import {
	supplierOrderActionAllowed,
	supplierOrderNeedsManualReview,
} from "#/features/suppliers/order-actions";
import { readSupplierCredentials } from "#/features/suppliers/secrets";
import { runSupplierMaintenance } from "#/features/suppliers/server/maintenance";
import { listSupplierOrders } from "#/features/suppliers/server/orders-admin";
import { queueDueSupplierReconciliations } from "#/features/suppliers/server/outbox";
import {
	createInitialRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import {
	createDhruAcceptanceStatements,
	dhruAcceptanceOrders,
} from "../../scripts/seed-dhru-fixtures";
import { applyMigrations } from "./migrations";

describe("local Dhru acceptance fixtures", { timeout: 30_000 }, () => {
	let mf: Miniflare, db: D1Database;
	const runtime = createInitialRuntimeConfig("https://shop.example");
	const context = {
		now: Date.now(),
		customerUserId: "fixture-owner",
		customerEmail: "owner@example.com",
		commerceSecret: runtime.commerceSecret,
	};
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db
				.prepare(
					"INSERT INTO users (id, name, email) VALUES (?, 'Fixture owner', ?)",
				)
				.bind(context.customerUserId, context.customerEmail),
			...runtimeConfigEntries(runtime).map((row) =>
				db
					.prepare(
						"INSERT INTO system_settings (key, value, is_secret) VALUES (?, ?, ?)",
					)
					.bind(row.key, JSON.stringify(row.value), row.isSecret),
			),
		]);
		await seed();
	});
	afterEach(async () => mf?.dispose());
	async function seed() {
		const statements = await createDhruAcceptanceStatements(context);
		await db.batch(statements.map((sql) => db.prepare(sql)));
	}

	it("exposes all five states through actual customer and admin queries", async () => {
		for (const fixture of dhruAcceptanceOrders) {
			const order = await getStoreOrder(
				db,
				{ orderNumber: fixture.orderNumber },
				{ userId: context.customerUserId },
			);
			expect(order.items[0]?.deliveryType).toBe("service");
			expect(order.deliveries[0]).toMatchObject({
				type: "service",
				status:
					fixture.scenario === "success"
						? "delivered"
						: fixture.scenario === "rejected"
							? "failed"
							: "awaiting_supply",
				hasContent: fixture.scenario === "success",
			});
		}
		const orders = await listSupplierOrders(db, {
			pageIndex: 0,
			pageSize: 20,
			search: "GMDHRU",
		});
		expect(orders.total).toBe(5);
		expect(orders.data.every((row) => row.provider === "dhru")).toBe(true);
		const manual = orders.data.find(
			(row) => row.last_error_code === "dhru_order_uncertain",
		);
		if (!manual) throw new Error("manual-review fixture missing");
		const actionContext = {
			state: manual.state,
			orderStatus: manual.order_status,
			accountId: manual.account_id,
			accountLockedAt: manual.account_locked_at,
			provider: manual.provider,
			upstreamOrderId: manual.upstream_order_id,
		};
		expect(supplierOrderNeedsManualReview(actionContext)).toBe(true);
		expect(supplierOrderActionAllowed("reconcile", actionContext)).toBe(false);
		expect(supplierOrderActionAllowed("reselect", actionContext)).toBe(false);
		expect(
			(
				await listSupplierOrders(db, {
					pageIndex: 0,
					pageSize: 20,
					search: manual.id,
				})
			).data[0]?.id,
		).toBe(manual.id);
	});

	it("encrypts demo input, credentials and success results with real ownership checks", async () => {
		const success = dhruAcceptanceOrders[2];
		if (!success) throw new Error("success fixture missing");
		const stored = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id = ?")
			.bind(success.deliveryId)
			.first<{ content_encrypted: string }>();
		expect(stored?.content_encrypted).not.toContain("Status: Clean");
		const content = JSON.parse(
			await decryptDeliveryContent(
				stored?.content_encrypted ?? "",
				context.commerceSecret,
			),
		);
		expect(content).toMatchObject({
			type: "service",
			resultData: { fixture: true },
		});
		const inputs = await db
			.prepare(
				"SELECT sensitive_input_values_json FROM shop_order_items WHERE id = ?",
			)
			.bind(success.orderItemId)
			.first<string>("sensitive_input_values_json");
		expect(inputs).not.toContain("490154203237518");
		const account = await db
			.prepare(
				"SELECT credentials_encrypted FROM supplier_accounts WHERE provider = 'dhru'",
			)
			.first<{ credentials_encrypted: string }>();
		expect(account?.credentials_encrypted).not.toContain(
			"demo-dhru-token-not-real",
		);
		expect(
			await readSupplierCredentials(
				account?.credentials_encrypted ?? "",
				1,
				"dhru",
				context.commerceSecret,
			),
		).toEqual({ apiToken: "demo-dhru-token-not-real" });
		await expect(
			revealStoreDelivery(db, {
				orderNumber: success.orderNumber,
				deliveryId: success.deliveryId,
				userId: context.customerUserId,
			}),
		).resolves.toMatchObject({ content: content.resultText });
		await expect(
			revealStoreDelivery(db, {
				orderNumber: success.orderNumber,
				deliveryId: success.deliveryId,
				email: context.customerEmail,
			}),
		).resolves.toMatchObject({ content: content.resultText });
		await expect(
			revealStoreDelivery(db, {
				orderNumber: success.orderNumber,
				deliveryId: success.deliveryId,
				userId: "other-user",
			}),
		).rejects.toMatchObject({ code: "order_not_found" });
		await expect(
			revealStoreDelivery(db, {
				orderNumber: success.orderNumber,
				deliveryId: success.deliveryId,
				email: "wrong@example.com",
			}),
		).rejects.toMatchObject({ code: "order_not_found" });
		const audit = await db
			.prepare("SELECT after FROM audit_logs WHERE target_id = ?")
			.bind(success.deliveryId)
			.all();
		expect(JSON.stringify(audit.results)).not.toContain("Status: Clean");
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM stock_entries").first("n"),
		).toBe(0);
	});

	it("creates no purchasable product or automatic supplier work", async () => {
		expect(
			await db
				.prepare("SELECT status FROM products WHERE product_type = 'service'")
				.first("status"),
		).toBe("draft");
		expect(
			await db
				.prepare(
					"SELECT enabled FROM supplier_accounts WHERE provider = 'dhru'",
				)
				.first("enabled"),
		).toBe(0);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM outbox_events").first("n"),
		).toBe(0);
		await expect(
			queueDueSupplierReconciliations(db, 25, context.now + 86_400_000),
		).resolves.toEqual({ queued: 0 });
		let requests = 0;
		await runSupplierMaintenance({
			db,
			runtime,
			now: context.now,
			fetcher: async () => {
				requests++;
				throw new Error("fixture must not contact provider");
			},
		});
		expect(requests).toBe(0);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM outbox_events").first("n"),
		).toBe(0);
	});

	it("reseeds without overwriting delivery, refund or customer input history", async () => {
		const success = dhruAcceptanceOrders[2];
		if (!success) throw new Error("success fixture missing");
		const original = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id = ?")
			.bind(success.deliveryId)
			.first("content_encrypted");
		const originalInputs = await db
			.prepare(
				"SELECT sensitive_input_values_json FROM shop_order_items WHERE id = ?",
			)
			.bind(success.orderItemId)
			.first("sensitive_input_values_json");
		await db
			.prepare("UPDATE shop_orders SET status = 'refunded' WHERE id = ?")
			.bind(success.orderId)
			.run();
		await seed();
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM supplier_orders").first("n"),
		).toBe(5);
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM customer_entitlements")
				.first("n"),
		).toBe(5);
		expect(
			await db
				.prepare("SELECT status FROM shop_orders WHERE id = ?")
				.bind(success.orderId)
				.first("status"),
		).toBe("refunded");
		expect(
			await db
				.prepare("SELECT content_encrypted FROM delivery_records WHERE id = ?")
				.bind(success.deliveryId)
				.first("content_encrypted"),
		).toBe(original);
		expect(
			await db
				.prepare(
					"SELECT sensitive_input_values_json FROM shop_order_items WHERE id = ?",
				)
				.bind(success.orderItemId)
				.first("sensitive_input_values_json"),
		).toBe(originalInputs);
		expect(
			(await db.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
		await expect(
			revealStoreDelivery(db, {
				orderNumber: success.orderNumber,
				deliveryId: success.deliveryId,
				userId: context.customerUserId,
			}),
		).rejects.toMatchObject({ code: "delivery_not_found" });
	});
});
