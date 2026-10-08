import { expect, it } from "vitest";
import {
	productCreateInputSchema,
	productSellableItemsInputSchema,
} from "#/features/catalog/editor-schema";

const item = {
	name: "Test",
	listPriceMinor: null,
	priceMinor: "100",
	costMinor: null,
	currency: "USD",
	currencyDecimals: 2,
	minimumQuantity: 1,
	maximumQuantity: 1,
	maximumPerCustomer: null,
	enabled: true,
	delivery: {
		type: "service",
		durationMs: null,
		usageLimit: null,
		accessLimit: null,
		renewalMode: "disabled",
		emailMode: "link",
		showOnOrderPage: true,
		allowResend: true,
		lowStockThreshold: 0,
	},
};
it("accepts service products and one-time service result policies", () => {
	expect(
		productCreateInputSchema.safeParse({ productType: "service", name: "Test" })
			.success,
	).toBe(true);
	expect(
		productSellableItemsInputSchema.safeParse({
			productId: crypto.randomUUID(),
			expectedRevision: 1,
			sellableItems: [item],
		}).success,
	).toBe(true);
});
it("rejects service expiry, quota, renewals and direct result email", () => {
	for (const patch of [
		{ durationMs: 1000 },
		{ usageLimit: 1 },
		{ accessLimit: 1 },
		{ renewalMode: "stack" },
		{ emailMode: "content" },
	]) {
		expect(
			productSellableItemsInputSchema.safeParse({
				productId: crypto.randomUUID(),
				expectedRevision: 1,
				sellableItems: [{ ...item, delivery: { ...item.delivery, ...patch } }],
			}).success,
		).toBe(false);
	}
});
