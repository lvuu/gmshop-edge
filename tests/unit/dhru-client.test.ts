import { describe, expect, it, vi } from "vitest";
import { DhruClient } from "../../src/features/suppliers/providers/dhru-client";

const input = {
	productId: 123,
	fields: { IMEI: "490154203237518", reference_id: "override" },
	referenceId: "GM-1001",
	feedbackUrl: "https://shop.example/callback",
};
function setup(
	data: unknown,
	status = 200,
	apiStatus = "success",
	code = status,
) {
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			Response.json(
				{ status: apiStatus, code, data },
				{ status, headers: { "Retry-After": "60" } },
			),
		);
	const client = new DhruClient(
		"https://supplier.example/api/reseller/v1/",
		"secret",
		{
			fetcher,
			validateDestination: false,
		},
	);
	return { client, fetcher };
}
describe("Dhru Client", () => {
	it("reads account without converting decimal balances to floats", async () => {
		const data = {
			currency: "USD",
			balance: "450.78000",
			name: "Reseller",
			email: "r@example.com",
		};
		const { client, fetcher } = setup(data);
		expect(await client.getAccount()).toEqual(data);
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://supplier.example/api/reseller/v1/account",
		);
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			redirect: "manual",
			headers: { Authorization: "Bearer secret" },
		});
	});
	it("reads catalog with dynamic field extensions", async () => {
		const data = {
			currency: "USD",
			categories: {},
			products: {
				"123": {
					name: "Check",
					type: "imei",
					price: "1.25",
					fields: [{ name: "IMEI", type: "imei", required: true, custom: 1 }],
				},
			},
		};
		expect(await setup(data).client.listProducts()).toEqual(data);
	});
	it("uses product_id for individual product lookup", async () => {
		const { client, fetcher } = setup({
			product_id: 123,
			product_uuid: "uuid",
		});
		await client.getProduct(123);
		expect(fetcher.mock.calls[0]?.[0]).toContain("/products?product_id=123");
	});
	it("preserves plain-text replay in authenticated order query", async () => {
		const { client, fetcher } = setup({
			status: "success",
			quantity: 1,
			replay: "Process completed",
		});
		expect((await client.getOrder("D25040311111228272516")).replay).toBe(
			"Process completed",
		);
		expect(fetcher.mock.calls[0]?.[0]).toContain(
			"?order_uuid=D25040311111228272516",
		);
	});
	it("submits one order with reserved fields protected and validates correlation", async () => {
		const result = {
			order_uuid: "D1",
			reference_id: "GM-1001",
			amount: 1.25,
			currency_code: "USD",
		};
		const { client, fetcher } = setup([[result]]);
		expect(await client.submitOrder(input)).toEqual(result);
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual([
			{
				product_id: 123,
				fields: [
					{
						IMEI: input.fields.IMEI,
						reference_id: "GM-1001",
						feedback_url: input.feedbackUrl,
						Quantity: 1,
					},
				],
			},
		]);
	});
	it("does not treat HTTP 201 validation errors as successful orders", async () => {
		await expect(
			setup({}, 201, "error").client.submitOrder(input),
		).rejects.toMatchObject({ outcome: "rejected", retryable: false });
	});
	it("exposes rate-limit metadata without automatically retrying", async () => {
		const { client, fetcher } = setup({}, 429, "error");
		await expect(client.submitOrder(input)).rejects.toMatchObject({
			httpStatus: 429,
			retryAfter: "60",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it.each([
		"timeout",
		"invalid-json",
		"server-error",
		"wrong-reference",
		"oversized",
		"redirect",
	])("marks %s as uncertain and never retries paid orders", async (failure) => {
		const { client, fetcher } = setup([
			[
				{
					order_uuid: "D1",
					reference_id: "wrong",
					amount: 1,
					currency_code: "USD",
				},
			],
		]);
		if (failure === "timeout")
			fetcher.mockRejectedValue(new Error("secret customer data"));
		if (failure === "invalid-json")
			fetcher.mockResolvedValue(new Response("secret invalid body"));
		if (failure === "server-error")
			fetcher.mockResolvedValue(
				Response.json({ status: "error", code: 503 }, { status: 503 }),
			);
		if (failure === "oversized")
			fetcher.mockResolvedValue(
				new Response("x", { headers: { "Content-Length": "5000000" } }),
			);
		if (failure === "redirect")
			fetcher.mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { Location: "https://evil.example" },
				}),
			);
		await expect(client.submitOrder(input)).rejects.toMatchObject({
			outcome: "uncertain",
			retryable: false,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("rejects invalid input before sending any order", async () => {
		const { client, fetcher } = setup({});
		await expect(
			client.submitOrder({ ...input, feedbackUrl: "http://shop.example" }),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects credential-bearing or non-HTTPS base URLs", () => {
		expect(
			() => new DhruClient("http://supplier.example/api/reseller/v1", "secret"),
		).toThrow();
		expect(
			() =>
				new DhruClient(
					"https://secret@supplier.example/api/reseller/v1",
					"secret",
				),
		).toThrow();
	});
});
