import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("preserves populated delivery records and referencing rows while enabling service deliveries", () => {
	const db = new DatabaseSync(":memory:");
	const directory = new URL("../../drizzle/", import.meta.url);
	try {
		const files = readdirSync(directory)
			.filter((name) => /^\d+_.*\.sql$/.test(name))
			.sort();
		for (const file of files.filter((name) => name < "0007_"))
			db.exec(readFileSync(new URL(file, directory), "utf8"));
		db.exec(`PRAGMA foreign_keys=ON;
   INSERT INTO products (id, name, product_type, status) VALUES ('p', 'Product', 'stock', 'active');
   INSERT INTO product_sellable_items (id, product_id, name, price_minor) VALUES ('i', 'p', 'SKU', '100');
   INSERT INTO shop_orders (id, order_number, currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, expires_at)
    VALUES ('o', 'ORDER-1', 'USD', 2, '100', '0', '100', '100', 9999999999999);
   INSERT INTO shop_order_items
    (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
     delivery_component_type, delivery_component_version, sellable_item_name, quantity,
     unit_price_minor, discount_minor, subtotal_minor)
    VALUES ('oi', 'o', 'p', 'i', 'Product', 'i', 'stock', 1, 'SKU', 1, '100', '0', '100');
   INSERT INTO delivery_records (id, order_item_id, delivery_type) VALUES ('d', 'oi', 'stock');
   CREATE TABLE delivery_probe (delivery_id TEXT REFERENCES delivery_records(id));
   INSERT INTO delivery_probe VALUES ('d');`);
		const before = db
			.prepare("SELECT * FROM delivery_records WHERE id = 'd'")
			.get();
		db.exec("BEGIN");
		db.exec(
			readFileSync(
				new URL("0007_supplier_service_result.sql", directory),
				"utf8",
			),
		);
		db.exec("COMMIT");
		expect(
			db.prepare("SELECT * FROM delivery_records WHERE id = 'd'").get(),
		).toEqual(before);
		db.exec(
			"UPDATE delivery_records SET delivery_type = 'service' WHERE id = 'd'",
		);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(() =>
			db.exec(
				"UPDATE delivery_records SET delivery_type = 'invalid' WHERE id = 'd'",
			),
		).toThrow();
	} finally {
		db.close();
	}
});
