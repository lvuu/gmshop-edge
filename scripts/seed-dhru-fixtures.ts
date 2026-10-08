import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import { encryptOrderInput } from "#/features/storefront/server/order-input-secrets";
import { supplierProtocolVersions } from "#/features/suppliers/schema";
import {
	createSupplierCredentialVault,
	supplierCredentialFingerprint,
} from "#/features/suppliers/secrets";

const origin = "https://dhru.example.invalid";
const credentials = { apiToken: "demo-dhru-token-not-real" };
const productId = fixtureId(40, 1);
const itemId = fixtureId(41, 1);
const accountId = fixtureId(42, 1);
const bindingId = fixtureId(43, 1);

export const dhruAcceptanceOrders = [
	{
		suffix: 1,
		scenario: "waiting",
		state: "pending",
		upstreamOrderId: null,
		errorCode: null,
	},
	{
		suffix: 2,
		scenario: "processing",
		state: "uncertain",
		upstreamOrderId: "DHRU-DEMO-2",
		errorCode: null,
	},
	{
		suffix: 3,
		scenario: "success",
		state: "supplied",
		upstreamOrderId: "DHRU-DEMO-3",
		errorCode: null,
	},
	{
		suffix: 4,
		scenario: "rejected",
		state: "failed",
		upstreamOrderId: "DHRU-DEMO-4",
		errorCode: "dhru_order_rejected",
	},
	{
		suffix: 5,
		scenario: "manual-review",
		state: "uncertain",
		upstreamOrderId: null,
		errorCode: "dhru_order_uncertain",
	},
].map((row) => ({
	...row,
	orderNumber: `GMDHRU${String(row.suffix).padStart(6, "0")}`,
	orderId: fixtureId(44, row.suffix),
	orderItemId: fixtureId(45, row.suffix),
	deliveryId: fixtureId(46, row.suffix),
	supplierOrderId: fixtureId(47, row.suffix),
	entitlementId: fixtureId(48, row.suffix),
	grantId: fixtureId(49, row.suffix),
}));

