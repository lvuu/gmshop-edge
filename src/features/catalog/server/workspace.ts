import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { getAdminServerContext } from "#/server/context";

const schema = z.object({ productId: z.uuid() });
type Row = Record<string, unknown>;

export const getProductWorkspaceFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof schema>) => schema.parse(input))
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("products", "read"),
		);
		const product = await db.$client
			.prepare(`SELECT product.*,
			(SELECT COUNT(*) FROM product_media media WHERE media.product_id = product.id) AS media_count,
			(SELECT COUNT(*) FROM product_sellable_items sellableItem WHERE sellableItem.product_id = product.id) AS sellable_item_count,
			(SELECT COUNT(*) FROM product_sellable_items sellableItem WHERE sellableItem.product_id = product.id AND sellableItem.enabled = 1) AS active_sellable_item_count,
			(SELECT COUNT(*) FROM stock_entries secret
			 JOIN product_sellable_items item ON item.id = secret.sellable_item_id
			 WHERE item.product_id = product.id AND item.enabled = 1
			  AND secret.status = 'available') AS available_stock,
			(SELECT COUNT(*) FROM delivery_records delivery JOIN shop_order_items item ON item.id = delivery.order_item_id WHERE item.product_id = product.id AND delivery.status IN ('pending','processing','failed')) AS delivery_attention,
			(SELECT COUNT(*) FROM automation_jobs job JOIN shop_order_items item ON item.id = job.order_item_id WHERE item.product_id = product.id AND job.status = 'failed') AS failed_builds
			FROM products product
			WHERE product.id = ? LIMIT 1`)
			.bind(data.productId)
			.first<Row>();
		if (!product)
			throw new DomainError("product_not_found", 404, "Product not found");
		const [sales, sellableItems, recentOrders, deliveryTypes] =
			await db.$client.batch([
				db.$client
					.prepare(
						`SELECT orders.currency, orders.currency_decimals, SUM(item.quantity) AS quantity, SUM(CAST(item.subtotal_minor AS INTEGER) - CAST(item.discount_minor AS INTEGER)) AS revenue_minor FROM shop_order_items item JOIN shop_orders orders ON orders.id = item.order_id WHERE item.product_id = ? AND orders.status IN ('paid','fulfilling','completed','refunding') GROUP BY orders.currency, orders.currency_decimals ORDER BY orders.currency`,
					)
					.bind(data.productId),
				db.$client
					.prepare(
						`SELECT sellableItem.id,
						 sellableItem.name, sellableItem.price_minor, sellableItem.currency, sellableItem.currency_decimals, sellableItem.enabled,
						 product.product_type AS delivery_type,
						 COALESCE((SELECT SUM(item.quantity) FROM shop_order_items item JOIN shop_orders orders ON orders.id = item.order_id WHERE item.sellable_item_id = sellableItem.id AND orders.status IN ('paid','fulfilling','completed','refunding')), 0) AS sales_count
						 FROM product_sellable_items sellableItem
						 JOIN products product ON product.id = sellableItem.product_id
						 WHERE sellableItem.product_id = ? ORDER BY sellableItem.sort_order, sellableItem.id`,
					)
					.bind(data.productId),
				db.$client
					.prepare(
						`SELECT DISTINCT orders.id, orders.order_number, orders.status, orders.currency, orders.currency_decimals, orders.total_minor, orders.created_at FROM shop_orders orders JOIN shop_order_items item ON item.order_id = orders.id WHERE item.product_id = ? ORDER BY orders.created_at DESC, orders.id DESC LIMIT 8`,
					)
					.bind(data.productId),
				db.$client
					.prepare(
						`SELECT DISTINCT product.product_type AS type
						 FROM product_sellable_items sellableItem
						 JOIN products product ON product.id = sellableItem.product_id
						 WHERE sellableItem.product_id = ? AND sellableItem.enabled = 1`,
					)
					.bind(data.productId),
			]);
		return {
			product: {
				id: String(product.id),
				name: String(product.name),
				status: String(product.status) as "draft" | "active" | "trashed",
				mediaCount: Number(product.media_count),
				sellableItemCount: Number(product.sellable_item_count),
				activeSellableItemCount: Number(product.active_sellable_item_count),
				availableStock: Number(product.available_stock),
				deliveryAttention: Number(product.delivery_attention),
				failedBuilds: Number(product.failed_builds),
				deliveryTypes: resultRows(deliveryTypes).map(
					(row) =>
						String(row.type) as "stock" | "download" | "automation" | "service",
				),
			},
			sales: resultRows(sales).map((row) => ({
				currency: String(row.currency),
				currencyDecimals: Number(row.currency_decimals),
				quantity: Number(row.quantity),
				revenueMinor: String(row.revenue_minor),
			})),
			sellableItems: resultRows(sellableItems).map((row) => ({
				id: String(row.id),
				name: String(row.name),
				priceMinor: String(row.price_minor),
				currency: String(row.currency),
				currencyDecimals: Number(row.currency_decimals),
				enabled: Boolean(row.enabled),
				deliveryType:
					row.delivery_type == null ? null : String(row.delivery_type),
				salesCount: Number(row.sales_count),
			})),
			recentOrders: resultRows(recentOrders).map((row) => ({
				id: String(row.id),
				orderNumber: String(row.order_number),
				status: String(row.status),
				totalMinor: String(row.total_minor),
				currency: String(row.currency),
				currencyDecimals: Number(row.currency_decimals),
				createdAt: Number(row.created_at),
			})),
		};
	});

function resultRows(result: D1Result<unknown> | null | undefined) {
	return (result?.results ?? []) as Row[];
}
