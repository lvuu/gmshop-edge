import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import {
	fetchOutbound,
	type OutboundFetchOptions,
} from "#/server/outbound-fetch";

const orderUuid = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9-]+$/);
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const account = z
	.object({
		currency: z.string().min(1),
		balance: decimal,
		name: z.string(),
		email: z.string(),
	})
	.passthrough();
const product = z
	.object({
		name: z.string(),
		type: z.string(),
		price: decimal,
		fields: z.array(
			z
				.object({
					name: z.string().min(1),
					type: z.string(),
					required: z.boolean().optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();
const catalog = z
	.object({
		currency: z.string().min(1),
		categories: z.record(
			z.string(),
			z.object({ name: z.string(), type: z.string() }).passthrough(),
		),
		products: z.record(z.string(), product),
	})
	.passthrough();
const order = z
	.object({
		order_uuid: orderUuid.optional(),
		quantity: z.number().int().positive(),
		replay: z.string(),
		status: z.enum([
			"new",
			"pre-checking",
			"accepted",
			"in-process",
			"pending",
			"verify",
			"success",
			"rejected",
		]),
		date: z.string().optional(),
		date_completed: z.string().nullable().optional(),
	})
	.passthrough();
const submitted = z
	.array(
		z
			.array(
				z
					.object({
						order_uuid: orderUuid,
						reference_id: z.string().min(1),
						amount: z.union([decimal, z.number().finite().nonnegative()]),
						currency_code: z.string().min(1),
						note: z.string().optional(),
					})
					.passthrough(),
			)
			.min(1),
	)
	.min(1);
const envelope = z
	.object({
		status: z.enum(["success", "error"]),
		code: z.number().int(),
		data: z.unknown().optional(),
	})
	.passthrough();
const identifier = z.union([
	z.number().int().positive(),
	z
		.string()
		.regex(
			/^(?:[1-9]\d*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
		),
]);
const orderInput = z.object({
	productId: identifier,
	fields: z.record(z.string(), z.unknown()),
	referenceId: z.string().regex(/^[A-Za-z0-9-]{1,50}$/),
	feedbackUrl: z.url().refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	}),
	quantity: z.number().int().positive().optional(),
});

export type DhruAccount = z.infer<typeof account>;
export type DhruCatalog = z.infer<typeof catalog>;
export type DhruProduct = z.infer<typeof product>;
export type DhruOrder = z.infer<typeof order>;
export type DhruSubmitInput = z.input<typeof orderInput>;

/** Never exposes upstream bodies, credentials or customer fields in errors. */
export class DhruClientError extends DomainError {
	constructor(
		readonly outcome: "rejected" | "uncertain" | "read_failed",
		readonly httpStatus?: number,
		readonly apiCode?: number,
		readonly retryAfter?: string,
	) {
		super(
			`dhru_${outcome}`,
			502,
			outcome === "uncertain"
				? "Dhru order outcome is uncertain; reconcile before resubmitting"
				: "Dhru request failed",
			{ retryable: false },
		);
	}
}

/** Server-only client. Construct with decrypted credentials inside supplier runtime. */
export class DhruClient {
	private readonly baseUrl: string;
	private readonly token: string;
	constructor(
		baseUrl: string,
		token: string,
		private readonly transport: OutboundFetchOptions = {},
	) {
		const url = new URL(baseUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash ||
			url.pathname.replace(/\/$/, "") !== "/api/reseller/v1" ||
			!token.trim() ||
			/[\r\n]/.test(token)
		) {
			throw new DomainError(
				"invalid_dhru_configuration",
				400,
				"Invalid Dhru client configuration",
			);
		}
		this.baseUrl = url.toString().replace(/\/$/, "");
		this.token = token;
	}

	getAccount(): Promise<DhruAccount> {
		return this.request("/account", account);
	}
	listProducts(): Promise<DhruCatalog> {
		return this.request("/products", catalog);
	}
	/** Returns the complete product endpoint data, preserving IDs and vendor extensions. */
	async getProduct(productId: string | number) {
		const id = identifier.parse(productId);
		const result = await this.request(
			`/products?product_id=${encodeURIComponent(String(id))}`,
			z.record(z.string(), z.unknown()),
		);
		const key = /^\d+$/.test(String(id)) ? "product_id" : "product_uuid";
		if (key in result) {
			const echoed = identifier.safeParse(result[key]);
			if (
				!echoed.success ||
				String(echoed.data).toLowerCase() !== String(id).toLowerCase()
			)
				throw new DhruClientError("read_failed");
		}
		return result;
	}
	async getOrder(uuid: string): Promise<DhruOrder> {
		const id = orderUuid.parse(uuid);
		const result = await this.request(
			`/order?order_uuid=${encodeURIComponent(id)}`,
			order,
		);
		// The documented single-order response omits this ID. Check it when echoed.
		if (result.order_uuid !== undefined && result.order_uuid !== id)
			throw new DhruClientError("read_failed");
		return result;
	}
	async submitOrder(input: DhruSubmitInput) {
		const value = orderInput.parse(input);
		const fields = {
			...value.fields,
			reference_id: value.referenceId,
			feedback_url: value.feedbackUrl,
			Quantity: value.quantity ?? 1,
		};
		const payload = JSON.stringify([
			{ product_id: value.productId, fields: [fields] },
		]);
		const result = await this.request("/order", submitted, payload);
		const group = result[0];
		const item = group?.[0];
		if (
			result.length !== 1 ||
			group?.length !== 1 ||
			!item ||
			item.reference_id !== value.referenceId
		)
			throw new DhruClientError("uncertain");
		return item;
	}

	private async request<T>(
		path: string,
		schema: z.ZodType<T>,
		payload?: string,
	): Promise<T> {
		const writing = payload !== undefined;
		let response: Response;
		try {
			response = await fetchOutbound(
				this.baseUrl + path,
				{
					method: writing ? "POST" : "GET",
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/json",
						...(writing ? { "Content-Type": "application/json" } : {}),
					},
					body: payload,
				},
				{
					...this.transport,
					timeoutMs: writing ? 300_000 : 30_000,
					maxResponseBytes: 4 * 1024 * 1024,
				},
			);
		} catch (error) {
			// Destination validation fails before any request is sent.
			if (
				error instanceof DomainError &&
				["outbound_destination_rejected", "outbound_dns_unavailable"].includes(
					error.code,
				)
			)
				throw error;
			throw new DhruClientError(writing ? "uncertain" : "read_failed");
		}
		const status = response.status;
		const retryAfter = response.headers.get("Retry-After") ?? undefined;
		let body: z.infer<typeof envelope>;
		try {
			body = envelope.parse(await response.json());
		} catch {
			throw new DhruClientError(
				writing ? "uncertain" : "read_failed",
				status,
				undefined,
				retryAfter,
			);
		}
		if (
			!response.ok ||
			body.status !== "success" ||
			body.code < 200 ||
			body.code >= 300
		) {
			const uncertain =
				status >= 500 ||
				body.code >= 500 ||
				(response.ok && body.status === "success");
			throw new DhruClientError(
				writing ? (uncertain ? "uncertain" : "rejected") : "read_failed",
				status,
				body.code,
				retryAfter,
			);
		}
		const parsed = schema.safeParse(body.data);
		if (!parsed.success)
			throw new DhruClientError(
				writing ? "uncertain" : "read_failed",
				status,
				body.code,
			);
		return parsed.data;
	}
}
