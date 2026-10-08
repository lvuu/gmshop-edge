// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { SupplierOrdersPage } from "#/features/suppliers/pages/orders";
import {
	actSupplierOrderFn,
	listSupplierOrdersFn,
} from "#/features/suppliers/server/orders-admin";
import { m } from "#/paraglide/messages";

vi.mock("#/features/suppliers/server/orders-admin", () => ({
	actSupplierOrderFn: vi.fn(),
	listSupplierOrdersFn: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("#/lib/pro-table-url-state", () => ({
	useCurrentProTableUrlState: () => ({ initialState: {}, onChange: vi.fn() }),
}));
vi.mock("#/layouts/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("#/components/pro/base/button", () => ({
	ProButton: ({ children }: { children: ReactNode }) => (
		<button type="button">{children}</button>
	),
}));
vi.mock("#/components/ui/dropdown-menu", () => ({
	DropdownMenu: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuItem: ({
		children,
		onClick,
		disabled,
	}: {
		children: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
}));
vi.mock("#/components/pro/table", () => ({
	ProTable: ({ columns }: { columns: { id?: string; cell?: unknown }[] }) => {
		const cell = columns.find((column) => column.id === "actions")
			?.cell as (props: { row: { original: unknown } }) => ReactNode;
		return cell({
			row: {
				original: {
					id: "00000000-0000-4000-8000-000000000001",
					order_id: "order",
					state: "failed",
					order_status: "fulfilling",
					account_id: null,
					account_locked_at: null,
				},
			},
		});
	},
}));
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

async function recover() {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Infinity, retry: false },
			mutations: { retry: false },
		},
	});
	const key = [
		"admin",
		"suppliers",
		"orders",
		{ pageIndex: 0, pageSize: 20, search: "" },
	];
	client.setQueryData(key, { data: [], total: 0 });
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	cleanup = async () => {
		await act(async () => root.unmount());
		client.clear();
		container.remove();
	};
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<SupplierOrdersPage />
			</QueryClientProvider>,
		),
	);
	const button = [...container.querySelectorAll("button")].find(
		(item) => item.textContent === m.supplier_reselect(),
	);
	expect(button?.disabled).toBe(false);
	await act(async () => {
		button?.click();
		await new Promise((done) => setTimeout(done, 30));
	});
	return { client, key };
}

it("reports committed recovery awaiting dispatch as success and invalidates cached rows", async () => {
	vi.mocked(actSupplierOrderFn).mockResolvedValue({
		id: "order",
		queued: true,
		dispatch: "pending",
	});
	const { client, key } = await recover();
	expect(toast.success).toHaveBeenCalledWith(
		m.supplier_action_pending_dispatch(),
	);
	expect(toast.error).not.toHaveBeenCalled();
	expect(client.getQueryState(key)?.isInvalidated).toBe(true);
	expect(actSupplierOrderFn).toHaveBeenCalledTimes(1);
});

it("localizes a stale-state error and forces the list cache to refresh", async () => {
	vi.mocked(actSupplierOrderFn).mockRejectedValue({
		code: "supplier_order_changed",
		message: "private-token",
	});
	const { client, key } = await recover();
	expect(toast.error).toHaveBeenCalledWith(m.supplier_action_changed());
	expect(client.getQueryState(key)?.isInvalidated).toBe(true);
	expect(listSupplierOrdersFn).not.toHaveBeenCalled();
});
