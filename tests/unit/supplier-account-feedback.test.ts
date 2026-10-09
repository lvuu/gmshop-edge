import { afterEach, describe, expect, it } from "vitest";
import { supplierAccountErrorMessage } from "#/features/suppliers/error-label";
import { m } from "#/paraglide/messages";
import { overwriteGetLocale } from "#/paraglide/runtime";

afterEach(() => overwriteGetLocale(() => "en-US"));
describe("supplier account feedback", () => {
	for (const locale of ["en-US", "zh-CN"] as const) {
		it(`explains known failures without leaking private messages in ${locale}`, () => {
			overwriteGetLocale(() => locale);
			for (const [code, message] of [
				[
					"invalid_supplier_source_url",
					m.supplier_account_error_invalid_source(),
				],
				["supplier_currency_mismatch", m.supplier_account_error_currency()],
				[
					"supplier_source_currency_mismatch",
					m.supplier_account_error_currency(),
				],
				["invalid_supplier_money", m.supplier_account_error_money()],
				["supplier_credentials_required", m.supplier_account_error_input()],
				["invalid_input", m.supplier_account_error_input()],
				["dhru_read_failed", m.supplier_account_error_connection()],
				["supplier_connection_failed", m.supplier_account_error_connection()],
				["supplier_request_failed", m.supplier_account_error_connection()],
				["supplier_account_conflict", m.supplier_account_error_conflict()],
				[
					"supplier_configuration_unavailable",
					m.supplier_account_error_unavailable(),
				],
				["supplier_account_not_found", m.supplier_account_error_not_found()],
				[
					"supplier_source_immutable",
					m.supplier_account_error_source_immutable(),
				],
				["supplier_account_pool_limit", m.supplier_account_error_pool_limit()],
				["forbidden", m.supplier_account_error_access()],
				["unauthorized", m.supplier_account_error_access()],
			]) {
				expect(
					supplierAccountErrorMessage({ code, message: "private-token" }),
				).toBe(message);
				expect(message).not.toContain("private-token");
			}
			for (const error of [
				null,
				new Error("private-token"),
				{ code: "private-token" },
				{ code: 409 },
			]) {
				expect(supplierAccountErrorMessage(error)).toBe(
					m.common_operation_failed(),
				);
			}
		});
	}
});
