import { attachRouterServerSsrUtils } from "@tanstack/router-core/ssr/server";
import { describe, expect, it, vi } from "vitest";
import { getRouter } from "#/router";
import { CSP_NONCE_HEADER } from "#/server/http-security";

const state = vi.hoisted(() => ({
	request: new Request("https://shop.example/"),
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => state.request,
}));
vi.mock("../../src/lib/i18n-runtime", () => ({}));
vi.mock("../../src/routeTree.gen", async () => {
	const { createRootRoute } = await import("@tanstack/react-router");
	return { routeTree: createRootRoute() };
});

describe("request nonce before streaming bootstrap initialization", () => {
	it.each(["firstRequestNonce1234", "secondRequestNonce5678", undefined])(
		"stamps bootstrap tags with the current request nonce %s",
		(nonce) => {
			state.request = new Request("https://shop.example/", {
				headers: nonce ? { [CSP_NONCE_HEADER]: nonce } : {},
			});
			const router = getRouter();
			expect(router.options.ssr?.nonce).toBe(nonce);
			// This is the stage Start runs before calling the rendering callback.
			attachRouterServerSsrUtils({ router, manifest: undefined });
			const tags = router.serverSsr?.takeInitialHydrationScriptTags();
			expect(tags?.before.length).toBeGreaterThan(0);
			if (!tags) throw new Error("Missing hydration tags");
			for (const tag of [...tags.before, tags.boundary]) {
				expect(tag.attrs?.nonce).toBe(nonce);
			}
		},
	);
});
