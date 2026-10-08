import { DomainError } from "#/lib/domain-error";

export async function assertProductTypeChange(
	db: D1Database,
	productId: string,
	productType: "stock" | "download" | "automation" | "service",
) {
	const current = await db
		.prepare("SELECT product_type FROM products WHERE id = ? LIMIT 1")
		.bind(productId)
		.first<{ product_type: string }>();
	if (current?.product_type === productType) return;
	const configured = await db
		.prepare(
			"SELECT 1 FROM product_sellable_items WHERE product_id = ? LIMIT 1",
		)
		.bind(productId)
		.first();
	if (configured)
		throw new DomainError(
			"product_type_configuration_mismatch",
			409,
			"Remove existing sellable items before changing product type",
		);
}
