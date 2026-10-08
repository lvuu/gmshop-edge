// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeliveryRevealContent } from "#/features/storefront/components/delivery-reveal-content";

vi.mock("#/components/pro/base/button", () => ({
	CopyButton: ({ copy }: { copy: string }) => (
		<button type="button">{copy}</button>
	),
}));
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("fetch", fetcher);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});
async function render(
	deliveryId = "delivery",
	email = "buyer@example.com",
	strict = false,
) {
	await act(async () => {
		const content = (
			<DeliveryRevealContent
				deliveryId={deliveryId}
				orderNumber="order"
				email={email}
			/>
		);
		root.render(strict ? <StrictMode>{content}</StrictMode> : content);
	});
}
function deferred() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("retries a failed read and uses the current guest proof", async () => {
	fetcher
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValueOnce(Response.json({ content: "Status: Clean" }));
	await render();
	expect(container.querySelector('[role="alert"]')).not.toBeNull();
	await act(async () => container.querySelector("button")?.click());
	expect(container.querySelector("code")?.textContent).toBe("Status: Clean");
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
		email: "buyer@example.com",
	});
});

it("hides the previous result immediately when the guest proof changes", async () => {
	fetcher.mockResolvedValueOnce(Response.json({ content: "Private result" }));
	await render();
	const next = deferred();
	fetcher.mockReturnValueOnce(next.promise);
	await render("delivery", "wrong@example.com");
	expect(container.textContent).not.toContain("Private result");
	await act(async () => next.resolve(new Response(null, { status: 403 })));
	expect(container.querySelector('[role="alert"]')).not.toBeNull();
	expect(container.querySelector("code")).toBeNull();
});

it("ignores a late response for a different delivery even if fetch ignores abort", async () => {
	const old = deferred(),
		next = deferred();
	fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
	await render("old");
	await render("new");
	expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	await act(async () => next.resolve(Response.json({ content: "New result" })));
	await act(async () => old.resolve(Response.json({ content: "Old secret" })));
	expect(container.querySelector("code")?.textContent).toBe("New result");
	expect(container.textContent).not.toContain("Old secret");
});

it("loads correctly after StrictMode replays the effect", async () => {
	fetcher.mockImplementation(async () => Response.json({ content: "Result" }));
	await render("delivery", "buyer@example.com", true);
	expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	expect(container.querySelector("code")?.textContent).toBe("Result");
});

it("treats blank content as a retryable failure instead of loading forever", async () => {
	fetcher.mockResolvedValueOnce(Response.json({ content: "  " }));
	await render();
	expect(container.querySelector('[role="alert"]')).not.toBeNull();
	expect(container.querySelector("button")).not.toBeNull();
});
