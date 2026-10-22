import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDhruSupplierCallback } from "#/features/suppliers/server/dhru-callback";

// Minimal D1 mock: rate-limit claim always allows, and UPDATE statements run.
function mockDb(overrides: { run?: () => unknown } = {}) {
	const prepared = {
		bind: () => ({
			first: () => Promise.resolve({ count: 1 }),
			run: () => Promise.resolve(overrides.run?.() ?? { meta: {} }),
		}),
	};
	return { prepare: () => prepared } as unknown as D1Database;
}

function post(body: unknown) {
	return new Request("https://shop.example/api/suppliers/dhru/callback/acct", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

afterEach(() => vi.restoreAllMocks());

describe("Dhru supplier callback", () => {
	it("accepts the documented order_id field and schedules reconciliation", async () => {
		const db = mockDb();
		const response = await handleDhruSupplierCallback(
			post({
				reference_id: "550e8400-e29b-41d4-a716-446655440000",
				order_id: "D25040311111228272516",
				status: "success",
				replay: "UHJvY2VzcyBjb21wbGV0ZWQ=",
			}),
			"550e8400-e29b-41d4-a716-446655440000",
			db,
		);
		expect(response.status).toBe(202);
	});

	it("still accepts order_uuid as a backward-compatible alias", async () => {
		const db = mockDb();
		const response = await handleDhruSupplierCallback(
			post({
				reference_id: "550e8400-e29b-41d4-a716-446655440000",
				order_uuid: "D1",
			}),
			"550e8400-e29b-41d4-a716-446655440000",
			db,
		);
		expect(response.status).toBe(202);
	});

	it("rejects a notice that carries neither order identifier", async () => {
		const db = mockDb();
		const response = await handleDhruSupplierCallback(
			post({
				reference_id: "550e8400-e29b-41d4-a716-446655440000",
			}),
			"550e8400-e29b-41d4-a716-446655440000",
			db,
		);
		expect(response.status).toBe(400);
	});

	it("rejects a non-UUID reference id without scheduling reconciliation", async () => {
		const db = mockDb();
		const response = await handleDhruSupplierCallback(
			post({
				reference_id: "merchant-order-1001",
				order_id: "D1",
			}),
			"550e8400-e29b-41d4-a716-446655440000",
			db,
		);
		expect(response.status).toBe(400);
	});

	it("rejects an invalid account id", async () => {
		const db = mockDb();
		const response = await handleDhruSupplierCallback(
			post({
				reference_id: "550e8400-e29b-41d4-a716-446655440000",
				order_id: "D1",
			}),
			"not-a-uuid",
			db,
		);
		expect(response.status).toBe(400);
	});
});
