"use client";

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, Pencil } from "lucide-react";
import { ProButton } from "#/components/pro/base/button";
import { Badge } from "#/components/ui/badge";
import { getProductWorkspaceFn } from "#/features/catalog/server/workspace";
import { shopOrderStatusLabel } from "#/features/shop-orders/labels";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount, formatNumber } from "#/lib/format";
import { m } from "#/paraglide/messages";

export function ProductWorkspacePage({ productId }: { productId: string }) {
	const navigate = useNavigate();
	const query = useQuery({
		queryKey: ["admin", "catalog", "product-workspace", productId],
		queryFn: () => getProductWorkspaceFn({ data: { productId } }),
	});
	if (query.isError)
		return (
			<div className="grid min-h-80 place-items-center">
				<div className="grid justify-items-center gap-3 text-center">
					<p className="text-destructive">{m.catalog_operation_failed()}</p>
					<ProButton onClick={() => query.refetch()} type="button">
						{m.common_retry()}
					</ProButton>
				</div>
			</div>
		);
	if (!query.data) return <div className="h-96 animate-pulse bg-muted" />;
	const { product, sales, sellableItems, recentOrders } = query.data;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-8">
			<PageHeader
				title={product.name}
				description={m.catalog_workspace_description()}
				actions={
					<div className="flex gap-2">
						<ProButton
							onClick={() =>
								window.open(
									`/products/${product.id}`,
									"_blank",
									"noopener,noreferrer",
								)
							}
							type="button"
							variant="outline"
						>
							<ExternalLink />
							{m.catalog_preview()}
						</ProButton>
						<ProButton
							onClick={() =>
								navigate({
									to: "/admin/products/$productId/edit",
									params: { productId },
								})
							}
							type="button"
						>
							<Pencil />
							{m.catalog_editor_title()}
						</ProButton>
					</div>
				}
			/>
			<div className="grid border-y sm:grid-cols-2 xl:grid-cols-5">
				<Metric
					label={m.common_status()}
					value={productStatus(product.status)}
				/>
				<Metric
					label={m.catalog_workspace_sellable_items()}
					value={`${product.activeSellableItemCount} / ${product.sellableItemCount}`}
				/>
				<Metric
					label={m.catalog_workspace_stock_inventory()}
					value={formatNumber(product.availableStock)}
				/>
				<Metric
					label={m.catalog_workspace_fulfillment_attention()}
					value={formatNumber(product.deliveryAttention)}
					warning={product.deliveryAttention > 0}
				/>
				<Metric
					label={m.catalog_workspace_failed_automations()}
					value={formatNumber(product.failedBuilds)}
					warning={product.failedBuilds > 0}
				/>
			</div>
			<section>
				<h2 className="mb-4 font-semibold text-lg">
					{m.catalog_workspace_revenue_sales()}
				</h2>
				<div className="flex flex-wrap gap-8">
					{sales.length ? (
						sales.map((row) => (
							<div key={row.currency}>
								<strong className="text-2xl">
									{formatMinorAmount(
										row.revenueMinor,
										row.currency,
										row.currencyDecimals,
									)}
								</strong>
								<p className="text-muted-foreground text-sm">
									{m.catalog_workspace_units_sold({
										count: formatNumber(row.quantity),
									})}
								</p>
							</div>
						))
					) : (
						<p className="text-muted-foreground text-sm">
							{m.catalog_workspace_no_sales()}
						</p>
					)}
				</div>
			</section>
			<section>
				<h2 className="mb-4 font-semibold text-lg">
					{m.catalog_workspace_sellable_item_performance()}
				</h2>
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="p-3">{m.catalog_sellable_item()}</th>
								<th className="p-3">{m.catalog_delivery_methods()}</th>
								<th className="p-3">{m.catalog_price_minor()}</th>
								<th className="p-3">{m.catalog_workspace_sales()}</th>
								<th className="p-3">{m.common_status()}</th>
							</tr>
						</thead>
						<tbody>
							{sellableItems.map((sellableItem) => (
								<tr className="border-b" key={sellableItem.id}>
									<td className="p-3">
										<strong>{sellableItem.name}</strong>
									</td>
									<td className="p-3">
										{sellableItem.deliveryType
											? deliveryTypeLabel(sellableItem.deliveryType)
											: m.catalog_workspace_unbound()}
									</td>
									<td className="p-3">
										{formatMinorAmount(
											sellableItem.priceMinor,
											sellableItem.currency,
											sellableItem.currencyDecimals,
										)}
									</td>
									<td className="p-3">
										{formatNumber(sellableItem.salesCount)}
									</td>
									<td className="p-3">
										<Badge
											variant={sellableItem.enabled ? "default" : "secondary"}
										>
											{sellableItem.enabled
												? m.catalog_status_active()
												: m.catalog_workspace_disabled()}
										</Badge>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
			<section>
				<h2 className="mb-4 font-semibold text-lg">
					{m.catalog_workspace_recent_orders()}
				</h2>
				<div className="divide-y border-y">
					{recentOrders.map((order) => (
						<Link
							className="flex items-center justify-between gap-4 py-4"
							key={order.id}
							params={{ orderId: order.id }}
							to="/admin/orders/$orderId"
						>
							<div>
								<strong className="font-mono">{order.orderNumber}</strong>
								<p className="text-muted-foreground text-xs">
									{formatDateTime(order.createdAt)}
								</p>
							</div>
							<div className="text-right">
								<strong>
									{formatMinorAmount(
										order.totalMinor,
										order.currency,
										order.currencyDecimals,
									)}
								</strong>
								<p className="text-muted-foreground text-xs">
									{shopOrderStatusLabel(order.status)}
								</p>
							</div>
						</Link>
					))}
				</div>
			</section>
		</div>
	);
}

function Metric({
	label,
	value,
	warning = false,
}: {
	label: string;
	value: string;
	warning?: boolean;
}) {
	return (
		<div className="p-5">
			<p className="text-muted-foreground text-sm">{label}</p>
			<strong className="mt-1 flex items-center gap-2 text-2xl">
				{warning ? <AlertTriangle className="size-5 text-amber-500" /> : null}
				{value}
			</strong>
		</div>
	);
}

function productStatus(status: "draft" | "active" | "trashed") {
	if (status === "active") return m.catalog_status_active();
	if (status === "trashed") return m.catalog_status_trashed();
	return m.catalog_status_draft();
}

function deliveryTypeLabel(type: string) {
	if (type === "service") return m.catalog_product_type_service();
	if (type === "stock") return m.catalog_product_type_stock();
	if (type === "download") return m.catalog_product_type_download();
	return m.catalog_product_type_automation();
}
