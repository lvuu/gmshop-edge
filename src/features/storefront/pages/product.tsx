"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	Boxes,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	Clock3,
	LogIn,
	Minus,
	PackageCheck,
	Plus,
	ShieldCheck,
	ShoppingCart,
	Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { authClient } from "#/features/auth/auth-client";
import { StoreMoney } from "#/features/exchange-rates/currency-context";
import { addLocalCartItem } from "#/features/storefront/cart-storage";
import { trackCommerceEvent } from "#/features/storefront/commerce-events";
import {
	StorefrontProductCard,
	StorefrontProductCardSkeleton,
} from "#/features/storefront/components/product-card";
import { purchaseMaximum } from "#/features/storefront/product-quantity";
import {
	getStorefrontProductFn,
	listStorefrontCatalogFn,
} from "#/features/storefront/server/catalog";
import { m } from "#/paraglide/messages";

type Product = Awaited<ReturnType<typeof getStorefrontProductFn>>;
type SellableItem = Product["sellableItems"][number];

export function StorefrontProductPage({ productId }: { productId: string }) {
	const session = authClient.useSession();
	const product = useQuery({
		queryKey: ["storefront", "product", productId],
		queryFn: () => getStorefrontProductFn({ data: { productId } }),
		staleTime: 30_000,
	});
	const relatedProducts = useQuery({
		queryKey: [
			"storefront",
			"related-products",
			productId,
			product.data?.tags[0] ?? "",
		],
		queryFn: () =>
			listStorefrontCatalogFn({
				data: {
					search: "",
					tag: product.data?.tags[0] ?? "",
					sort: "featured",
				},
			}),
		enabled: Boolean(product.data),
		staleTime: 30_000,
	});
	const [selectedItemId, setSelectedItemId] = useState<string>();
	const [selectedMediaId, setSelectedMediaId] = useState<string>();
	const [quantity, setQuantity] = useState(1);
	useEffect(() => {
		if (product.data?.id)
			trackCommerceEvent({
				eventType: "product_viewed",
				productId: product.data.id,
			});
	}, [product.data?.id]);
	useEffect(() => {
		const first = product.data?.sellableItems.find(isAvailable);
		if (!selectedItemId && first) {
			setSelectedItemId(first.id);
			setQuantity(first.minimumQuantity);
		}
	}, [product.data, selectedItemId]);
	if (product.isLoading) return <ProductLoadingSkeleton />;
	if (!product.data) return null;
	const data = product.data;
	const gallery = [
		...(data.coverUrl
			? [
					{
						id: "cover",
						altText: data.name,
						url: data.coverUrl,
					},
				]
			: []),
		...data.media.filter((media) => !media.cover),
	];
	const selectedMedia =
		gallery.find((media) => media.id === selectedMediaId) ?? gallery[0];
	const selectedMediaIndex = selectedMedia
		? gallery.findIndex((media) => media.id === selectedMedia.id)
		: -1;
	const selectedItem =
		data.sellableItems.find((item) => item.id === selectedItemId) ??
		data.sellableItems[0];
	const requiresSignIn =
		selectedItem?.deliveryType === "automation" &&
		!session.isPending &&
		!session.data?.user;
	const checkoutPath = selectedItem
		? `/checkout?mode=buy-now&sellableItemId=${encodeURIComponent(selectedItem.id)}&quantity=${quantity}`
		: "/checkout";
	const maximumQuantity = selectedItem
		? purchaseMaximum(selectedItem)
		: undefined;
	const canPurchase =
		selectedItem != null &&
		isAvailable(selectedItem) &&
		Number.isInteger(quantity) &&
		quantity >= selectedItem.minimumQuantity &&
		maximumQuantity != null &&
		quantity <= maximumQuantity;
	const entitlement = selectedItem ? entitlementSummary(selectedItem) : null;
	const delivery = selectedItem
		? deliveryPromise(selectedItem.deliveryType)
		: null;
	const purchaseLimit = selectedItem
		? purchaseLimitSummary(selectedItem)
		: null;
	const recommendations =
		relatedProducts.data?.products
			.filter((relatedProduct) => relatedProduct.id !== data.id)
			.slice(0, 3) ?? [];
	return (
		<div className="container px-4 py-7 sm:py-10">
			<Link
				className="mb-6 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
				to="/"
			>
				<ArrowLeft className="size-4" />
				{m.store_continue_shopping()}
			</Link>
			<div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(420px,7fr)] lg:gap-12">
				<div className="grid content-start gap-3">
					<div className="relative aspect-video overflow-hidden rounded-2xl bg-muted">
						{selectedMedia ? (
							<img
								alt={selectedMedia.altText ?? data.name}
								className="size-full object-cover"
								src={selectedMedia.url}
							/>
						) : (
							<div className="grid size-full place-items-center">
								<Boxes className="size-20 text-primary/40" />
							</div>
						)}
						{gallery.length > 1 ? (
							<>
								<Button
									aria-label={m.pro_pagination_previousPage()}
									className="absolute start-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur-sm hover:bg-background"
									onClick={() => {
										const previous =
											(selectedMediaIndex - 1 + gallery.length) %
											gallery.length;
										setSelectedMediaId(gallery[previous]?.id);
									}}
									size="icon"
									type="button"
									variant="ghost"
								>
									<ChevronLeft />
								</Button>
								<Button
									aria-label={m.pro_pagination_nextPage()}
									className="absolute end-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur-sm hover:bg-background"
									onClick={() => {
										const next = (selectedMediaIndex + 1) % gallery.length;
										setSelectedMediaId(gallery[next]?.id);
									}}
									size="icon"
									type="button"
									variant="ghost"
								>
									<ChevronRight />
								</Button>
								<span className="absolute end-3 bottom-3 rounded-full bg-background/85 px-2.5 py-1 font-medium text-xs tabular-nums shadow-sm backdrop-blur-sm">
									{selectedMediaIndex + 1} / {gallery.length}
								</span>
							</>
						) : null}
					</div>
					{gallery.length > 1 ? (
						<div className="grid grid-cols-5 gap-2">
							{gallery.map((media) => (
								<button
									aria-label={media.altText ?? data.name}
									aria-pressed={media.id === selectedMedia?.id}
									className="aspect-video overflow-hidden rounded-xl bg-muted opacity-65 ring-offset-background transition enabled:hover:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2"
									key={media.id}
									onClick={() => setSelectedMediaId(media.id)}
									type="button"
								>
									<img
										alt={media.altText ?? data.name}
										className="size-full object-cover"
										src={media.url}
									/>
								</button>
							))}
						</div>
					) : null}
				</div>
				<div className="min-w-0 lg:sticky lg:top-26 lg:h-fit">
					<div className="flex flex-wrap gap-2">
						{data.tags.map((tag) => (
							<Badge asChild key={tag} variant="secondary">
								<a
									href={`/?search=&tag=${encodeURIComponent(tag)}&sort=featured`}
								>
									{tag}
								</a>
							</Badge>
						))}
					</div>
					<h1 className="mt-3 text-balance font-semibold text-4xl tracking-[-0.035em] sm:text-5xl">
						{data.name}
					</h1>
					{data.description ? (
						<p className="mt-4 max-w-2xl whitespace-pre-wrap text-muted-foreground leading-7">
							{data.description}
						</p>
					) : null}
					{data.sellableItems.length > 1 ? (
						<fieldset className="mt-7">
							<legend className="mb-3 font-medium">
								{m.store_select_plan()}
							</legend>
							<div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
								{data.sellableItems.map((item) => {
									const selected = item.id === selectedItem?.id;
									return (
										<button
											aria-pressed={selected}
											className="grid min-h-24 content-between gap-4 rounded-xl bg-muted/40 p-4 text-left ring-offset-background transition enabled:hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-primary/10 data-[selected]:ring-2 data-[selected]:ring-primary data-[selected]:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
											data-selected={selected || undefined}
											disabled={!isAvailable(item)}
											key={item.id}
											onClick={() => {
												setSelectedItemId(item.id);
												setQuantity(item.minimumQuantity);
											}}
											type="button"
										>
											<span className="flex items-start justify-between gap-2">
												<span className="font-medium leading-snug">
													{item.name}
												</span>
												{!isAvailable(item) ? (
													<span className="shrink-0 text-muted-foreground text-xs">
														{m.store_sold_out()}
													</span>
												) : null}
											</span>
											<span className="font-semibold text-base text-primary">
												<StoreMoney
													amountMinor={item.priceMinor}
													currency={item.currency}
													decimals={item.currencyDecimals}
												/>
											</span>
										</button>
									);
								})}
							</div>
						</fieldset>
					) : null}
					<div className="mt-7">
						{selectedItem ? (
							<SellableItemSummary sellableItem={selectedItem} />
						) : (
							<p className="text-muted-foreground">{m.store_select_plan()}</p>
						)}
					</div>
					{selectedItem ? (
						<div className="mt-5 grid gap-3">
							{delivery ? (
								<PurchaseHighlight icon={ShieldCheck}>
									{delivery}
								</PurchaseHighlight>
							) : null}
							{requiresSignIn ? (
								<PurchaseHighlight icon={LogIn}>
									{m.store_account_required_description()}
								</PurchaseHighlight>
							) : null}
							{entitlement ? (
								<PurchaseHighlight icon={Clock3}>
									{entitlement}
								</PurchaseHighlight>
							) : null}
							{purchaseLimit ? (
								<PurchaseHighlight icon={PackageCheck}>
									{purchaseLimit}
								</PurchaseHighlight>
							) : null}
							<PurchaseHighlight icon={CircleCheck}>
								{m.store_order_access_promise()}
							</PurchaseHighlight>
						</div>
					) : null}
					<div className="mt-7 grid gap-5">
						{selectedItem &&
							selectedItem.minimumQuantity !== selectedItem.maximumQuantity && (
								<div className="grid w-fit gap-2">
									<Label htmlFor="product-quantity">{m.store_quantity()}</Label>
									<div className="flex h-11 items-center rounded-xl bg-muted/50 p-1">
										<Button
											aria-label={m.store_quantity_decrease()}
											className="size-9 rounded-lg"
											disabled={quantity <= selectedItem.minimumQuantity}
											onClick={() =>
												setQuantity((current) =>
													Math.max(selectedItem.minimumQuantity, current - 1),
												)
											}
											size="icon"
											type="button"
											variant="ghost"
										>
											<Minus />
										</Button>
										<Input
											className="h-9 w-16 border-0 bg-transparent px-1 text-center shadow-none focus-visible:ring-0"
											id="product-quantity"
											max={maximumQuantity}
											min={selectedItem.minimumQuantity}
											onChange={(event) =>
												setQuantity(Number(event.target.value))
											}
											type="number"
											value={quantity}
										/>
										<Button
											aria-label={m.store_quantity_increase()}
											className="size-9 rounded-lg"
											disabled={
												maximumQuantity == null || quantity >= maximumQuantity
											}
											onClick={() =>
												setQuantity((current) =>
													Math.min(maximumQuantity ?? current, current + 1),
												)
											}
											size="icon"
											type="button"
											variant="ghost"
										>
											<Plus />
										</Button>
									</div>
								</div>
							)}
						<div className="grid gap-2 sm:grid-cols-2">
							{requiresSignIn && canPurchase ? (
								<Button asChild className="h-12 rounded-xl">
									<Link search={{ redirect: checkoutPath }} to="/sign-in">
										<LogIn />
										{m.store_sign_in_to_purchase()}
									</Link>
								</Button>
							) : requiresSignIn ? (
								<Button className="h-12 rounded-xl" disabled>
									<LogIn />
									{m.store_sign_in_to_purchase()}
								</Button>
							) : (
								<Button
									className="h-12 rounded-xl"
									disabled={!canPurchase}
									onClick={() => {
										if (!selectedItem) return;
										window.location.assign(checkoutPath);
									}}
								>
									<Zap />
									{m.store_buy_now()}
								</Button>
							)}
							<Button
								className="h-12 rounded-xl"
								disabled={!canPurchase}
								onClick={() => {
									if (!selectedItem || maximumQuantity == null) return;
									const added = addLocalCartItem(
										selectedItem.id,
										quantity,
										maximumQuantity,
									);
									if (!added) {
										toast.error(m.store_cart_limit_reached());
										return;
									}
									trackCommerceEvent({
										eventType: "cart_item_added",
										productId: data.id,
										sellableItemId: selectedItem.id,
									});
									toast.success(m.store_cart_added());
								}}
								variant="outline"
							>
								<ShoppingCart />
								{m.store_add_to_cart()}
							</Button>
						</div>
					</div>
				</div>
			</div>
			{relatedProducts.isLoading ? (
				<RelatedProductsLoadingSkeleton />
			) : recommendations.length ? (
				<section className="mt-20 sm:mt-28">
					<div className="mb-6 flex items-end justify-between gap-5">
						<div>
							<h2 className="font-semibold text-2xl tracking-tight">
								{m.store_related_products()}
							</h2>
							<p className="mt-2 text-muted-foreground text-sm">
								{m.store_related_products_description()}
							</p>
						</div>
						<a
							className="shrink-0 text-primary text-sm transition-opacity hover:opacity-70"
							href={
								data.tags[0]
									? `/?search=&tag=${encodeURIComponent(data.tags[0])}&sort=featured`
									: "/?search=&tag=&sort=featured"
							}
						>
							{m.store_view_more_products()}
						</a>
					</div>
					<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
						{recommendations.map((relatedProduct) => (
							<StorefrontProductCard
								key={relatedProduct.id}
								product={relatedProduct}
							/>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}

export function ProductLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="container px-4 py-7 sm:py-10"
			data-skeleton-layout="product-detail"
		>
			<Skeleton className="mb-6 h-5 w-32" />
			<div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(420px,7fr)] lg:gap-12">
				<div
					className="grid content-start gap-3"
					data-skeleton-region="product-gallery"
				>
					<Skeleton className="aspect-video rounded-2xl" />
					<div
						className="grid grid-cols-5 gap-2"
						data-skeleton-region="product-thumbnails"
					>
						{["media-1", "media-2", "media-3", "media-4", "media-5"].map(
							(key) => (
								<Skeleton className="aspect-video rounded-xl" key={key} />
							),
						)}
					</div>
				</div>
				<div
					className="min-w-0 lg:sticky lg:top-26 lg:h-fit"
					data-skeleton-region="product-purchase"
				>
					<div className="flex min-h-5 gap-2">
						<Skeleton className="h-5 w-20 rounded-full" />
						<Skeleton className="h-5 w-16 rounded-full" />
					</div>
					<Skeleton className="mt-3 h-10 w-3/4 sm:h-12" />
					<div className="mt-4 grid gap-2">
						<Skeleton className="h-5 w-full" />
						<Skeleton className="h-5 w-5/6" />
					</div>
					<div className="mt-7">
						<Skeleton className="mb-3 h-5 w-28" />
						<div
							className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2"
							data-skeleton-region="product-plans"
						>
							<Skeleton className="h-24 rounded-xl" />
							<Skeleton className="h-24 rounded-xl" />
						</div>
					</div>
					<Skeleton className="mt-7 h-10 w-36" />
					<div className="mt-5 grid gap-3">
						{["delivery", "entitlement", "limit", "access"].map((key) => (
							<div className="flex items-start gap-2.5" key={key}>
								<Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
								<Skeleton className="h-4 w-3/4" />
							</div>
						))}
					</div>
					<div className="mt-7 grid gap-5">
						<div className="grid gap-2 sm:grid-cols-2">
							<Skeleton className="h-12 rounded-xl" />
							<Skeleton className="h-12 rounded-xl" />
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function RelatedProductsLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="mt-20 sm:mt-28"
		>
			<div className="mb-6 flex items-end justify-between gap-5">
				<div className="grid gap-2">
					<Skeleton className="h-8 w-44" />
					<Skeleton className="h-4 w-72 max-w-full" />
				</div>
				<Skeleton className="h-5 w-20" />
			</div>
			<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
				{["related-1", "related-2", "related-3"].map((key) => (
					<StorefrontProductCardSkeleton key={key} />
				))}
			</div>
		</section>
	);
}

function SellableItemSummary({ sellableItem }: { sellableItem: SellableItem }) {
	const isFree = BigInt(sellableItem.priceMinor) === 0n;
	const hasDiscount =
		sellableItem.listPriceMinor != null &&
		BigInt(sellableItem.listPriceMinor) > BigInt(sellableItem.priceMinor);
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<strong className="text-4xl text-primary tracking-tight">
				{isFree ? (
					m.store_price_free()
				) : (
					<StoreMoney
						amountMinor={sellableItem.priceMinor}
						currency={sellableItem.currency}
						decimals={sellableItem.currencyDecimals}
					/>
				)}
			</strong>
			{hasDiscount && sellableItem.listPriceMinor ? (
				<span className="text-muted-foreground text-sm line-through">
					<StoreMoney
						amountMinor={sellableItem.listPriceMinor}
						currency={sellableItem.currency}
						decimals={sellableItem.currencyDecimals}
					/>
				</span>
			) : null}
			{sellableItem.availableStock === 0 ? (
				<span className="basis-full text-destructive text-sm">
					{m.store_sold_out()}
				</span>
			) : null}
		</div>
	);
}

function PurchaseHighlight({
	children,
	icon: Icon,
}: {
	children: ReactNode;
	icon: typeof ShieldCheck;
}) {
	return (
		<div className="flex items-start gap-2.5 text-muted-foreground text-sm">
			<Icon className="mt-0.5 size-4 shrink-0 text-primary" />
			<span>{children}</span>
		</div>
	);
}

function purchaseLimitSummary(sellableItem: SellableItem) {
	const orderLimit =
		sellableItem.minimumQuantity === sellableItem.maximumQuantity
			? sellableItem.minimumQuantity === 1
				? null
				: m.store_purchase_exact_quantity({
						quantity: sellableItem.minimumQuantity,
					})
			: sellableItem.minimumQuantity === 1
				? m.store_purchase_maximum_quantity({
						maximum: sellableItem.maximumQuantity,
					})
				: m.store_purchase_quantity_range({
						minimum: sellableItem.minimumQuantity,
						maximum: sellableItem.maximumQuantity,
					});
	const customerLimit =
		sellableItem.maximumPerCustomer == null
			? null
			: m.store_purchase_customer_limit({
					maximum: sellableItem.maximumPerCustomer,
				});
	return [orderLimit, customerLimit].filter(Boolean).join(" · ") || null;
}

function isAvailable(sellableItem: SellableItem) {
	return (
		sellableItem.availableStock < 0 ||
		sellableItem.availableStock >= sellableItem.minimumQuantity
	);
}
function deliveryPromise(type: SellableItem["deliveryType"]) {
	switch (type) {
		case "stock":
			return m.store_delivery_promise_card();
		case "download":
			return m.store_delivery_promise_download();
		case "automation":
			return m.store_delivery_promise_build();
		case "service":
			return m.store_delivery_promise_service();
		default:
			return null;
	}
}
function entitlementSummary(sellableItem: SellableItem) {
	return [
		sellableItem.durationMs == null
			? null
			: m.store_entitlement_duration({
					days: Math.ceil(sellableItem.durationMs / 86_400_000),
				}),
		...(sellableItem.deliveryType === "automation"
			? [
					sellableItem.usageLimit == null
						? null
						: m.store_entitlement_automation_runs({
								count: sellableItem.usageLimit,
							}),
				]
			: []),
		...(sellableItem.deliveryType === "download"
			? [
					sellableItem.accessLimit == null
						? null
						: m.store_entitlement_downloads({
								count: sellableItem.accessLimit,
							}),
				]
			: []),
	]
		.filter(Boolean)
		.join(" · ");
}
