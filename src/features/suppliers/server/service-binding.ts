import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { getAdminRuntimeServerContext } from "#/server/context";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	adapterForSupplierAccount,
	type SupplierAccountRuntimeRow,
} from "./account-runtime";

export const serviceBindingInputSchema = z.object({
	sellableItemId: z.uuid(),
	accountId: z.uuid(),
	expectedRevision: z.number().int().positive(),
	productId: z.string().trim().min(1).max(512),
	expectedServiceFingerprint: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	maxCostMinor: z
		.string()
		.regex(/^(0|[1-9]\d*)$/)
		.max(64),
});

export const bindServiceSupplierFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof serviceBindingInputSchema>) =>
		serviceBindingInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const [context] = await Promise.all([
			getAdminRuntimeServerContext(systemPermission("suppliers", "update")),
			getAdminRuntimeServerContext(systemPermission("products", "update")),
		]);
		return bindServiceSupplier(context.db, data, {
			actorUserId: context.currentUser.id,
		});
	});

export const previewServiceSupplierFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof serviceBindingInputSchema>) =>
		serviceBindingInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const [context] = await Promise.all([
			getAdminRuntimeServerContext(systemPermission("suppliers", "update")),
			getAdminRuntimeServerContext(systemPermission("products", "update")),
		]);
		return previewServiceSupplier(context.db, data);
	});

export async function previewServiceSupplier(
	db: D1Database,
	raw: unknown,
	options: { fetcher?: typeof fetch } = {},
) {
	const { quote, target, fingerprint } = await loadServiceBinding(
		db,
		raw,
		options,
	);
	return {
		name: quote.name,
		costMinor: quote.costMinor,
		currency: target.currency,
		currencyDecimals: target.currency_decimals,
		fingerprint,
		fields: quote.definitions.map(
			({ key, required, sensitive, validationPattern }) => ({
				key,
				required,
				sensitive,
				validationPattern,
			}),
		),
	};
}

export const listServiceBindingAccountsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const [context] = await Promise.all([
		getAdminRuntimeServerContext(systemPermission("suppliers", "update")),
		getAdminRuntimeServerContext(systemPermission("products", "update")),
	]);
	const rows = await context.db
		.prepare(
			"SELECT id, name, currency, currency_decimals FROM supplier_accounts WHERE provider = 'dhru' AND enabled = 1 ORDER BY name, id",
		)
		.all<{
			id: string;
			name: string;
			currency: string;
			currency_decimals: number;
		}>();
	return rows.results;
});

/** One explicit service binding; never imports the supplier catalog or submits an order. */
export async function bindServiceSupplier(
	db: D1Database,
	raw: unknown,
	options: { actorUserId: string; fetcher?: typeof fetch },
) {
	const { data, target, account, connection, quote, fingerprint } =
		await loadServiceBinding(db, raw, options);
	if (
		data.expectedServiceFingerprint &&
		data.expectedServiceFingerprint !== fingerprint
	)
		throw new DomainError(
			"supplier_service_preview_changed",
			409,
			"Service changed; preview again before binding",
		);
	const now = Date.now(),
		token = crypto.randomUUID(),
		id = crypto.randomUUID();
	const guard =
		"EXISTS (SELECT 1 FROM products WHERE id = ? AND revision_token = ?)";
	const results = await db.batch([
		db
			.prepare(
				"UPDATE products SET status = 'draft', revision = revision + 1, revision_token = ?, updated_at = ? WHERE id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM shop_order_items item JOIN shop_orders orders ON orders.id = item.order_id WHERE item.sellable_item_id = ? AND orders.status = 'pending_payment')",
			)
			.bind(
				token,
				now,
				target.product_id,
				data.expectedRevision,
				data.sellableItemId,
			),
		db
			.prepare(
				`UPDATE supplier_bindings SET enabled = 0, updated_at = ? WHERE sellable_item_id = ? AND enabled = 1 AND ${guard}`,
			)
			.bind(now, data.sellableItemId, target.product_id, token),
		db
			.prepare(`INSERT INTO supplier_bindings (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
    upstream_product_id, upstream_sku_id, upstream_product_name, upstream_sku_name, reference_cost_minor,
    max_cost_minor, stock_quantity, remote_status, last_synced_at, enabled, created_at, updated_at)
    SELECT ?, ?, 'dhru', ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ? WHERE ${guard}`)
			.bind(
				id,
				data.sellableItemId,
				account.normalized_api_origin,
				account.protocol_version,
				data.productId,
				data.productId,
				quote.name,
				quote.name,
				quote.costMinor,
				data.maxCostMinor,
				now,
				now,
				now,
				target.product_id,
				token,
			),
		db
			.prepare(
				`UPDATE product_sellable_items SET fulfillment_source = 'supplier', supplier_status = 'available', cost_minor = ?, updated_at = ? WHERE id = ? AND ${guard}`,
			)
			.bind(
				quote.costMinor,
				now,
				data.sellableItemId,
				target.product_id,
				token,
			),
		db
			.prepare(`INSERT INTO product_definition_versions
   (id, product_id, sellable_item_id, version, schema_json, published_at, created_by, created_at, updated_at)
   SELECT ?, ?, ?, COALESCE((SELECT MAX(version) FROM product_definition_versions WHERE sellable_item_id = ?), 0) + 1, ?, ?, ?, ?, ? WHERE ${guard}`)
			.bind(
				crypto.randomUUID(),
				target.product_id,
				data.sellableItemId,
				data.sellableItemId,
				JSON.stringify(quote.definitions),
				now,
				options.actorUserId,
				now,
				now,
				target.product_id,
				token,
			),

		db
			.prepare(
				`UPDATE supplier_accounts SET balance_minor = ?, balance_synced_at = ?, health_status = 'healthy', updated_at = ? WHERE id = ? AND ${guard}`,
			)
			.bind(
				connection.balance.amountMinor,
				now,
				now,
				account.id,
				target.product_id,
				token,
			),
		db
			.prepare(
				`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, created_at) SELECT ?, ?, 'supplier.service_bound', 'supplier_binding', ?, ? WHERE ${guard}`,
			)
			.bind(
				crypto.randomUUID(),
				options.actorUserId,
				id,
				now,
				target.product_id,
				token,
			),
	]);
	if (Number(results[0]?.meta.changes) !== 1)
		throw new DomainError("product_revision_conflict", 409, "Product changed");
	return {
		id,
		productId: target.product_id,
		revision: data.expectedRevision + 1,
		fields: quote.definitions.map(({ key, required }) => ({ key, required })),
	};
}

