import { afterEach, expect, it, vi } from "vitest";
import { systemPermission } from "#/features/access/system-rbac";
import {
	listServiceBindingAccountsFn,
	previewServiceSupplierFn,
} from "#/features/suppliers/server/service-binding";
import { getAdminRuntimeServerContext } from "#/server/context";

vi.mock("#/server/context", () => ({ getAdminRuntimeServerContext: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
	createServerOnlyFn: <T>(handler: T) => handler,
	createServerFn: () => ({
		validator() {
			return this;
		},
		handler: (handler: unknown) => handler,
	}),
}));
afterEach(() => vi.resetAllMocks());
it.each(["suppliers", "products"] as const)(
	"preview requires %s update permission before accessing the database",
	async (module) => {
		const db = { prepare: vi.fn() };
		vi.mocked(getAdminRuntimeServerContext).mockImplementation(
			async (permission) => {
				if (
					JSON.stringify(permission) ===
					JSON.stringify(systemPermission(module, "update"))
				)
					throw new Error("forbidden");
				return { db } as unknown as Awaited<
					ReturnType<typeof getAdminRuntimeServerContext>
				>;
			},
		);
		await expect(
			previewServiceSupplierFn({
				data: {
					sellableItemId: crypto.randomUUID(),
					accountId: crypto.randomUUID(),
					expectedRevision: 1,
					productId: "123",
					maxCostMinor: "150",
				},
			}),
		).rejects.toThrow("forbidden");
		expect(getAdminRuntimeServerContext).toHaveBeenCalledWith(
			systemPermission("suppliers", "update"),
		);
		expect(getAdminRuntimeServerContext).toHaveBeenCalledWith(
			systemPermission("products", "update"),
		);
		expect(db.prepare).not.toHaveBeenCalled();
	},
);
it("account choices refuse anonymous sessions before querying credentials", async () => {
	vi.mocked(getAdminRuntimeServerContext).mockRejectedValue(
		new Error("unauthorized"),
	);
	await expect(listServiceBindingAccountsFn()).rejects.toThrow("unauthorized");
});
