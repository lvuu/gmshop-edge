import { afterEach, describe, expect, it } from "vitest";
import { supplierOrderActionErrorMessage } from "#/features/suppliers/error-label";
import { m } from "#/paraglide/messages";
import { overwriteGetLocale } from "#/paraglide/runtime";

afterEach(() => overwriteGetLocale(() => "en-US"));
describe("supplier recovery feedback", () => {
	for (const locale of ["en-US", "zh-CN"] as const) {
		it(`uses reviewed error codes and hides private messages in ${locale}`, () => {
			overwriteGetLocale(() => locale);
			for (const [code, message] of [
				["supplier_order_changed", m.supplier_action_changed()],
				["supplier_order_action_unavailable", m.supplier_action_unavailable()],
				["supplier_order_account_locked", m.supplier_action_account_locked()],
				["supplier_order_not_found", m.supplier_action_not_found()],
			]) {
				expect(
					supplierOrderActionErrorMessage({ code, message: "private-token" }),
				).toBe(message);
			}
			for (const error of [
				null,
				new Error("private-token"),
				{ code: "private-token" },
				{ code: 409 },
			]) {
				expect(supplierOrderActionErrorMessage(error)).toBe(
					m.common_operation_failed(),
				);
			}
			expect(m.supplier_action_pending_dispatch()).not.toBe(
				m.supplier_action_queued(),
			);
		});
	}
});