/** Called only by the local acceptance seeder; creates no queue/outbox work. */
export async function createDhruAcceptanceStatements(input: {
	now: number;
	customerUserId: string;
	customerEmail: string;
	commerceSecret: string;
}) {
	const { now, customerUserId, customerEmail, commerceSecret } = input;
	const protocol = supplierProtocolVersions.dhru;
	const credentialVault = await createSupplierCredentialVault(
		"dhru",
		credentials,
		commerceSecret,
	);
	const fingerprint = await supplierCredentialFingerprint(
		"dhru",
		credentials,
		commerceSecret,
	);
	const imei = await encryptOrderInput("490154203237518", commerceSecret);
	const sensitiveInputs = JSON.stringify({
		IMEI: { envelope: imei, keyVersion: 1 },
	});
	const result = await encryptDeliveryContent(
		JSON.stringify({
			type: "service",
			resultText:
				"DEMO ONLY\nModel: iPhone\nStatus: Clean\nNo real supplier order was placed.",
			resultData: { fixture: true, clean: true },
		}),
		commerceSecret,
	);
	const snapshot = JSON.stringify({
		provider: "dhru",
		normalizedApiOrigin: origin,
		protocolVersion: protocol,
		upstreamProductId: "123",
		upstreamSkuId: "123",
		maxCostMinor: "100",
		currencyDecimals: 2,
	});
	const statements = [
		`INSERT INTO products
		 (id, product_type, name, description, status, revision, revision_token, created_at, updated_at)
		 VALUES (${q(productId)}, 'service', 'Dhru 演示服务 / Dhru demo service',
		  'Local acceptance fixture only; supplier disabled and no real purchase.', 'draft', 1,
		  lower(hex(randomblob(16))), ${now}, ${now}) ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO product_sellable_items
		 (id, product_id, name, renewal_mode, email_mode, allow_resend, fulfillment_source,
		  supplier_status, currency, currency_decimals, price_minor, cost_minor, created_at, updated_at)
		 VALUES (${q(itemId)}, ${q(productId)}, '单次服务 / One-time service', 'disabled', 'link', 0,
		  'supplier', 'unavailable', 'USD', 2, '100', '100', ${now}, ${now})
		 ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO supplier_accounts
		 (id, provider, base_url, normalized_api_origin, protocol_version, currency, currency_decimals,
		  name, credentials_encrypted, credential_fingerprint, max_order_cost_minor, health_status,
		  enabled, created_at, updated_at)
		 VALUES (${q(accountId)}, 'dhru', ${q(origin)}, ${q(origin)}, ${q(protocol)}, 'USD', 2,
		  'Dhru 本地演示 / Local demo', ${q(credentialVault)}, ${q(fingerprint)}, '100', 'unknown',
		  0, ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET enabled = 0`,
		`INSERT INTO supplier_bindings
		 (id, sellable_item_id, provider, normalized_api_origin, protocol_version, upstream_product_id,
		  upstream_sku_id, upstream_product_name, upstream_sku_name, reference_cost_minor, max_cost_minor,
		  stock_quantity, remote_status, last_synced_at, enabled, created_at, updated_at)
		 VALUES (${q(bindingId)}, ${q(itemId)}, 'dhru', ${q(origin)}, ${q(protocol)}, '123', '123',
		  'Dhru local demo service', 'One-time service', '100', '100', 0, 'active', ${now}, 1, ${now}, ${now})
		 ON CONFLICT(id) DO NOTHING`,
	];
	for (const row of dhruAcceptanceOrders) {
		const createdAt = now - row.suffix * 600_000;
		const selected = row.state !== "pending";
		const success = row.state === "supplied";
		const paidAt = createdAt + 60_000;
		const suppliedAt = success ? createdAt + 180_000 : null;
		const orderStatus = success
			? "completed"
			: selected
				? "fulfilling"
				: "paid";
		const entitlementStatus = success ? "active" : "pending";
		statements.push(
			`INSERT INTO shop_orders
			 (id, order_number, idempotency_key, user_id, contact_email, normalized_contact_email, locale,
			  status, currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor,
			  expires_at, paid_at, completed_at, created_at, updated_at)
			 VALUES (${q(row.orderId)}, ${q(row.orderNumber)}, ${q(`seed:dhru-order:${row.suffix}`)},
			  ${q(customerUserId)}, ${q(customerEmail)}, ${q(customerEmail.trim().toLowerCase())}, 'zh-CN',
			  ${q(orderStatus)}, 'USD', 2, '100', '0', '100', '100', ${createdAt + 1_800_000},
			  ${paidAt}, ${q(suppliedAt)}, ${createdAt}, ${now}) ON CONFLICT(id) DO NOTHING`,
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
			  delivery_component_type, delivery_component_version, sellable_item_name,
			  sensitive_input_values_json, quantity, unit_price_minor, unit_cost_minor, subtotal_minor,
			  renewal_mode, email_mode, allow_resend, created_at, updated_at)
			 VALUES (${q(row.orderItemId)}, ${q(row.orderId)}, ${q(productId)}, ${q(itemId)},
			  'Dhru 演示服务 / Dhru demo service', ${q(itemId)}, 'service', 1,
			  '单次服务 / One-time service', ${q(sensitiveInputs)}, 1, '100', '100', '100',
			  'disabled', 'link', 0, ${createdAt}, ${now}) ON CONFLICT(id) DO NOTHING`,
			`INSERT INTO customer_entitlements
			 (id, user_id, order_item_id, product_id, sellable_item_id, delivery_component_id,
			  entitlement_type, status, activated_at, created_at, updated_at)
			 VALUES (${q(row.entitlementId)}, ${q(customerUserId)}, ${q(row.orderItemId)},
			  ${q(productId)}, ${q(itemId)}, ${q(itemId)}, 'service', ${q(entitlementStatus)},
			  ${q(suppliedAt)}, ${paidAt}, ${now}) ON CONFLICT(id) DO NOTHING`,
			`INSERT INTO entitlement_grants
			 (id, entitlement_id, source_order_item_id, status, activated_at, applied_at, created_at, updated_at)
			 VALUES (${q(row.grantId)}, ${q(row.entitlementId)}, ${q(row.orderItemId)}, ${q(entitlementStatus)},
			  ${q(suppliedAt)}, ${q(suppliedAt)}, ${paidAt}, ${now}) ON CONFLICT(id) DO NOTHING`,
			`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, request_key, status, content_encrypted, content_key_version,
			  delivered_at, created_at, updated_at)
			 VALUES (${q(row.deliveryId)}, ${q(row.orderItemId)}, 'service',
			  ${q(`seed:dhru-delivery:${row.suffix}`)}, ${q(success ? "delivered" : "awaiting_supply")},
			  ${q(success ? result : null)}, ${q(success ? 1 : null)}, ${q(suppliedAt)}, ${paidAt}, ${now})
			 ON CONFLICT(id) DO NOTHING`,
			`INSERT INTO supplier_orders
			 (id, order_id, order_item_id, delivery_record_id, supplier_binding_id, selected_account_id,
			  selected_credentials_revision, provider_request_no, upstream_order_id, quantity,
			  quoted_unit_cost_minor, total_cost_minor, currency, binding_snapshot_json, state,
			  attempt_count, selection_count, account_locked_at, last_error_code, submitted_at,
			  supplied_at, created_at, updated_at)
			 VALUES (${q(row.supplierOrderId)}, ${q(row.orderId)}, ${q(row.orderItemId)}, ${q(row.deliveryId)},
			  ${q(bindingId)}, ${q(selected ? accountId : null)}, ${q(selected ? 1 : null)},
			  ${q(selected ? row.supplierOrderId : null)}, ${q(row.upstreamOrderId)}, 1,
			  ${q(selected ? "100" : null)}, ${q(selected ? "100" : null)}, 'USD', ${q(snapshot)},
			  ${q(row.state)}, ${selected ? 1 : 0}, ${selected ? 1 : 0}, ${q(selected ? paidAt : null)},
			  ${q(row.errorCode)}, ${q(selected ? paidAt : null)}, ${q(suppliedAt)}, ${paidAt}, ${now})
			 ON CONFLICT(id) DO NOTHING`,
			`INSERT INTO shop_order_events
			 (id, order_id, event_type, visibility, actor_type, created_at)
			 VALUES (${q(fixtureId(50, row.suffix))}, ${q(row.orderId)}, 'payment_succeeded',
			  'customer', 'system', ${paidAt}) ON CONFLICT(id) DO NOTHING`,
		);
	}
	return statements;
}

function fixtureId(prefix: number, suffix: number) {
	return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

function q(value: string | number | null) {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replaceAll("'", "''")}'`;
}
