import { describe, expect, it } from "vitest";
import {
	supplierOrderActionAllowed,
	supplierOrderNeedsManualReview,
} from "#/features/suppliers/order-actions";

const purchase = {
	state: "uncertain",
	orderStatus: "fulfilling",
	accountId: "account",
	accountLockedAt: 1,
	provider: "dhru",
	upstreamOrderId: null,
};

describe("supplier recovery eligibility", () => {
	it("requires a known Dhru order for reconciliation and distinguishes an active submission from a manual hold", () => {
		expect(supplierOrderNeedsManualReview(purchase)).toBe(true);
		for (const state of ["submitting", "uncertain"]) {
			expect(
				supplierOrderActionAllowed("reconcile", { ...purchase, state }),
			).toBe(false);
			expect(
				supplierOrderActionAllowed("reconcile", {
					...purchase,
					state,
					upstreamOrderId: "D1",
				}),
			).toBe(true);
		}
		expect(
			supplierOrderNeedsManualReview({ ...purchase, state: "submitting" }),
		).toBe(false);
		expect(
			supplierOrderNeedsManualReview({ ...purchase, accountId: null }),
		).toBe(false);
		expect(
			supplierOrderNeedsManualReview({ ...purchase, upstreamOrderId: "D1" }),
		).toBe(false);
	});
	it("preserves the existing reconciliation eligibility of other providers", () => {
		for (const provider of ["acg", "dujiao_next", "gmshop_edge"]) {
			expect(
				supplierOrderActionAllowed("reconcile", { ...purchase, provider }),
			).toBe(true);
			expect(supplierOrderNeedsManualReview({ ...purchase, provider })).toBe(
				false,
			);
		}
	});
	it("rejects completed, refunded and cancelled parents and terminal purchases", () => {
		for (const orderStatus of [
			"pending_payment",
			"cancelled",
			"refunded",
			"completed",
		])
			expect(
				supplierOrderActionAllowed("reconcile", {
					...purchase,
					orderStatus,
					upstreamOrderId: "D1",
				}),
			).toBe(false);
		for (const state of ["failed", "supplied", "refunded"])
			expect(
				supplierOrderActionAllowed("reconcile", {
					...purchase,
					state,
					upstreamOrderId: "D1",
				}),
			).toBe(false);
	});
});
