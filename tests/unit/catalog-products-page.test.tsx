// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductsPage } from "#/features/catalog/pages/products";

const mocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	proTableProps: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
	useNavigate: () => mocks.navigate,
}));

vi.mock("#/components/pro/table", () => ({
	ProTable: (props: unknown) => {
		mocks.proTableProps(props);
		return null;
	},
}));

vi.mock("#/lib/pro-table-url-state", () => ({
	useCurrentProTableUrlState: () => ({
		initialState: {},
		onChange: vi.fn(),
	}),
}));

vi.mock("#/features/catalog/server/admin", () => ({
	deleteProductFn: vi.fn(),
	listProductsFn: vi.fn(),
	reorderProductsFn: vi.fn(),
	restoreProductFn: vi.fn(),
	trashProductFn: vi.fn(),
}));

vi.mock("#/features/catalog/server/editor", () => ({
	duplicateProductFn: vi.fn(),
	publishProductFn: vi.fn(),
}));

describe("catalog product list", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("chooses a product type before opening the creation page", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				mutations: { retry: false },
				queries: { retry: false },
			},
		});
		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<ProductsPage />
				</QueryClientProvider>,
			);
		});
		const addButton = Array.from(container.querySelectorAll("button")).at(-1);
		expect(addButton).not.toBeNull();
		await act(async () =>
			addButton?.dispatchEvent(
				new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
			),
		);
		const firstType = Array.from(
			document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		).at(-1);
		expect(firstType).not.toBeNull();
		expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
		await act(async () => firstType?.click());
		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/admin/products/new",
			search: { type: "service" },
		});
	});

	it("keeps the sales column fixed immediately after row sorting", async () => {
		const queryClient = new QueryClient();
		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<ProductsPage />
				</QueryClientProvider>,
			);
		});

		const props = mocks.proTableProps.mock.lastCall?.[0] as {
			columns: Array<{
				accessorKey?: string;
				enablePinning?: boolean;
				meta?: { pinned?: string };
			}>;
			dragSort?: unknown;
		};
		expect(props.dragSort).toBeDefined();
		expect(props.columns[0]).toMatchObject({
			accessorKey: "status",
			enablePinning: false,
			meta: { pinned: "left" },
		});
	});
});
