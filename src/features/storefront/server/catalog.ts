import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { publishedProductInputDefinitionsSchema } from "#/features/catalog/input-values";
import {
	productIdSchema,
	storefrontListSchema,
} from "#/features/storefront/schema";
import { DomainError } from "#/lib/domain-error";
import { getDb } from "#/server/db.server";
import { selectStorefrontProductRow } from "./product-query";
import { storefrontStockExpression } from "./stock-availability";

type Row = Record<string, unknown>;

export const listStorefrontCatalogFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof storefrontListSchema>) =>
		storefrontListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const db = getDb().$client;
		const search = data.search ? `%${data.search}%` : null;
		const filters = ["p.status = 'active'"];
		const bindings: string[] = [];
		if (search) {
			filters.push(`(p.name LIKE ? OR p.description LIKE ? OR EXISTS (
				SELECT 1 FROM json_each(p.tag_names) search_tag
				WHERE search_tag.value LIKE ?
			))`);
			bindings.push(search, search, search);
		}
		if (data.tag) {
			filters.push(`EXISTS (
				SELECT 1 FROM json_each(p.tag_names) filter_tag
				WHERE filter_tag.value = ?
			)`);
			bindings.push(data.tag);
		}
		const orderBy = {
			featured: "p.sort_order, p.created_at DESC, p.id",
			newest: "p.created_at DESC, p.id DESC",
			price_asc: "length(s.price_minor), s.price_minor, p.id",
			price_desc: "length(max_price_minor) DESC, max_price_minor DESC, p.id",
			popular: "sales_count DESC, p.created_at DESC, p.id",
		}[data.sort];
		const [tags, products] = await db.batch([
			db.prepare(
				`SELECT tag.value AS name, COUNT(DISTINCT product.id) AS product_count
				 FROM products product, json_each(product.tag_names) tag
				 WHERE product.status = 'active'
				 GROUP BY tag.value ORDER BY product_count DESC, tag.value`,
			),
			db
				.prepare(`SELECT p.id, p.name, p.description, p.product_type,
			 p.cover_object_key, p.updated_at,
			 p.tag_names AS tags_json,
			 s.id AS sellable_item_id, s.price_minor, s.list_price_minor, s.currency, s.currency_decimals,
			 (SELECT ps.price_minor FROM product_sellable_items ps
			  WHERE ps.product_id = p.id AND ps.enabled = 1
			  ORDER BY length(ps.price_minor) DESC, ps.price_minor DESC, ps.id LIMIT 1) AS max_price_minor,
			 json_array(p.product_type) AS delivery_types,
			 ${storefrontStockExpression("p", "s")} AS available_stock,
			 COALESCE((SELECT SUM(item.quantity) FROM shop_order_items item JOIN shop_orders sold_order ON sold_order.id = item.order_id WHERE item.product_id = p.id AND sold_order.status IN ('paid','completed','fulfilling','refunding','refunded')), 0) AS sales_count
			 FROM products p
			 JOIN product_sellable_items s ON s.id = (
			  SELECT ps.id FROM product_sellable_items ps
			  WHERE ps.product_id = p.id AND ps.enabled = 1
			  ORDER BY length(ps.price_minor), ps.price_minor, ps.sort_order, ps.id LIMIT 1)
			 WHERE ${filters.join(" AND ")}
			 ORDER BY ${orderBy} LIMIT 100`)
				.bind(...bindings),
		]);
		return {
			tags: rows(tags).map((row) => ({
				name: String(row.name),
				productCount: Number(row.product_count),
			})),
			products: rows(products).map((row) => ({
				id: String(row.id),
				name: String(row.name),
				description: row.description == null ? null : String(row.description),
				productType: String(row.product_type) as
					| "stock"
					| "download"
					| "automation"
					| "service",
				tags: JSON.parse(String(row.tags_json)) as string[],
				coverUrl: row.cover_object_key
					? `/api/shop/products/${row.id}/cover?v=${row.updated_at}`
					: null,
				sellableItemId: String(row.sellable_item_id),
				priceMinor: String(row.price_minor),
				maxPriceMinor: String(row.max_price_minor),
				listPriceMinor:
					row.list_price_minor == null ? null : String(row.list_price_minor),
				currency: String(row.currency),
				currencyDecimals: Number(row.currency_decimals),
				availableStock: Number(row.available_stock),
				salesCount: Number(row.sales_count),
				deliveryTypes: JSON.parse(String(row.delivery_types)) as Array<
					"stock" | "download" | "automation" | "service"
				>,
			})),
		};
	});

