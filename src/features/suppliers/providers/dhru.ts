import { ZodError } from "zod";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "../money";
import {
	type SupplierPurchaseResult,
	supplierServiceOrderInputSchema,
	supplierSuppliedResultSchema,
} from "../schema";
import { normalizeSupplierSource } from "../server/source-url";
import { DhruClient, DhruClientError } from "./dhru-client";
import type { SupplierAdapter } from "./types";

/** Server-only provider. Paid service submission requires an explicit input snapshot. */
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
	async submitOrder(
		input: Parameters<SupplierAdapter["submitOrder"]>[0],
	): Promise<SupplierPurchaseResult> {
		if (!input.service) throw serviceNotReady();
		const service = supplierServiceOrderInputSchema.safeParse(input.service);
		if (!service.success) throw invalidServiceInput();
		try {
			const receipt = await this.client.submitOrder({
				productId: service.data.productId,
				fields: service.data.inputData,
				// A job is the correlation unit, including when an order has many items.
				referenceId: input.traceId,
				feedbackUrl: input.callbackUrl,
				quantity: input.quantity,
			});
			if (receipt.currency_code !== this.input.currency)
				return {
					status: "uncertain",
					upstreamOrderId: receipt.order_uuid,
					errorCode: "supplier_currency_mismatch",
				};
			return { status: "processing", upstreamOrderId: receipt.order_uuid };
		} catch (error) {
			if (error instanceof ZodError) throw invalidServiceInput();
			if (!(error instanceof DhruClientError)) throw error;
			return error.outcome === "rejected"
				? { status: "definitively_failed", errorCode: "dhru_order_rejected" }
				: {
						status: "uncertain",
						upstreamOrderId: null,
						errorCode: "dhru_order_uncertain",
					};
		}
	}
	async reconcileOrder(
		input: Parameters<SupplierAdapter["reconcileOrder"]>[0],
	): Promise<SupplierPurchaseResult> {
		if (!input.service) throw serviceNotReady();
		if (!input.upstreamOrderId)
			return {
				status: "uncertain",
				upstreamOrderId: null,
				errorCode: "supplier_order_id_missing",
			};
		let order: Awaited<ReturnType<DhruClient["getOrder"]>>;
		try {
			// Callback content is never accepted here. Only the authenticated GET
			// response can authorize a service result.
			order = await this.client.getOrder(input.upstreamOrderId);
		} catch (error) {
			if (!(error instanceof DhruClientError)) throw error;
			return {
				status: "uncertain",
				upstreamOrderId: input.upstreamOrderId,
				errorCode: "dhru_order_read_failed",
			};
		}
		if (order.quantity !== input.quantity)
			return {
				status: "uncertain",
				upstreamOrderId: input.upstreamOrderId,
				errorCode: "supplier_delivery_quantity_mismatch",
			};
		if (order.status === "rejected")
			return {
				status: "definitively_failed",
				errorCode: "dhru_order_rejected",
			};
		if (order.status !== "success")
			return {
				status: "processing",
				upstreamOrderId: input.upstreamOrderId,
			};
		const result = supplierSuppliedResultSchema.safeParse({
			status: "supplied",
			upstreamOrderId: input.upstreamOrderId,
			fulfillment: { type: "service", resultText: order.replay },
		});
		if (!result.success)
			return {
				status: "uncertain",
				upstreamOrderId: input.upstreamOrderId,
				errorCode: "supplier_service_result_invalid",
			};
		// GET replay is plain text; only webhook replay is base64.
		return result.data;
	}
}

function serviceNotReady() {
	return new DomainError(
		"supplier_service_not_ready",
		409,
		"Dhru requires an explicit service order snapshot",
		{ retryable: false },
	);
}

function invalidServiceInput() {
	return new DomainError(
		"supplier_service_input_invalid",
		400,
		"Service input snapshot is invalid",
		{ retryable: false },
	);
}
