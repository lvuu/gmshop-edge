// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceBindingForm } from "#/features/suppliers/components/service-binding-form";
import {
	bindServiceSupplierFn,
	listServiceBindingAccountsFn,
} from "#/features/suppliers/server/service-binding";

vi.mock("#/features/suppliers/server/service-binding", () => ({
	bindServiceSupplierFn: vi.fn(),
	listServiceBindingAccountsFn: vi.fn(),
}));
vi.mock("#/components/pro/base/fields/select", () => ({
	Select: ({
		options,
		value,
		onChange,
		disabled,
	}: {
		options: { value: string; label: string }[];
		value: string;
		onChange: (value: string) => void;
		disabled: boolean;
	}) => (
		<select
			disabled={disabled}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		>
			<option value="" />
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	),
}));
const item = {
	id: "item",
	name: "Test service",
	currency: "USD",
	currencyDecimals: 2,
};
let cleanup: () => Promise<void>;
afterEach(async () => {
	await cleanup?.();
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});
async function render(disabled = false) {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(listServiceBindingAccountsFn).mockResolvedValue([
		{ id: "usd", name: "USD account", currency: "USD", currency_decimals: 2 },
		{ id: "eur", name: "EUR account", currency: "EUR", currency_decimals: 2 },
	]);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const onBound = vi.fn(async () => undefined),
		onBusy = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<ServiceBindingForm
					items={[item]}
					revision={7}
					disabled={disabled}
					onBound={onBound}
					onBusy={onBusy}
				/>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	cleanup = async () => {
		await act(async () => root.unmount());
		client.clear();
		container.remove();
	};
	return { container, onBound, onBusy };
}
it("disables binding while product changes are unsaved", async () => {
	const { container } = await render(true);
	expect(container.querySelector("button")?.disabled).toBe(true);
	expect(bindServiceSupplierFn).not.toHaveBeenCalled();
});
it("filters accounts by exact currency and submits decimal cost without floats", async () => {
	const { container, onBound, onBusy } = await render();
	const selects = container.querySelectorAll("select");
	const first = selects[0],
		second = selects[1];
	if (!first || !second) throw new Error("missing fields");
	await act(async () => {
		first.value = "item";
		first.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect([...second.options].map((o) => o.value)).toEqual(["", "usd"]);
	await act(async () => {
		second.value = "usd";
		second.dispatchEvent(new Event("change", { bubbles: true }));
	});
	const inputs = container.querySelectorAll("input");
	const set = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!set || !inputs[0] || !inputs[1]) throw new Error("missing inputs");
	await act(async () => {
		set.call(inputs[0], "123");
		inputs[0]?.dispatchEvent(new Event("input", { bubbles: true }));
		set.call(inputs[1], "1.25");
		inputs[1]?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	vi.mocked(bindServiceSupplierFn).mockResolvedValue({
		id: crypto.randomUUID(),
		productId: "product",
		revision: 8,
		fields: [{ key: "IMEI", required: true }],
	});
	await act(async () =>
		[...container.querySelectorAll("button")].at(-1)?.click(),
	);
	expect(bindServiceSupplierFn).toHaveBeenCalledWith({
		data: {
			sellableItemId: "item",
			accountId: "usd",
			expectedRevision: 7,
			productId: "123",
			maxCostMinor: "125",
		},
	});
	expect(onBound).toHaveBeenCalledOnce();
	expect(onBusy.mock.calls).toEqual([[true], [false]]);
	expect(container.textContent).toContain("IMEI");
});
