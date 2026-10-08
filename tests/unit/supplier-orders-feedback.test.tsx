// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupplierOrdersPage } from "#/features/suppliers/pages/orders";
import {
	actSupplierOrderFn,
	listSupplierOrdersFn,
} from "#/features/suppliers/server/orders-admin";
import { m } from "#/paraglide/messages";
import { overwriteGetLocale } from "#/paraglide/runtime";

const sample = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	showState: false,
}));
beforeEach(() => {
	sample.showState = false;
	sample.row = {
		id: "00000000-0000-4000-8000-000000000001",
		order_id: "order",
		state: "failed",
		order_status: "fulfilling",
		account_id: null,
		account_locked_at: null,
		provider: "dhru",
		upstream_order_id: null,
		attempt_count: 1,
		selection_count: 1,
		last_error_code: null,
	};
});

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
	ProTable: ({
		columns,
	}: {
		columns: { id?: string; accessorKey?: string; cell?: unknown }[];
	}) => {
		const cell = columns.find((column) => column.id === "actions")
			?.cell as (props: { row: { original: unknown } }) => ReactNode;
		const state = columns.find((column) => column.accessorKey === "state")
			?.cell as (props: { row: { original: unknown } }) => ReactNode;
		const props = { row: { original: sample.row } };
		const upstream = columns.find(
			(column) => column.accessorKey === "upstream_order_id",
		)?.cell as (props: { row: { original: unknown } }) => ReactNode;
		return (
			<>
				{sample.showState ? upstream(props) : null}
				{sample.showState ? state(props) : null}
				{cell(props)}
			</>
		);
	},
}));
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	vi.resetAllMocks();
	vi.unstubAllGlobals();
	overwriteGetLocale(() => "en-US");
});

async function renderOrder() {
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
	return { client, key, container };
}

async function recover() {
	const { client, key, container } = await renderOrder();
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

for (const locale of ["en-US", "zh-CN"] as const) {
	it(`shows a readable manual hold and disables both purchase actions in ${locale}`, async () => {
		overwriteGetLocale(() => locale);
		Object.assign(sample.row, {
			state: "uncertain",
			account_id: "account",
			account_locked_at: 1,
			last_error_code: "private-token",
			provider_request_no: "generic-provider-reference",
		});
		sample.showState = true;
		const { container } = await renderOrder();
		expect(container.textContent).toContain(m.supplier_order_manual_review());
		expect(container.textContent).toContain(
			m.supplier_order_manual_review_description(),
		);
		expect(container.textContent).not.toContain("private-token");
		expect(container.textContent).toContain(m.supplier_purchase_reference());
		expect(container.textContent).toContain(String(sample.row.id));
		expect(container.textContent).not.toContain("generic-provider-reference");
		for (const label of [m.supplier_reconcile(), m.supplier_reselect()]) {
			const button = [...container.querySelectorAll("button")].find(
				(item) => item.textContent === label,
			);
			expect(button?.disabled).toBe(true);
			await act(async () => button?.click());
		}
		expect(actSupplierOrderFn).not.toHaveBeenCalled();
	});
}

it("allows a known Dhru order to reconcile without a manual-hold notice", async () => {
	Object.assign(sample.row, {
		state: "uncertain",
		account_id: "account",
		account_locked_at: 1,
		upstream_order_id: "D1",
	});
	sample.showState = true;
	const { container } = await renderOrder();
	expect(container.textContent).not.toContain(m.supplier_order_manual_review());
	const reconcile = [...container.querySelectorAll("button")].find(
		(item) => item.textContent === m.supplier_reconcile(),
	);
	expect(reconcile?.disabled).toBe(false);
	const reselect = [...container.querySelectorAll("button")].find(
		(item) => item.textContent === m.supplier_reselect(),
	);
	expect(reselect?.disabled).toBe(true);
});

it("disables reselection of a known upstream order even when no account is selected", async () => {
	sample.row.upstream_order_id = "D1";
	const { container } = await renderOrder();
	const button = [...container.querySelectorAll("button")].find(
		(item) => item.textContent === m.supplier_reselect(),
	);
	expect(button?.disabled).toBe(true);
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
