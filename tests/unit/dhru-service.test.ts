import { afterEach, describe, expect, it, vi } from "vitest";
import { DhruAdapter } from "#/features/suppliers/providers/dhru";
import {
	DhruClient,
	DhruClientError,
} from "#/features/suppliers/providers/dhru-client";
import { providerRequestNumber } from "#/features/suppliers/providers/signatures";
import { supplierServiceOrderInputSchema } from "#/features/suppliers/schema";

const jobId = "550e8400-e29b-41d4-a716-446655440000";
const input = {
	skuId: "unused-for-dhru",
	quantity: 1,
	requestNo: jobId,
	callbackUrl: "https://shop.example/api/suppliers/dhru/callback/account",
	traceId: jobId,
	service: {
		productId: 123,
		inputData: { IMEI: "490154203237518", Country: "US" },
	},
};
const receipt = {
	order_uuid: "D1",
	reference_id: jobId,
	amount: "1.00",
	currency_code: "USD",
};
function adapter() {
	return new DhruAdapter({
		baseUrl: "https://supplier.example",
		apiToken: "test-token",
		currency: "USD",
		currencyDecimals: 2,
	});
}
afterEach(() => vi.restoreAllMocks());

describe("Dhru service orders", () => {
	it("uses the job ID as the provider reference across account selection", () => {
		expect(providerRequestNumber("dhru", jobId, "account-a")).toBe(jobId);
		expect(providerRequestNumber("dhru", jobId, "account-b")).toBe(jobId);
	});
	it("forwards dynamic fields with their original names and job correlation", async () => {
		const submit = vi
			.spyOn(DhruClient.prototype, "submitOrder")
			.mockResolvedValue(receipt);
		expect(await adapter().submitOrder(input)).toEqual({
			status: "processing",
			upstreamOrderId: "D1",
		});
		expect(submit).toHaveBeenCalledExactlyOnceWith({
			productId: 123,
			fields: input.service.inputData,
			referenceId: jobId,
			feedbackUrl: input.callbackUrl,
			quantity: 1,
		});
	});
	it("preserves an order ID when the charged currency does not match", async () => {
		vi.spyOn(DhruClient.prototype, "submitOrder").mockResolvedValue({
			...receipt,
			currency_code: "EUR",
		});
		expect(await adapter().submitOrder(input)).toEqual({
			status: "uncertain",
			upstreamOrderId: "D1",
			errorCode: "supplier_currency_mismatch",
		});
	});
	it.each([
		"reference_id",
		"feedback_url",
		"Quantity",
		"__proto__",
		"constructor",
	])("rejects customer routing key %s before placing an order", async (key) => {
		const submit = vi.spyOn(DhruClient.prototype, "submitOrder");
		await expect(
			adapter().submitOrder({
				...input,
				service: { productId: 123, inputData: { [key]: "override" } },
			}),
		).rejects.toMatchObject({
			code: "supplier_service_input_invalid",
			retryable: false,
		});
		expect(submit).not.toHaveBeenCalled();
	});
	it("bounds input snapshots without coercing customer values", () => {
		expect(
			supplierServiceOrderInputSchema.parse({
				productId: "future-provider-product",
				inputData: { Serial: "001", enabled: false, count: 2, choices: ["US"] },
			}).inputData,
		).toEqual({ Serial: "001", enabled: false, count: 2, choices: ["US"] });
		for (const inputData of [
			{ text: "x".repeat(16_001) },
			{ text: { nested: true } },
			Object.fromEntries(
				Array.from({ length: 101 }, (_, n) => [`key${n}`, "x"]),
			),
			{ a: "界".repeat(16_000), b: "界".repeat(16_000) },
		]) {
			expect(
				supplierServiceOrderInputSchema.safeParse({ productId: 123, inputData })
					.success,
			).toBe(false);
		}
	});
	it.each(["uncertain", "rejected"] as const)(
		"normalizes %s submission without a second POST",
		async (outcome) => {
			const submit = vi
				.spyOn(DhruClient.prototype, "submitOrder")
				.mockRejectedValue(new DhruClientError(outcome));
			expect(await adapter().submitOrder(input)).toEqual(
				outcome === "uncertain"
					? {
							status: "uncertain",
							upstreamOrderId: null,
							errorCode: "dhru_order_uncertain",
						}
					: {
							status: "definitively_failed",
							errorCode: "dhru_order_rejected",
						},
			);
			expect(submit).toHaveBeenCalledTimes(1);
		},
	);
	it("keeps a missing order ID uncertain without sending any request", async () => {
		const get = vi.spyOn(DhruClient.prototype, "getOrder");
		const submit = vi.spyOn(DhruClient.prototype, "submitOrder");
		expect(
			await adapter().reconcileOrder({ ...input, upstreamOrderId: null }),
		).toEqual({
			status: "uncertain",
			upstreamOrderId: null,
			errorCode: "supplier_order_id_missing",
		});
		expect(get).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});
	it.each([
		"new",
		"pre-checking",
		"accepted",
		"in-process",
		"pending",
		"verify",
	] as const)("keeps upstream %s processing", async (status) => {
		const get = vi.spyOn(DhruClient.prototype, "getOrder").mockResolvedValue({
			status,
			quantity: 1,
			replay: "Unverified intermediate text",
		});
		expect(
			await adapter().reconcileOrder({ ...input, upstreamOrderId: "D1" }),
		).toEqual({ status: "processing", upstreamOrderId: "D1" });
		expect(get).toHaveBeenCalledExactlyOnceWith("D1");
	});
	it("fulfills only authenticated success and preserves plain text", async () => {
		vi.spyOn(DhruClient.prototype, "getOrder").mockResolvedValue({
			status: "success",
			quantity: 1,
			replay: "UHJvY2VzcyBjb21wbGV0ZWQ=",
		});
		expect(
			await adapter().reconcileOrder({ ...input, upstreamOrderId: "D1" }),
		).toEqual({
			status: "supplied",
			upstreamOrderId: "D1",
			fulfillment: { type: "service", resultText: "UHJvY2VzcyBjb21wbGV0ZWQ=" },
		});
	});
	it("normalizes authenticated rejection without copying upstream error text", async () => {
		vi.spyOn(DhruClient.prototype, "getOrder").mockResolvedValue({
			status: "rejected",
			quantity: 1,
			replay: "Private customer fields",
		});
		expect(
			await adapter().reconcileOrder({ ...input, upstreamOrderId: "D1" }),
		).toEqual({
			status: "definitively_failed",
			errorCode: "dhru_order_rejected",
		});
	});
	it("preserves the known order ID on a read failure and never submits again", async () => {
		vi.spyOn(DhruClient.prototype, "getOrder").mockRejectedValue(
			new DhruClientError("read_failed", 503),
		);
		const submit = vi.spyOn(DhruClient.prototype, "submitOrder");
		expect(
			await adapter().reconcileOrder({ ...input, upstreamOrderId: "D1" }),
		).toEqual({
			status: "uncertain",
			upstreamOrderId: "D1",
			errorCode: "dhru_order_read_failed",
		});
		expect(submit).not.toHaveBeenCalled();
	});
	it.each([
		[2, "Completed", "supplier_delivery_quantity_mismatch"],
		[1, " ", "supplier_service_result_invalid"],
		[1, "x".repeat(64_001), "supplier_service_result_invalid"],
	])(
		"holds invalid completion quantity %s",
		async (quantity, replay, errorCode) => {
			vi.spyOn(DhruClient.prototype, "getOrder").mockResolvedValue({
				status: "success",
				quantity: Number(quantity),
				replay: String(replay),
			});
			expect(
				await adapter().reconcileOrder({ ...input, upstreamOrderId: "D1" }),
			).toEqual({ status: "uncertain", upstreamOrderId: "D1", errorCode });
		},
	);
});
