import { describe, expect, it } from "vitest";
import {
	supplierPurchaseResultSchema,
	supplierSuppliedResultSchema,
} from "#/features/suppliers/schema";

describe("supplier fulfillment result union", () => {
	it("accepts stock cards and service text with structured JSON", () => {
		for (const fulfillment of [
			{ type: "stock", cards: ["CARD-1"] },
			{
				type: "service",
				resultText: "Model: iPhone\nStatus: Clean",
				resultData: { clean: true },
			},
		])
			expect(
				supplierSuppliedResultSchema.parse({
					status: "supplied",
					upstreamOrderId: "upstream-1",
					fulfillment,
				}).fulfillment,
			).toEqual(fulfillment);
	});
	it.each([
		{ type: "stock", cards: [] },
		{ type: "stock", cards: ["CARD"], resultText: "wrong kind" },
		{ type: "service", resultText: " " },
		{ type: "service", resultText: "x", cards: ["wrong kind"] },
		{
			type: "service",
			resultText: "x",
			resultData: { value: () => "non-json" },
		},
		{
			type: "service",
			resultText: "x",
			resultData: { value: "x".repeat(256 * 1024) },
		},
	])("rejects empty, ambiguous and unbounded results", (fulfillment) => {
		expect(
			supplierPurchaseResultSchema.safeParse({
				status: "supplied",
				upstreamOrderId: "upstream-1",
				fulfillment,
			}).success,
		).toBe(false);
	});
	it("rejects the old internal cards-only shape", () => {
		expect(
			supplierPurchaseResultSchema.safeParse({
				status: "supplied",
				upstreamOrderId: "upstream-1",
				cards: ["CARD"],
			}).success,
		).toBe(false);
	});
});
