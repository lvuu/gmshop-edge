import type {
	SupplierPurchaseResult,
	SupplierServiceOrderInput,
} from "../schema";

export type SupplierBalance = {
	amountMinor: string;
	currency: string;
};

export type SupplierSku = {
	id: string;
	name: string;
	costMinor: string;
	stockQuantity: number;
	active: boolean;
};

export type SupplierProduct = {
	id: string;
	name: string;
	description: string;
	imageUrls: string[];
	categoryNames: string[];
	active: boolean;
	updatedAt?: string | null;
	skus: SupplierSku[];
};

export interface SupplierAdapter {
	testConnection(): Promise<{ siteName: string; balance: SupplierBalance }>;
	listProducts(input: {
		page: number;
		pageSize: number;
		updatedAfter?: string;
		includeInactive?: boolean;
	}): Promise<{ products: SupplierProduct[]; total: number }>;
	getServiceDefinition?(productId: string): Promise<{
		name: string;
		costMinor: string;
		definitions: ReturnType<typeof import("./dhru-fields").importDhruFields>;
	}>;
	getServiceQuote?(
		productId: string,
	): Promise<{ name: string; costMinor: string }>;
	getSku(productId: string, skuId: string): Promise<SupplierSku>;
	submitOrder(input: {
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
		service?: SupplierServiceOrderInput;
	}): Promise<SupplierPurchaseResult>;
	reconcileOrder(input: {
		upstreamOrderId: string | null;
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
		service?: SupplierServiceOrderInput;
	}): Promise<SupplierPurchaseResult>;
}
