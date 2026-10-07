import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "../money";
import { normalizeSupplierSource } from "../server/source-url";
import { DhruClient } from "./dhru-client";
import type { SupplierAdapter } from "./types";

/** Account integration only until Service Fulfillment can persist Dhru results. */
export class DhruAdapter implements SupplierAdapter {
	private readonly client: DhruClient;
	constructor(
		private readonly input: {
			baseUrl: string;
			apiToken: string;
			currency: string;
			currencyDecimals: number;
			fetcher?: typeof fetch;
		},
	) {
		const source = normalizeSupplierSource("dhru", input.baseUrl);
		this.client = new DhruClient(
			`${source.baseUrl}/api/reseller/v1`,
			input.apiToken,
			{ fetcher: input.fetcher },
		);
	}

	async testConnection() {
		const account = await this.client.getAccount();
		if (account.currency !== this.input.currency)
			throw new DomainError(
				"supplier_currency_mismatch",
				400,
				"Supplier wallet currency does not match account configuration",
			);
		// Dhru returns balances like 450.78000. Remove only insignificant zeros.
		const balance = account.balance.includes(".")
			? account.balance.replace(/0+$/, "").replace(/\.$/, "")
			: account.balance;
		return {
			siteName: account.name,
			balance: {
				amountMinor: decimalToMinor(balance, this.input.currencyDecimals),
				currency: account.currency,
			},
		};
	}

	async listProducts(): ReturnType<SupplierAdapter["listProducts"]> {
		throw serviceNotReady();
	}
	async getSku(): ReturnType<SupplierAdapter["getSku"]> {
		throw serviceNotReady();
	}
	async submitOrder(): ReturnType<SupplierAdapter["submitOrder"]> {
		throw serviceNotReady();
	}
	async reconcileOrder(): ReturnType<SupplierAdapter["reconcileOrder"]> {
		throw serviceNotReady();
	}
}

function serviceNotReady() {
	return new DomainError(
		"supplier_service_not_ready",
		409,
		"Dhru requires service fulfillment before catalog import or purchasing",
		{ retryable: false },
	);
}
