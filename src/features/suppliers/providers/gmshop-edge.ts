import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import type { SupplierPurchaseResult } from "../schema";
import { supplierFetchJson } from "./http";
import { signGmshopEdgeRequest } from "./signatures";
import type { SupplierAdapter, SupplierProduct, SupplierSku } from "./types";

const minor = z.string().regex(/^(0|[1-9]\d*)$/);
const skuSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	cost_minor: minor,
	stock_quantity: z.number().int().nonnegative(),
	active: z.boolean(),
});
const productSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	description: z.string().default(""),
	image_urls: z.array(z.string()).default([]),
	category_names: z.array(z.string()).default([]),
	active: z.boolean(),
	updated_at: z.string().nullable().optional(),
	skus: z.array(skuSchema).max(10_000),
});

export class GmshopEdgeAdapter implements SupplierAdapter {
	constructor(
		private readonly input: {
			baseUrl: string;
			apiKey: string;
			apiSecret: string;
			currency: string;
			currencyDecimals: number;
			fetcher?: typeof fetch;
			now?: () => number;
			nonce?: () => string;
		},
	) {}

	async testConnection() {
		const parsed = z
			.object({
				site_name: z.string(),
				balance_minor: minor,
				currency: z.string(),
			})
			.parse(await this.request("POST", "/api/v1/supplier/ping"));
		this.assertCurrency(parsed.currency);
		return {
			siteName: parsed.site_name,
			balance: { amountMinor: parsed.balance_minor, currency: parsed.currency },
		};
	}

	async listProducts(input: {
		page: number;
		pageSize: number;
		updatedAfter?: string;
		includeInactive?: boolean;
	}) {
		const query = new URLSearchParams({
			page: String(input.page),
			page_size: String(Math.min(input.pageSize, 100)),
		});
		if (input.updatedAfter) query.set("updated_after", input.updatedAfter);
		if (input.includeInactive) query.set("include_inactive", "true");
		const parsed = z
			.object({
				total: z.number().int().nonnegative(),
				items: z.array(productSchema),
			})
			.parse(await this.request("GET", `/api/v1/supplier/products?${query}`));
		return { total: parsed.total, products: parsed.items.map(product) };
	}

	async getSku(productId: string, skuId: string) {
		const parsed = z
			.object({ product: productSchema })
			.parse(
				await this.request(
					"GET",
					`/api/v1/supplier/products/${encodeURIComponent(productId)}`,
				),
			);
		const sku = product(parsed.product).skus.find((item) => item.id === skuId);
		if (!sku)
			throw new DomainError("supplier_sku_not_found", 404, "SKU not found");
		return sku;
	}

	async submitOrder(input: {
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		const parsed = z
			.object({
				ok: z.boolean(),
				order_id: z.string().optional(),
				status: z.string().optional(),
				error_code: z.string().optional(),
			})
			.parse(
				await this.request("POST", "/api/v1/supplier/orders", {
					sku_id: input.skuId,
					quantity: input.quantity,
					downstream_order_no: input.requestNo,
					callback_url: input.callbackUrl,
					trace_id: input.traceId,
				}),
			);
		if (!parsed.ok || !parsed.order_id)
			return {
				status: "definitively_failed",
				errorCode: parsed.error_code ?? "supplier_order_rejected",
			};
		return { status: "processing", upstreamOrderId: parsed.order_id };
	}

	async reconcileOrder(input: {
		upstreamOrderId: string | null;
	}): Promise<SupplierPurchaseResult> {
		if (!input.upstreamOrderId)
			return {
				status: "uncertain",
				upstreamOrderId: null,
				errorCode: "supplier_order_id_missing",
			};
		const parsed = z
			.object({
				order_id: z.string(),
				status: z.enum([
					"processing",
					"supplied",
					"cancelled",
					"failed",
					"refunded",
				]),
				cards: z.array(z.string().min(1).max(64_000)).max(10_000).optional(),
			})
			.parse(
				await this.request(
					"GET",
					`/api/v1/supplier/orders/${encodeURIComponent(input.upstreamOrderId)}`,
				),
			);
		if (parsed.status === "supplied" && parsed.cards?.length)
			return {
				status: "supplied",
				upstreamOrderId: parsed.order_id,
				fulfillment: { type: "stock", cards: parsed.cards },
			};
		if (["cancelled", "failed", "refunded"].includes(parsed.status))
			return {
				status: "definitively_failed",
				errorCode: `supplier_order_${parsed.status}`,
			};
		return { status: "processing", upstreamOrderId: parsed.order_id };
	}

	private async request(
		method: string,
		pathWithQuery: string,
		value?: unknown,
	) {
		const rawBody = value === undefined ? "" : JSON.stringify(value);
		const timestamp = String(
			Math.floor((this.input.now?.() ?? Date.now()) / 1000),
		);
		const nonce = this.input.nonce?.() ?? crypto.randomUUID();
		const { status, body } = await supplierFetchJson(
			this.input.fetcher ?? fetch,
			`${this.input.baseUrl}${pathWithQuery}`,
			{
				method,
				headers: {
					"GMShop-Edge-Api-Key": this.input.apiKey,
					"GMShop-Edge-Timestamp": timestamp,
					"GMShop-Edge-Nonce": nonce,
					"GMShop-Edge-Signature": signGmshopEdgeRequest({
						method,
						pathWithQuery,
						timestamp,
						nonce,
						rawBody,
						apiSecret: this.input.apiSecret,
					}),
					...(value === undefined
						? {}
						: { "Content-Type": "application/json" }),
				},
				body: value === undefined ? undefined : rawBody,
			},
			{ validateDestination: !this.input.fetcher },
		);
		if (status !== 200)
			throw new DomainError(
				"supplier_request_failed",
				502,
				"Supplier request failed",
			);
		return body;
	}

	private assertCurrency(currency: string) {
		if (currency.toUpperCase() !== this.input.currency.toUpperCase())
			throw new DomainError(
				"supplier_currency_mismatch",
				502,
				"Supplier currency mismatch",
			);
	}
}

function product(value: z.infer<typeof productSchema>): SupplierProduct {
	return {
		id: value.id,
		name: value.name,
		description: value.description,
		imageUrls: value.image_urls,
		categoryNames: value.category_names,
		active: value.active,
		...(value.updated_at ? { updatedAt: value.updated_at } : {}),
		skus: value.skus.map(
			(sku): SupplierSku => ({
				id: sku.id,
				name: sku.name,
				costMinor: sku.cost_minor,
				stockQuantity: sku.stock_quantity,
				active: sku.active,
			}),
		),
	};
}
