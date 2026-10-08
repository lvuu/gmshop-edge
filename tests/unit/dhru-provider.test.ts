import { describe, expect, it, vi } from "vitest";
import { DhruAdapter } from "#/features/suppliers/providers/dhru";
import { createSupplierAdapter } from "#/features/suppliers/providers/factory";
import {
	dhruCredentialsSchema,
	supplierCredentialsSchema,
} from "#/features/suppliers/schema";
import {
	createSupplierCredentialVault,
	readSupplierCredentials,
	rotateSupplierCredentialVault,
	supplierCredentialFingerprint,
} from "#/features/suppliers/secrets";
import { adapterForSupplierAccount } from "#/features/suppliers/server/account-runtime";
import { normalizeSupplierSource } from "#/features/suppliers/server/source-url";
import { createSecretKeyring } from "#/lib/secrets";

const token = { apiToken: "test-bearer-token" };
const source = normalizeSupplierSource("dhru", "https://supplier.example");
function adapter() {
	return createSupplierAdapter({
		provider: "dhru",
		baseUrl: source.baseUrl,
		credentials: token,
		currency: "USD",
		currencyDecimals: 2,
	});
}
describe("Dhru supplier registration", () => {
	it("validates tokens and preserves the source identity", () => {
		expect(source.protocolVersion).toBe("dhru-reseller-v1");
		expect(adapter()).toBeInstanceOf(DhruAdapter);
		expect(
			supplierCredentialsSchema.parse({ provider: "dhru", credentials: token })
				.credentials,
		).toEqual(token);
		expect(
			dhruCredentialsSchema.safeParse({ apiToken: "bad\ntoken" }).success,
		).toBe(false);
		expect(
			dhruCredentialsSchema.safeParse({ apiKey: "not-a-token" }).success,
		).toBe(false);
	});
	it("encrypts and rotates tokens with historical revision reads", async () => {
		const secret = createSecretKeyring();
		const encrypted = await createSupplierCredentialVault(
			"dhru",
			token,
			secret,
		);
		expect(encrypted).not.toContain(token.apiToken);
		const rotated = await rotateSupplierCredentialVault(
			encrypted,
			"dhru",
			{ apiToken: "new-token" },
			secret,
		);
		expect(rotated.revision).toBe(2);
		expect(
			await readSupplierCredentials(rotated.encrypted, 1, "dhru", secret),
		).toEqual(token);
		expect(
			await readSupplierCredentials(rotated.encrypted, 2, "dhru", secret),
		).toEqual({ apiToken: "new-token" });
		await expect(
			readSupplierCredentials(rotated.encrypted, 3, "dhru", secret),
		).rejects.toThrow();
		await expect(
			readSupplierCredentials(encrypted, 1, "acg", secret),
		).rejects.toThrow();
		await expect(
			readSupplierCredentials(encrypted, 1, "dhru", createSecretKeyring()),
		).rejects.toThrow();
	});
	it("fingerprints token revisions without persisting plaintext", async () => {
		const secret = createSecretKeyring();
		const a = await supplierCredentialFingerprint("dhru", token, secret);
		expect(a).toMatch(/^[a-f0-9]{64}$/);
		expect(await supplierCredentialFingerprint("dhru", token, secret)).toBe(a);
		expect(
			await supplierCredentialFingerprint(
				"dhru",
				{ apiToken: "new-token" },
				secret,
			),
		).not.toBe(a);
	});
	it("constructs the provider from encrypted runtime credentials", async () => {
		const commerceSecret = createSecretKeyring();
		const credentials_encrypted = await createSupplierCredentialVault(
			"dhru",
			token,
			commerceSecret,
		);
		expect(
			await adapterForSupplierAccount(
				{
					id: "account-1",
					provider: "dhru",
					base_url: source.baseUrl,
					currency: "USD",
					currency_decimals: 2,
					credentials_encrypted,
					credentials_revision: 1,
				},
				{ commerceSecret },
			),
		).toBeInstanceOf(DhruAdapter);
	});
	it("blocks every stock operation before contacting Dhru", async () => {
		const provider = adapter();
		for (const operation of [
			() => provider.listProducts({ page: 1, pageSize: 10 }),
			() => provider.getSku("123", "123"),
			() =>
				provider.submitOrder({
					skuId: "123",
					quantity: 1,
					requestNo: "r",
					callbackUrl: "https://shop.example",
					traceId: "t",
				}),
			() =>
				provider.reconcileOrder({
					upstreamOrderId: "D1",
					skuId: "123",
					quantity: 1,
					requestNo: "r",
					callbackUrl: "https://shop.example",
					traceId: "t",
				}),
		])
			await expect(operation()).rejects.toMatchObject({
				code: "supplier_service_not_ready",
				retryable: false,
			});
	});
	it.each([
		["450.78000", "USD", "45078"],
		["450.00000", "USD", "45000"],
		["450.78100", "USD", null],
		["450.78000", "EUR", null],
	])(
		"checks account currency and exact balance %s %s",
		async (balance, currency, expected) => {
			const account = vi
				.spyOn(
					(await import("#/features/suppliers/providers/dhru-client"))
						.DhruClient.prototype,
					"getAccount",
				)
				.mockResolvedValue({
					name: "Dhru Reseller",
					email: "r@example.com",
					balance,
					currency,
				});
			try {
				if (expected)
					expect(await adapter().testConnection()).toEqual({
						siteName: "Dhru Reseller",
						balance: { currency, amountMinor: expected },
					});
				else await expect(adapter().testConnection()).rejects.toThrow();
			} finally {
				account.mockRestore();
			}
		},
	);
});
