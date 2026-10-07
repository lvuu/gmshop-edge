// @vitest-environment jsdom

import {
	Asset,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("router inline script hydration", () => {
	let container: HTMLDivElement;
	let root: Root | undefined;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
	});

	afterEach(() => {
		if (root) act(() => root?.unmount());
		container.remove();
		document.head
			.querySelectorAll("script[data-nonce-regression]")
			.forEach((script) => {
				script.remove();
			});
		root = undefined;
		vi.restoreAllMocks();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
	});

	it.each(["request-nonce", undefined])(
		"reuses the SSR script with nonce %s and preserves page content",
		async (nonce) => {
			const content = "/* nonce hydration regression */";
			container.innerHTML = `<main>Storefront</main><script data-nonce-regression>${content}</script>`;
			const original = container.querySelector("script");
			if (!original) throw new Error("Missing SSR script");
			if (nonce) {
				original.nonce = nonce;
				// HTTP-header CSP hides the attribute in Chromium, but retains .nonce.
				const getAttribute = original.getAttribute.bind(original);
				vi.spyOn(original, "getAttribute").mockImplementation((name) =>
					name === "nonce" ? "" : getAttribute(name),
				);
				expect(original.getAttribute("nonce")).toBe("");
				expect(original.nonce).toBe(nonce);
			}
			const router = createRouter({
				routeTree: createRootRoute(),
				isServer: false,
			});
			const errors: unknown[] = [];
			const append = vi.spyOn(document.head, "appendChild");
			await act(async () => {
				root = hydrateRoot(
					container,
					<RouterContextProvider router={router}>
						<main>Storefront</main>
						<Asset
							tag="script"
							attrs={{ nonce, "data-nonce-regression": true }}
						>
							{content}
						</Asset>
					</RouterContextProvider>,
					{ onRecoverableError: (error) => errors.push(error) },
				);
			});
			expect(errors).toEqual([]);
			expect(append).not.toHaveBeenCalled();
			expect(
				document.querySelectorAll("script[data-nonce-regression]").length,
			).toBeLessThanOrEqual(1);
			expect(container.querySelector("main")?.textContent).toBe("Storefront");
		},
	);
});
