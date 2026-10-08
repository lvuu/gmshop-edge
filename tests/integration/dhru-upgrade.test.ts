import { readdir, readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("upgrades populated pre-Dhru D1 through all service migrations without losing history", async () => {
	const miniflare = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('ok') } }",
		d1Databases: { DB: "gmshop-dhru-upgrade" },
	});
	try {
		const db = await miniflare.getD1Database("DB");
		const directory = new URL("../../drizzle/", import.meta.url);
		const files = (await readdir(directory))
			.filter((name) => /^\d+_.+\.sql$/.test(name))
			.sort();
		async function migrate(names: string[]) {
			for (const name of names) {
				const statements = (await readFile(new URL(name, directory), "utf8"))
					.split("--> statement-breakpoint")
					.map((sql) => sql.trim())
					.filter(Boolean);
				await db.batch(statements.map((sql) => db.prepare(sql)));
			}
		}
		await migrate(files.filter((name) => name < "0006_"));
		const seed = [
			"INSERT INTO products (id, name, product_type, status) VALUES ('p', 'Existing stock', 'stock', 'active')",
			"INSERT INTO product_sellable_items (id, product_id, name, price_minor) VALUES ('i', 'p', 'SKU', '100')",
			"INSERT INTO product_media (id, product_id, object_key, content_type, size_bytes) VALUES ('pm', 'p', 'image', 'image/png', 100)",
			"INSERT INTO shop_orders (id, order_number, currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, expires_at) VALUES ('o', 'OLD-001', 'USD', 2, '100', '0', '100', '100', 9999999999999)",
			"INSERT INTO shop_order_items (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id, delivery_component_type, delivery_component_version, sellable_item_name, quantity, unit_price_minor, subtotal_minor) VALUES ('oi', 'o', 'p', 'i', 'Existing stock', 'i', 'stock', 1, 'SKU', 1, '100', '100')",
			"INSERT INTO order_item_download_assets (id, order_item_id, object_key, file_name, content_type, size_bytes, checksum_sha256) VALUES ('da', 'oi', 'file', 'file.txt', 'text/plain', 100, 'hash')",
			"INSERT INTO customer_entitlements (id, order_item_id, product_id, sellable_item_id, delivery_component_id, entitlement_type) VALUES ('ce', 'oi', 'p', 'i', 'i', 'stock')",
			"INSERT INTO entitlement_authorization_values (id, entitlement_id, definition_key, value_encrypted, key_version, masked_value) VALUES ('av', 'ce', 'key', 'encrypted-value', 1, 'masked')",
			"INSERT INTO entitlement_grants (id, entitlement_id, source_order_item_id) VALUES ('g', 'ce', 'oi')",
			"INSERT INTO delivery_records (id, order_item_id, delivery_type, content_encrypted) VALUES ('d', 'oi', 'stock', 'encrypted-content')",
			"INSERT INTO supplier_accounts (id, provider, base_url, normalized_api_origin, protocol_version, name, credentials_encrypted, credential_fingerprint) VALUES ('a', 'gmshop_edge', 'https://supplier.example', 'https://supplier.example', 'version', 'Existing', 'encrypted-secret', 'fingerprint')",
			"INSERT INTO supplier_bindings (id, sellable_item_id, provider, normalized_api_origin, protocol_version, upstream_product_id, upstream_sku_id, upstream_product_name, upstream_sku_name, reference_cost_minor, max_cost_minor) VALUES ('b', 'i', 'gmshop_edge', 'https://supplier.example', 'version', 'p', 's', 'Product', 'SKU', '100', '150')",
			"INSERT INTO supplier_orders (id, order_id, order_item_id, delivery_record_id, supplier_binding_id, selected_account_id, selected_credentials_revision, provider_request_no, upstream_order_id, quantity, currency, binding_snapshot_json, state) VALUES ('so', 'o', 'oi', 'd', 'b', 'a', 1, 'request', 'old-upstream', 1, 'USD', '{}', 'supplied')",
		];
		await db.batch(seed.map((sql) => db.prepare(sql)));
		const tables = [
			"products",
			"product_sellable_items",
			"product_media",
			"shop_orders",
			"shop_order_items",
			"order_item_download_assets",
			"customer_entitlements",
			"entitlement_authorization_values",
			"entitlement_grants",
			"delivery_records",
			"supplier_accounts",
			"supplier_bindings",
			"supplier_orders",
		];
		async function snapshot() {
			return Promise.all(
				tables.map(
					async (table) =>
						(await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
							.results,
				),
			);
		}
		const before = await snapshot();
		await migrate(files.filter((name) => name >= "0006_"));
		expect(await snapshot()).toEqual(before);
		expect(
			(await db.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
		expect(
			(
				await db
					.prepare(
						"SELECT name FROM sqlite_master WHERE name LIKE '__new_%' OR name LIKE '__service_backup_%'",
					)
					.all()
			).results,
		).toEqual([]);
	} finally {
		await miniflare.dispose();
	}
});
