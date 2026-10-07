import { m } from "#/paraglide/messages";

export function supplierErrorLabel(code: string) {
	const labels: Record<string, () => string> = {
		supplier_service_not_ready: m.supplier_error_service_not_ready,
		supplier_sku_missing_once: m.supplier_error_sku_missing,
		supplier_sku_deleted: m.supplier_error_sku_deleted,
		supplier_accounts_exhausted: m.supplier_error_accounts_exhausted,
		supplier_order_processing: m.supplier_error_order_processing,
		supplier_request_uncertain: m.supplier_error_request_uncertain,
		supplier_request_failed: m.supplier_error_request_failed,
		supplier_order_rejected: m.supplier_error_order_rejected,
		supplier_order_id_missing: m.supplier_error_order_id_missing,
		supplier_delivery_empty: m.supplier_error_delivery_empty,
		supplier_order_cancelled: m.supplier_error_order_cancelled,
		supplier_order_failed: m.supplier_error_order_failed,
		supplier_order_refunded: m.supplier_error_order_refunded,
	};
	return labels[code]?.() ?? m.supplier_error_unknown();
}
