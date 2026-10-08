import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productSellableItemsInputSchema } from "#/features/catalog/editor-schema";
import { assertProductTypeChange } from "#/features/catalog/product-type-invariant";
import { applyMigrations } from "./migrations";

describe("catalog product type invariant", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-product-type-invariant" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, created_at, updated_at)
				 VALUES ('product-download', 'Download', 'download', 'draft', 1, 1),
				        ('product-automation', 'Automation', 'automation', 'draft', 1, 1),
				        ('product-stock', 'Stock', 'stock', 'draft', 1, 1)`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, access_limit, price_minor, created_at, updated_at)
				 VALUES ('item-download', 'product-download', 'Download', 10, '100', 1, 1)`,
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("accepts the four product types and rejects unknown types", async () => {
		await expect(
			db
				.prepare(
					`INSERT INTO products
					 (id, name, product_type, status, created_at, updated_at)
					 VALUES ('product-manual', 'Manual', 'manual', 'draft', 1, 1)`,
				)
				.run(),
		).rejects.toThrow(/products_product_type_check/);
		await expect(
			db
				.prepare(
					`INSERT INTO products
					 (id, name, product_type, status, created_at, updated_at)
					 VALUES ('product-legacy', 'Legacy', 'card', 'draft', 1, 1)`,
				)
				.run(),
		).rejects.toThrow(/products_product_type_check/);
	});

	it("rejects a sellable-item policy reserved for another product type", async () => {
		expect(
			productSellableItemsInputSchema.safeParse(
				sellableItemsInput("download", { usageLimit: 1 }),
			).success,
		).toBe(false);
	});

	it("rejects download-only access policy on an automation product", async () => {
		expect(
			productSellableItemsInputSchema.safeParse(
				sellableItemsInput("automation", { accessLimit: 1 }),
			).success,
		).toBe(false);
	});

	it("prevents changing a product type after sellable-item policy exists", async () => {
		await expect(
			assertProductTypeChange(db, "product-download", "stock"),
		).rejects.toMatchObject({ code: "product_type_configuration_mismatch" });
	});

	it("allows supplier fulfillment on stock and service products", async () => {
		await expect(
			db
				.prepare(
					`INSERT INTO product_sellable_items
					 (id, product_id, name, fulfillment_source, supplier_status,
					  price_minor, created_at, updated_at)
					 VALUES ('supplier-download', 'product-download', 'Supplier',
					  'supplier', 'available', '100', 1, 1)`,
				)
				.run(),
		).rejects.toThrow(/supplier_fulfillment_requires_stock_product/);
		await db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status,
				  price_minor, created_at, updated_at)
				 VALUES ('supplier-stock', 'product-stock', 'Supplier',
				  'supplier', 'available', '100', 1, 1)`,
			)
			.run();
		await expect(
			db
				.prepare(
					"UPDATE products SET product_type = 'download' WHERE id = 'product-stock'",
				)
				.run(),
		).rejects.toThrow(/supplier_fulfillment_requires_stock_product/);
	});

	it("rejects removed delivery types in entitlement and delivery snapshots", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, created_at, updated_at)
				 VALUES ('customer', 'Customer', 'customer@example.com', 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, user_id,
				  contact_email, normalized_contact_email, status, currency,
				  currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, expires_at,
				  created_at, updated_at)
				 VALUES ('order', 'ORDER-1', 'key', 'customer',
				  'customer@example.com', 'customer@example.com', 'pending_payment', 'USD',
				  2, '100', '0', '100', '0', 1000, 1, 1)`,
			),
		]);
		await db
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name,
				  delivery_component_id, delivery_component_type,
				  delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('order-item-valid', 'order', 'product-download', 'item-download',
				  'Download', 'item-download', 'download', 1, 'Download', 1,
				  '100', '0', '100', 1, 1)`,
			)
			.run();
		await expect(
			db
				.prepare(
					`INSERT INTO customer_entitlements
					 (id, user_id, order_item_id, product_id, sellable_item_id,
					  delivery_component_id, entitlement_type, created_at, updated_at)
					 VALUES ('entitlement-manual', 'customer', 'order-item-valid',
					  'product-download', 'item-download', 'item-download',
					  'manual', 1, 1)`,
				)
				.run(),
		).rejects.toThrow(/customer_entitlements_type_check/);
		await expect(
			db
				.prepare(
					`INSERT INTO delivery_records
					 (id, order_item_id, delivery_type, created_at, updated_at)
					 VALUES ('delivery-manual', 'order-item-valid', 'manual', 1, 1)`,
				)
				.run(),
		).rejects.toThrow(/delivery_records_type_check/);
	});
});

function sellableItemsInput(
	type: "stock" | "download" | "automation",
	overrides: { usageLimit?: number | null; accessLimit?: number | null },
) {
	return {
		productId: "00000000-0000-4000-8000-000000000001",
		expectedRevision: 1,
		sellableItems: [
			{
				name: "Default",
				listPriceMinor: null,
				priceMinor: "100",
				costMinor: null,
				currency: "USD",
				currencyDecimals: 2,
				minimumQuantity: 1,
				maximumQuantity: 1,
				maximumPerCustomer: null,
				delivery: {
					type,
					durationMs: null,
					usageLimit: null,
					accessLimit: null,
					renewalMode: "disabled",
					emailMode: "none",
					showOnOrderPage: true,
					allowResend: false,
					lowStockThreshold: 0,
					...overrides,
				},
				enabled: true,
			},
		],
	};
}
