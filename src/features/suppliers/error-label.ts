import { m } from "#/paraglide/messages";

export function supplierOrderActionErrorMessage(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error ? error.code : null;
	switch (code) {
		case "supplier_order_changed":
			return m.supplier_action_changed();
		case "supplier_order_action_unavailable":
			return m.supplier_action_unavailable();
		case "supplier_order_account_locked":
			return m.supplier_action_account_locked();
		case "supplier_order_not_found":
			return m.supplier_action_not_found();
		default:
			return m.common_operation_failed();
	}
}

export function supplierErrorLabel(code: string) {
	const labels: Record<string, () => string> = {
		dhru_order_read_failed: m.supplier_error_request_failed,
		dhru_order_uncertain: m.supplier_error_request_uncertain,
		dhru_order_rejected: m.supplier_error_order_rejected,
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