/** Shared read-only validation; a preview never writes catalog, balances or audit rows. */
async function loadServiceBinding(
	db: D1Database,
	raw: unknown,
	options: { fetcher?: typeof fetch },
) {
	const data = serviceBindingInputSchema.parse(raw);
	const target = await db
		.prepare(`SELECT p.id AS product_id, p.revision, psi.currency, psi.currency_decimals
 FROM product_sellable_items psi JOIN products p ON p.id = psi.product_id
 WHERE psi.id = ? AND p.product_type = 'service' AND p.status <> 'trashed'`)
		.bind(data.sellableItemId)
		.first<{
			product_id: string;
			revision: number;
			currency: string;
			currency_decimals: number;
		}>();
	if (!target)
		throw new DomainError(
			"service_product_not_found",
			404,
			"Service product not found",
		);
	if (target.revision !== data.expectedRevision)
		throw new DomainError("product_revision_conflict", 409, "Product changed");

	const unpaid = await db
		.prepare(
			"SELECT 1 FROM shop_order_items item JOIN shop_orders orders ON orders.id = item.order_id WHERE item.sellable_item_id = ? AND orders.status = 'pending_payment' LIMIT 1",
		)
		.bind(data.sellableItemId)
		.first();
	if (unpaid)
		throw new DomainError(
			"supplier_service_unpaid_orders",
			409,
			"Finish or cancel pending payments before rebinding",
		);
	const account = await db
		.prepare(
			"SELECT * FROM supplier_accounts WHERE id = ? AND enabled = 1 AND provider = 'dhru'",
		)
		.bind(data.accountId)
		.first<
			SupplierAccountRuntimeRow & {
				normalized_api_origin: string;
				protocol_version: string;
			}
		>();
	if (!account)
		throw new DomainError(
			"supplier_account_unavailable",
			409,
			"Dhru account unavailable",
		);
	if (
		account.currency !== target.currency ||
		account.currency_decimals !== target.currency_decimals
	)
		throw new DomainError(
			"supplier_currency_mismatch",
			409,
			"Service and supplier currency must match",
		);
	const runtime = await loadRuntimeConfig(db);
	const adapter = await adapterForSupplierAccount(account, runtime, {
		fetcher: options.fetcher,
	});
	if (!adapter.getServiceDefinition)
		throw new DomainError(
			"supplier_service_not_ready",
			409,
			"Service quotes unavailable",
		);
	const [connection, quote] = await Promise.all([
		adapter.testConnection(),
		adapter.getServiceDefinition(data.productId),
	]);
	if (BigInt(quote.costMinor) > BigInt(data.maxCostMinor))
		throw new DomainError(
			"supplier_cost_limit_exceeded",
			409,
			"Service cost exceeds the configured limit",
		);

	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify({
				sellableItemId: data.sellableItemId,
				accountId: data.accountId,
				productId: data.productId,
				currency: target.currency,
				currencyDecimals: target.currency_decimals,
				maxCostMinor: data.maxCostMinor,
				quote,
			}),
		),
	);
	const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return { data, target, account, connection, quote, fingerprint };
}