export const getStorefrontProductFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof productIdSchema>) =>
		productIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const db = getDb().$client;
		const product = await selectStorefrontProductRow(db, data.productId);
		if (!product)
			throw new DomainError("product_not_found", 404, "Product not found");
		const [itemsResult, inputsResult, mediaResult] = await db.batch([
			db
				.prepare(`SELECT sellableItem.*, sellableItem.id AS delivery_component_id,
			 product.product_type AS delivery_type,
			 ${storefrontStockExpression("product", "sellableItem")} AS available_stock
			 FROM product_sellable_items sellableItem JOIN products product ON product.id = sellableItem.product_id
			 WHERE sellableItem.product_id = ? AND sellableItem.enabled = 1 ORDER BY sellableItem.sort_order, sellableItem.id`)
				.bind(product.id),
			db
				.prepare(
					`SELECT item.id AS delivery_component_id, version.id AS version_id,
					 version.version AS definition_version, version.schema_json
					 FROM product_sellable_items item
					 JOIN product_definition_versions version
					  ON version.id = CASE WHEN item.automation_provider IS NOT NULL
                      THEN item.active_definition_version_id ELSE (
                       SELECT latest.id FROM product_definition_versions latest
                       WHERE latest.sellable_item_id = item.id ORDER BY latest.version DESC LIMIT 1
                      ) END
					 WHERE item.product_id = ? AND item.enabled = 1
					  ORDER BY item.sort_order, item.id`,
				)
				.bind(product.id),
			db
				.prepare(
					"SELECT id, object_key, alt_text, created_at FROM product_media WHERE product_id = ? ORDER BY sort_order, id LIMIT 24",
				)
				.bind(product.id),
		]);
		return {
			id: String(product.id),
			name: String(product.name),
			description:
				product.description == null ? null : String(product.description),
			productType: String(product.product_type) as
				| "stock"
				| "download"
				| "automation"
				| "service",
			tags: JSON.parse(String(product.tags_json)) as string[],
			coverUrl: product.cover_object_key
				? `/api/shop/products/${product.id}/cover?v=${product.updated_at}`
				: null,
			sellableItems: rows(itemsResult).map(presentSellableItem),
			inputs: presentInputs(rows(inputsResult)),
			media: rows(mediaResult).map((row) => ({
				id: String(row.id),
				altText: row.alt_text == null ? null : String(row.alt_text),
				cover: row.object_key === product.cover_object_key,
				url: `/api/shop/products/${product.id}/media/${row.id}?v=${row.created_at}`,
			})),
		};
	});

function presentSellableItem(row: Row) {
	return {
		id: String(row.id),
		name: String(row.name),
		listPriceMinor:
			row.list_price_minor == null ? null : String(row.list_price_minor),
		priceMinor: String(row.price_minor),
		currency: String(row.currency),
		currencyDecimals: Number(row.currency_decimals),
		minimumQuantity: Number(row.minimum_quantity),
		maximumQuantity: Number(row.maximum_quantity),
		maximumPerCustomer:
			row.maximum_per_customer == null
				? null
				: Number(row.maximum_per_customer),
		deliveryComponentId: String(row.delivery_component_id),
		deliveryType: String(row.delivery_type) as
			| "stock"
			| "download"
			| "automation"
			| "service",
		durationMs: nullableNumber(row.duration_ms),
		usageLimit: nullableNumber(row.usage_limit),
		accessLimit: nullableNumber(row.access_limit),
		renewalMode: String(row.renewal_mode) as "stack" | "disabled",
		emailMode: String(row.email_mode) as "none" | "link" | "content",
		showOnOrderPage: Boolean(row.show_on_order_page),
		allowResend: Boolean(row.allow_resend),
		availableStock: Number(row.available_stock),
	};
}
function presentInputs(versionRows: Row[]) {
	return versionRows.flatMap((row) => {
		const definitions = parseDefinitions(String(row.schema_json));
		return definitions.map((definition) => ({
			id: `${row.version_id}:${definition.key}`,
			deliveryComponentId: String(row.delivery_component_id),
			key: definition.key,
			name: definition.name,
			description: definition.description || null,
			inputType: definition.inputType,
			scope: definition.scope,
			required: definition.required,
			sensitive: definition.sensitive,
			validationPattern: definition.validationPattern || null,
			minimumValue: definition.minimumValue,
			maximumValue: definition.maximumValue,
			defaultValue: definition.defaultValue || null,
			exampleValue: definition.exampleValue || null,
			options: definition.options,
		}));
	});
}

function parseDefinitions(value: string) {
	try {
		const parsed = publishedProductInputDefinitionsSchema.safeParse(
			JSON.parse(value),
		);
		if (parsed.success) return parsed.data;
	} catch {
		// Corrupt persisted definitions fail closed.
	}
	return [];
}
function nullableNumber(value: unknown) {
	return value == null ? null : Number(value);
}
function rows(result: D1Result<unknown> | null | undefined) {
	return (result?.results ?? []) as Row[];
}
