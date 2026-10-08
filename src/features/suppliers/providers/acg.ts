import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "../money";
import type { SupplierPurchaseResult } from "../schema";
import { supplierFetchJson } from "./http";
import { signAcgForm } from "./signatures";
import type { SupplierAdapter, SupplierProduct, SupplierSku } from "./types";

const skuSchema = z.object({
	id: z.union([z.string(), z.number()]),
	name: z.string().max(512),
	stock_price: z.union([z.string(), z.number()]),
	stock: z.union([z.string(), z.number()]).nullable(),
});

const productSchema = z.object({
	id: z.union([z.string(), z.number()]),
	name: z.string().max(512),
	introduce: z.string().max(640_000).default(""),
	picture_url: z.string().max(2048).default(""),
	category: z.object({ name: z.string().max(512) }),
	sku: z.array(skuSchema).min(1).max(10_000),
});

export class AcgAdapter implements SupplierAdapter {
	constructor(
		private readonly input: {
			baseUrl: string;
			apiId: string;
			appKey: string;
			currency: string;
			currencyDecimals: number;
			fetcher?: typeof fetch;
		},
	) {}

	async testConnection() {
		const data = z
			.object({
				username: z.string(),
				balance: z.union([z.string(), z.number()]),
			})
			.parse(await this.request("/plugin/open-api/connect"));
		return {
			siteName: data.username,
			balance: {
				amountMinor: decimalToMinor(
					String(data.balance),
					this.input.currencyDecimals,
				),
				currency: this.input.currency,
			},
		};
	}

	async listProducts(input: { page: number; pageSize: number }) {
		const values = z
			.array(productSchema)
			.max(10_000)
			.parse(await this.request("/plugin/open-api/items"));
		const start = Math.max(0, (input.page - 1) * input.pageSize);
		return {
			total: values.length,
			products: values
				.slice(start, start + input.pageSize)
				.map((value) => this.product(value)),
		};
	}

	async getSku(productId: string, skuId: string) {
		const product = this.product(
			productSchema.parse(
				await this.request("/plugin/open-api/item", { id: productId }),
			),
		);
		const sku = product.skus.find((value) => value.id === skuId);
		if (!sku)
			throw new DomainError(
				"supplier_sku_not_found",
				404,
				"Supplier SKU was not found",
			);
		const stock = z
			.object({ stock: z.union([z.string(), z.number()]).nullable() })
			.parse(
				await this.request("/plugin/open-api/sku/stock", { sku_id: skuId }),
			);
		return { ...sku, stockQuantity: normalizeStock(stock.stock) };
	}

	async submitOrder(input: {
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		const data = z.object({ contents: z.string().optional() }).parse(
			await this.request("/plugin/open-api/trade", {
				sku_id: input.skuId,
				quantity: String(input.quantity),
				trade_no: input.requestNo,
			}),
		);
		const cards = parseCards(data.contents ?? "");
		return cards.length
			? {
					status: "supplied",
					upstreamOrderId: input.requestNo,
					fulfillment: { type: "stock", cards },
				}
			: { status: "processing", upstreamOrderId: input.requestNo };
	}

	async reconcileOrder(input: {
		upstreamOrderId: string | null;
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		return this.submitOrder(input);
	}

	private product(value: z.infer<typeof productSchema>): SupplierProduct {
		return {
			id: String(value.id),
			name: value.name,
			description: value.introduce,
			imageUrls: value.picture_url ? [value.picture_url] : [],
			categoryNames: [value.category.name],
			active: true,
			skus: value.sku.map(
				(sku): SupplierSku => ({
					id: String(sku.id),
					name: sku.name,
					costMinor: decimalToMinor(
						String(sku.stock_price),
						this.input.currencyDecimals,
					),
					stockQuantity: normalizeStock(sku.stock),
					active: true,
				}),
			),
		};
	}

	private async request(path: string, data: Record<string, string> = {}) {
		const form = new URLSearchParams(data);
		const { status, body } = await supplierFetchJson(
			this.input.fetcher ?? fetch,
			`${this.input.baseUrl}${path}`,
			{
				method: "POST",
				headers: {
					"Api-Id": this.input.apiId,
					"Api-Signature": signAcgForm(data, this.input.appKey),
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: form.toString(),
			},
			{ validateDestination: !this.input.fetcher },
		);
		const envelope = z
			.object({
				code: z.union([z.string(), z.number()]),
				msg: z.string().optional(),
				data: z.unknown().optional(),
			})
			.parse(body);
		if (status !== 200 || Number(envelope.code) !== 200) {
			throw new DomainError(
				"supplier_request_failed",
				502,
				"Supplier request failed",
			);
		}
		return envelope.data;
	}
}

function normalizeStock(value: string | number | null) {
	if (value == null || value === -1 || value === "-1") return 2_147_483_647;
	const parsed = typeof value === "number" ? value : Number(value);
	if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
	throw new DomainError(
		"invalid_supplier_response",
		502,
		"Supplier returned invalid stock",
	);
}

function parseCards(value: string) {
	const cards = value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);
	if (cards.length > 10_000 || cards.some((card) => card.length > 64_000))
		throw new DomainError(
			"invalid_supplier_response",
			502,
			"Supplier returned invalid fulfillment",
		);
	return cards;
}
