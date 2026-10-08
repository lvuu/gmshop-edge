import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const directory = new URL("../../drizzle/", import.meta.url);
function migrate(db: DatabaseSync, files: string[]) {
	for (const file of files)
		db.exec(readFileSync(new URL(file, directory), "utf8"));
}
const files = readdirSync(directory)
	.filter((file) => /^\d+_.*\.sql$/.test(file))
	.sort();
const insertAccount = `INSERT INTO supplier_accounts
 (id, provider, base_url, normalized_api_origin, protocol_version, name,
 credentials_encrypted, credential_fingerprint)
 VALUES (?, ?, 'https://supplier.example', 'https://supplier.example', 'version', ?, 'encrypted', ?)`;

describe("Dhru provider migration", () => {
	it("supports a clean database and rejects unknown providers", () => {
		const db = new DatabaseSync(":memory:");
		try {
			migrate(db, files);
			db.prepare(insertAccount).run("dhru", "dhru", "Dhru", "fingerprint");
			expect(() =>
				db.prepare(insertAccount).run("bad", "unknown", "Bad", "bad"),
			).toThrow();
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
	it("preserves populated accounts, bindings, referencing rows and indexes in a transaction", () => {
		const db = new DatabaseSync(":memory:");
		try {
			migrate(
				db,
				files.filter((file) => !file.startsWith("0006_")),
			);
			db.exec("PRAGMA foreign_keys=ON");
			db.prepare(insertAccount).run(
				"old",
				"gmshop_edge",
				"Existing",
				"old-fingerprint",
			);
			db.exec(`INSERT INTO products (id, name, product_type, status) VALUES ('p', 'Product', 'stock', 'active');
    INSERT INTO product_sellable_items (id, product_id, name, price_minor) VALUES ('i', 'p', 'SKU', '100');
    INSERT INTO supplier_bindings
     (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
      upstream_product_id, upstream_sku_id, upstream_product_name, upstream_sku_name,
      reference_cost_minor, max_cost_minor)
     VALUES ('b', 'i', 'gmshop_edge', 'https://supplier.example', 'version', 'p', 's', 'Product', 'SKU', '100', '150');
    CREATE TABLE migration_probe (account_id TEXT REFERENCES supplier_accounts(id),
     binding_id TEXT REFERENCES supplier_bindings(id));
    INSERT INTO migration_probe VALUES ('old', 'b');`);
			const before = db
				.prepare("SELECT * FROM supplier_accounts WHERE id = 'old'")
				.get();
			const binding = db
				.prepare("SELECT * FROM supplier_bindings WHERE id = 'b'")
				.get();
			db.exec("BEGIN");
			migrate(
				db,
				files.filter((file) => file.startsWith("0006_")),
			);
			db.exec("COMMIT");
			expect(
				db.prepare("SELECT * FROM supplier_accounts WHERE id = 'old'").get(),
			).toEqual(before);
			expect(
				db.prepare("SELECT * FROM supplier_bindings WHERE id = 'b'").get(),
			).toEqual(binding);
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(() =>
				db
					.prepare(insertAccount)
					.run("duplicate", "gmshop_edge", "Existing", "other"),
			).toThrow();
			db.prepare(insertAccount).run("new", "dhru", "Dhru", "new-fingerprint");
			db.exec("UPDATE supplier_bindings SET provider = 'dhru' WHERE id = 'b'");
		} finally {
			db.close();
		}
	});
});
