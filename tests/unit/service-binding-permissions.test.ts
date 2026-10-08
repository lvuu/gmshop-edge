import { afterEach, expect, it, vi } from "vitest";
import { AccessDeniedError } from "#/features/access/server/access-cache";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { handleServiceBindingRequest } from "#/features/suppliers/server/service-binding-api";

vi.mock("#/features/access/server/require-admin", () => ({
	requireAdmin: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const request = (origin = "https://shop.example") =>
	new Request("https://shop.example/api/admin/suppliers/service-binding", {
		method: "POST",
		headers: { Origin: origin },
		body: "{}",
	});
const db = { prepare: vi.fn() } as unknown as D1Database;

it("refuses cross-origin service binding before authentication or database writes", async () => {
	expect(
		(await handleServiceBindingRequest(request("https://attacker.example"), db))
			.status,
	).toBe(403);
	expect(requireAdmin).not.toHaveBeenCalled();
	expect(db.prepare).not.toHaveBeenCalled();
});
it("refuses anonymous binding", async () => {
	vi.mocked(requireAdmin).mockRejectedValue(new AccessDeniedError(401));
	expect((await handleServiceBindingRequest(request(), db)).status).toBe(401);
	expect(db.prepare).not.toHaveBeenCalled();
});
it("requires both supplier and product update permissions before database writes", async () => {
	vi.mocked(requireAdmin).mockRejectedValue(new AccessDeniedError(403));
	expect((await handleServiceBindingRequest(request(), db)).status).toBe(403);
	expect(requireAdmin).toHaveBeenCalledWith(
		expect.any(Request),
		systemPermission("suppliers", "update"),
	);
	expect(requireAdmin).toHaveBeenCalledWith(
		expect.any(Request),
		systemPermission("products", "update"),
	);
	expect(db.prepare).not.toHaveBeenCalled();
});
