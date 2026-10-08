"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
	Copy,
	ExternalLink,
	MoreHorizontal,
	Pencil,
	Plus,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import { catalogOperationErrorMessage } from "#/features/catalog/error-message";
import {
	deleteProductFn,
	listProductsFn,
	reorderProductsFn,
	restoreProductFn,
	trashProductFn,
} from "#/features/catalog/server/admin";
import {
	duplicateProductFn,
	publishProductFn,
} from "#/features/catalog/server/editor";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount, formatNumber } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type ProductPage = Awaited<ReturnType<typeof listProductsFn>>;
type Product = ProductPage["data"][number];

export function ProductsPage({
	view = "catalog",
}: {
	view?: "catalog" | "trash";
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const [refreshKey, setRefreshKey] = useState(0);
	const [permanentDelete, setPermanentDelete] = useState<Product | null>(null);
	const refresh = useCallback(async () => {
		await client.invalidateQueries({
			queryKey: ["admin", "catalog", "products"],
		});
		setRefreshKey((value) => value + 1);
	}, [client]);
	const reorder = useMutation({
		mutationFn: reorderProductsFn,
		onSuccess: refresh,
	});
	const publish = useMutation({
		mutationFn: ({ product, active }: { product: Product; active: boolean }) =>
			publishProductFn({
				data: {
					productId: product.id,
					expectedRevision: product.revision,
					publish: active,
				},
			}),
		onSuccess: refresh,
		onError: (error) => toast.error(catalogOperationErrorMessage(error)),
	});
	const trash = useMutation({
		mutationFn: (product: Product) =>
			trashProductFn({
				data: {
					id: product.id,
					expectedRevision: product.revision,
				},
			}),
		onSuccess: async () => {
			toast.success(m.catalog_product_trashed());
			await refresh();
		},
		onError: (error) => toast.error(catalogOperationErrorMessage(error)),
	});
	const restore = useMutation({
		mutationFn: (product: Product) =>
			restoreProductFn({
				data: { id: product.id, expectedRevision: product.revision },
			}),
		onSuccess: async () => {
			toast.success(m.catalog_product_restored());
			await refresh();
		},
		onError: (error) => toast.error(catalogOperationErrorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: (product: Product) =>
			deleteProductFn({
				data: { id: product.id, expectedRevision: product.revision },
			}),
		onSuccess: async () => {
			setPermanentDelete(null);
			toast.success(m.catalog_product_deleted());
			await refresh();
		},
		onError: (error) => toast.error(catalogOperationErrorMessage(error)),
	});
	const duplicate = useMutation({
		mutationFn: (product: Product) =>
			duplicateProductFn({ data: { productId: product.id } }),
		onSuccess: ({ id }) => {
			toast.success(m.catalog_product_copied());
			return navigate({
				to: "/admin/products/$productId/edit",
				params: { productId: id },
			});
		},
		onError: (error) => toast.error(catalogOperationErrorMessage(error)),
	});
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "name")?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
				view,
			};
			return client.fetchQuery({
				queryKey: ["admin", "catalog", "products", input],
				queryFn: () => listProductsFn({ data: input }),
			});
		},
		[client, view],
	);
	const columns = useMemo<ColumnDef<Product>[]>(
		() => [
			{
				accessorKey: "status",
				header: m.catalog_product_selling(),
				enablePinning: false,
				meta: { pinned: "left" },
				cell: ({ row }) =>
					view === "trash" ? (
						"—"
					) : (
						<Switch
							aria-label={m.catalog_product_selling()}
							checked={row.original.status === "active"}
							disabled={publish.isPending}
							onCheckedChange={(active) =>
								publish.mutate({ product: row.original, active })
							}
						/>
					),
			},
			{
				accessorKey: "name",
				header: m.common_name(),
				meta: { search: true },
				cell: ({ row }) => (
					<Link
						className="font-semibold hover:underline"
						params={{ productId: row.original.id }}
						to="/admin/products/$productId"
					>
						{row.original.name}
					</Link>
				),
			},
			{
				id: "tags",
				header: m.catalog_tags(),
				cell: ({ row }) => (
					<div className="flex max-w-64 flex-wrap gap-1">
						{row.original.tagNames.map((tag) => (
							<Badge key={tag} variant="secondary">
								{tag}
							</Badge>
						))}
					</div>
				),
			},
			{
				accessorKey: "sellableItemCount",
				header: m.catalog_sellable_item_count(),
				cell: ({ row }) =>
					`${formatNumber(row.original.enabledSellableItemCount)} / ${formatNumber(row.original.sellableItemCount)}`,
			},
			{
				id: "price",
				header: m.catalog_price(),
				cell: ({ row }) =>
					row.original.minimumPriceMinor == null ||
					row.original.currency == null ||
					row.original.currencyDecimals == null
						? "—"
						: row.original.minimumPriceMinor === row.original.maximumPriceMinor
							? formatMinorAmount(
									row.original.minimumPriceMinor,
									row.original.currency,
									row.original.currencyDecimals,
								)
							: `${formatMinorAmount(row.original.minimumPriceMinor, row.original.currency, row.original.currencyDecimals)} – ${formatMinorAmount(row.original.maximumPriceMinor ?? row.original.minimumPriceMinor, row.original.currency, row.original.currencyDecimals)}`,
			},
			{
				id: "delivery",
				header: m.catalog_delivery_type(),
				cell: ({ row }) => (
					<Badge variant="outline">
						{deliveryLabel(row.original.productType)}
					</Badge>
				),
			},
			{
				accessorKey: "availableStock",
				header: m.catalog_available_stock(),
				cell: ({ row }) =>
					row.original.productType === "stock"
						? formatNumber(row.original.availableStock)
						: "—",
			},
			{
				accessorKey: "updatedAt",
				header: m.catalog_updated_at(),
				cell: ({ row }) => formatDateTime(row.original.updatedAt),
			},
			{
				id: "actions",
				header: m.common_actions(),
				cell: ({ row }) => (
					<div className="flex justify-end">
						{view === "trash" ? (
							<div className="flex gap-1">
								<ProButton
									size="icon-sm"
									tooltip={m.catalog_product_restore()}
									variant="ghost"
									onClick={() => restore.mutate(row.original)}
								>
									<RotateCcw />
								</ProButton>
								<ProButton
									className="text-destructive-foreground"
									size="icon-sm"
									tooltip={m.catalog_product_delete_permanently()}
									variant="ghost"
									onClick={() => setPermanentDelete(row.original)}
								>
									<Trash2 />
								</ProButton>
							</div>
						) : (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<ProButton
										size="icon-sm"
										tooltip={m.common_actions()}
										variant="ghost"
									>
										<MoreHorizontal />
									</ProButton>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem asChild>
										<Link
											params={{ productId: row.original.id }}
											to="/admin/products/$productId/edit"
										>
											<Pencil />
											{m.catalog_product_edit()}
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() =>
											window.open(
												`/products/${row.original.id}`,
												"_blank",
												"noopener",
											)
										}
									>
										<ExternalLink />
										{m.catalog_preview()}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => duplicate.mutate(row.original)}
									>
										<Copy />
										{m.catalog_product_copy()}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => trash.mutate(row.original)}
										variant="destructive"
									>
										<Trash2 />
										{m.catalog_product_move_to_trash()}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				),
			},
		],
		[
			duplicate.mutate,
			publish.isPending,
			publish.mutate,
			restore.mutate,
			trash.mutate,
			view,
		],
	);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5">
			<PageHeader
				title={view === "trash" ? m.catalog_recycle_bin() : m.nav_products()}
				description={
					view === "trash"
						? m.catalog_recycle_bin_description()
						: m.catalog_products_description()
				}
				actions={
					view === "catalog" ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton>
									<Plus />
									{m.catalog_product_new()}
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{(["stock", "download", "automation", "service"] as const).map(
									(type) => (
										<DropdownMenuItem
											key={type}
											onSelect={() =>
												navigate({
													to: "/admin/products/new",
													search: { type },
												})
											}
										>
											{deliveryLabel(type)}
										</DropdownMenuItem>
									),
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null
				}
			/>
			<ProTable
				className="min-h-0 flex-1"
				columns={columns}
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				onRefresh={refresh}
				dragSort={
					view === "catalog"
						? {
								rowKey: "id",
								onDragSortEnd: (rows) =>
									reorder.mutate({
										data: { ids: rows.map((row) => row.id) },
									}),
							}
						: undefined
				}
				request={request}
				requestKey={refreshKey}
				table={{ stickyHeader: true }}
				toolbarSearch={{ columnId: "name", placeholder: m.common_search() }}
			/>
			<ConfirmDialog
				open={permanentDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPermanentDelete(null);
				}}
				title={m.catalog_product_delete_permanently()}
				desc={m.catalog_product_delete_permanently_description({
					name: permanentDelete?.name ?? "",
				})}
				confirmText={m.catalog_product_delete_permanently()}
				destructive
				isLoading={remove.isPending}
				handleConfirm={() => {
					if (permanentDelete) remove.mutate(permanentDelete);
				}}
			/>
		</div>
	);
}

function deliveryLabel(type: Product["productType"]) {
	if (type === "service") return m.catalog_product_type_service();
	if (type === "stock") return m.catalog_product_type_stock();
	if (type === "download") return m.catalog_product_type_download();
	return m.catalog_product_type_automation();
}
