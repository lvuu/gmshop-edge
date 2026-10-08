import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("preserves parent records and cascading children while enabling service products", () => {
	const db = new DatabaseSync(":memory:");
	const directory = new URL("../../drizzle/", import.meta.url);
	try {
		for (const file of readdirSync(directory)
			.filter((n) => /^\d+_.*\.sql$/.test(n) && n < "0008_")
			.sort())
			db.exec(readFileSync(new URL(file, directory), "utf8"));
		db.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO products (id, name, product_type, status) VALUES ('p', 'Product', 'stock', 'active');
    INSERT INTO product_sellable_items (id, product_id, name, price_minor) VALUES ('i', 'p', 'SKU', '100');
    INSERT INTO product_media (id, product_id, object_key, content_type, size_bytes) VALUES ('pm', 'p', 'image', 'image/png', 100);
    INSERT INTO shop_orders (id, order_number, currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, expires_at)
     VALUES ('o', 'ORDER-001', 'USD', 2, '100', '0', '100', '100', 9999999999999);
    INSERT INTO shop_order_items (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
     delivery_component_type, delivery_component_version, sellable_item_name, quantity, unit_price_minor, subtotal_minor)
     VALUES ('oi', 'o', 'p', 'i', 'Product', 'i', 'stock', 1, 'SKU', 1, '100', '100');
    INSERT INTO order_item_download_assets (id, order_item_id, object_key, file_name, content_type, size_bytes, checksum_sha256)
     VALUES ('da', 'oi', 'file', 'file.txt', 'text/plain', 100, 'hash');
    INSERT INTO customer_entitlements (id, order_item_id, product_id, sellable_item_id, delivery_component_id, entitlement_type)
     VALUES ('ce', 'oi', 'p', 'i', 'i', 'stock');
    INSERT INTO entitlement_authorization_values (id, entitlement_id, definition_key, value_encrypted, key_version, masked_value)
     VALUES ('av', 'ce', 'imei', 'encrypted', 1, 'masked');
    INSERT INTO entitlement_grants (id, entitlement_id, source_order_item_id) VALUES ('g', 'ce', 'oi');
    INSERT INTO delivery_records (id, order_item_id, delivery_type) VALUES ('d', 'oi', 'stock');`);
		const tables = [
			"products",
			"product_sellable_items",
			"product_media",
			"shop_order_items",
			"order_item_download_assets",
			"customer_entitlements",
			"entitlement_authorization_values",
			"entitlement_grants",
			"delivery_records",
		];
		const before = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
		db.exec("BEGIN");
		db.exec(
			readFileSync(new URL("0008_service_products.sql", directory), "utf8"),
		);
		db.exec("COMMIT");
		expect(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(
			before,
		);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		db.exec("UPDATE products SET product_type = 'service' WHERE id = 'p'");
		db.exec(
			"UPDATE shop_order_items SET delivery_component_type = 'service', renewal_mode = 'disabled' WHERE id = 'oi'",
		);
		db.exec(
			"UPDATE customer_entitlements SET entitlement_type = 'service' WHERE id = 'ce'",
		);
		expect(() =>
			db.exec(
				"UPDATE shop_order_items SET email_mode = 'content' WHERE id = 'oi'",
			),
		).toThrow();
		expect(() =>
			db.exec("UPDATE products SET product_type = 'manual' WHERE id = 'p'"),
		).toThrow();
	} finally {
		db.close();
	}
});
