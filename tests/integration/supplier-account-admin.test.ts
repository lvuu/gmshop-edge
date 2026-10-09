import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemPermission } from "#/features/access/system-rbac";
import { readSupplierCredentials } from "#/features/suppliers/secrets";
import {
	saveSupplierAccountFn,
	setSupplierAccountEnabledFn,
} from "#/features/suppliers/server/admin";
import { DomainError } from "#/lib/domain-error";
import { getAdminRuntimeServerContext } from "#/server/context";
import { fetchOutbound } from "#/server/outbound-fetch";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

vi.mock("#/server/context", () => ({ getAdminRuntimeServerContext: vi.fn() }));
vi.mock("#/server/outbound-fetch", () => ({ fetchOutbound: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate = (input: unknown): unknown => input;
		return {
			validator(parser: typeof validate) {
				validate = parser;
				return this;
			},
			handler:
				(handler: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					handler({ data: validate(input.data) }),
		};
	},
}));

describe("supplier account administration with real D1 and Dhru adapter", () => {
	let mf: Miniflare, db: D1Database;
	const runtime = createInitialRuntimeConfig("https://shop.example");
	const input = {
		provider: "dhru" as const,
		baseUrl: "https://supplier.example",
		name: "Dhru test",
		currency: "USD",
		currencyDecimals: 2,
		reserveBalanceMinor: "0",
		lowBalanceMinor: "100",
		maxOrderCostMinor: "150",
		enabled: true,
		credentials: { apiToken: "fixture-token-one" },
	};
	const account = (id: string) =>
		db.prepare("SELECT * FROM supplier_accounts WHERE id = ?").bind(id).first<{
			credentials_encrypted: string;
			credentials_revision: number;
			balance_minor: string;
			balance_synced_at: number;
			enabled: number;
			health_status: string;
			consecutive_failures: number;
			cooldown_until: number | null;
			last_error_code: string | null;
			name: string;
		}>();
	const audits = () => db.prepare("SELECT * FROM audit_logs").all();
	const respond = (balance = "100.00") =>
		vi.mocked(fetchOutbound).mockResolvedValue(
			Response.json({
				status: "success",
				code: 200,
				data: {
					currency: "USD",
					balance,
					name: "Fixture",
					email: "supplier@example.com",
				},
			}),
		);
	beforeEach(async () => {
		vi.resetAllMocks();
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO users (id, name, email) VALUES ('admin-fixture', 'Admin', 'admin@example.com')",
			)
			.run();
		vi.mocked(getAdminRuntimeServerContext).mockResolvedValue({
			db,
			runtime,
			currentUser: { id: "admin-fixture" },
			request: new Request("https://shop.example/_serverFn/account"),
		} as Awaited<ReturnType<typeof getAdminRuntimeServerContext>>);
		respond();
	});
	afterEach(async () => {
		await mf.dispose();
	});

	it("creates and encrypts an enabled Dhru account using only account GET", async () => {
		const { id } = await saveSupplierAccountFn({ data: input });
		const row = await account(id);
		expect(row).toMatchObject({
			enabled: 1,
			balance_minor: "10000",
			credentials_revision: 1,
			health_status: "healthy",
		});
		expect(row?.credentials_encrypted).not.toContain(
			input.credentials.apiToken,
		);
		expect(
			await readSupplierCredentials(
				row?.credentials_encrypted ?? "",
				1,
				"dhru",
				runtime.commerceSecret,
			),
		).toEqual(input.credentials);
		expect(fetchOutbound).toHaveBeenCalledTimes(1);
		const [url, init] = vi.mocked(fetchOutbound).mock.calls[0] ?? [];
		expect(new URL(String(url)).pathname).toBe("/api/reseller/v1/account");
		expect(init?.method).toBe("GET");
		expect(getAdminRuntimeServerContext).toHaveBeenCalledWith(
			systemPermission("suppliers", "create"),
		);
		const audit = await audits();
		expect(audit.results).toHaveLength(1);
		expect(JSON.stringify(audit)).not.toContain(input.credentials.apiToken);
	});

	it("rotates credentials and resets health while preserving the previous revision", async () => {
		const { id } = await saveSupplierAccountFn({ data: input });
		await db
			.prepare(
				"UPDATE supplier_accounts SET health_status = 'unavailable', consecutive_failures = 3, cooldown_until = 123, last_error_code = 'connection_failed' WHERE id = ?",
			)
			.bind(id)
			.run();
		respond("12.34");
		await saveSupplierAccountFn({
			data: { ...input, id, credentials: { apiToken: "fixture-token-two" } },
		});
		const row = await account(id);
		expect(row).toMatchObject({
			credentials_revision: 2,
			balance_minor: "1234",
			health_status: "healthy",
			consecutive_failures: 0,
			cooldown_until: null,
			last_error_code: null,
			enabled: 1,
		});
		expect(
			await readSupplierCredentials(
				row?.credentials_encrypted ?? "",
				1,
				"dhru",
				runtime.commerceSecret,
			),
		).toEqual(input.credentials);
		expect(
			await readSupplierCredentials(
				row?.credentials_encrypted ?? "",
				2,
				"dhru",
				runtime.commerceSecret,
			),
		).toEqual({ apiToken: "fixture-token-two" });
		expect(fetchOutbound).toHaveBeenCalledTimes(2);
		expect(getAdminRuntimeServerContext).toHaveBeenLastCalledWith(
			systemPermission("suppliers", "update"),
		);
		expect(JSON.stringify(await audits())).not.toContain("fixture-token");
	});

	it("edits without a token while preserving credentials, balance and health", async () => {
		const { id } = await saveSupplierAccountFn({ data: input });
		await db
			.prepare(
				"UPDATE supplier_accounts SET health_status = 'degraded', consecutive_failures = 2, cooldown_until = 123, last_error_code = 'connection_failed' WHERE id = ?",
			)
			.bind(id)
			.run();
		const before = await account(id);
		vi.mocked(fetchOutbound).mockClear();
		await saveSupplierAccountFn({
			data: {
				...input,
				id,
				name: "Edited",
				enabled: false,
				credentials: undefined,
			},
		});
		expect(await account(id)).toMatchObject({
			credentials_encrypted: before?.credentials_encrypted,
			credentials_revision: before?.credentials_revision,
			balance_minor: before?.balance_minor,
			balance_synced_at: before?.balance_synced_at,
			health_status: before?.health_status,
			consecutive_failures: before?.consecutive_failures,
			cooldown_until: before?.cooldown_until,
			last_error_code: before?.last_error_code,
			name: "Edited",
			enabled: 0,
		});
		expect(fetchOutbound).not.toHaveBeenCalled();
	});

	it("toggles persisted numeric enabled state with update permission", async () => {
		const { id } = await saveSupplierAccountFn({ data: input });
		for (const enabled of [false, true]) {
			await setSupplierAccountEnabledFn({ data: { id, enabled } });
			expect((await account(id))?.enabled).toBe(enabled ? 1 : 0);
			expect(getAdminRuntimeServerContext).toHaveBeenLastCalledWith(
				systemPermission("suppliers", "update"),
			);
		}
		expect(fetchOutbound).toHaveBeenCalledTimes(1);
	});

	it("rejects wallet currency mismatch before saving any account or audit", async () => {
		await expect(
			saveSupplierAccountFn({ data: { ...input, currency: "CNY" } }),
		).rejects.toMatchObject({ code: "supplier_currency_mismatch" });
		expect(
			(await db.prepare("SELECT * FROM supplier_accounts").all()).results,
		).toHaveLength(0);
		expect((await audits()).results).toHaveLength(0);
	});

	it("rejects an API path before sending credentials", async () => {
		await expect(
			saveSupplierAccountFn({
				data: { ...input, baseUrl: `${input.baseUrl}/api/reseller/v1` },
			}),
		).rejects.toMatchObject({ code: "invalid_supplier_source_url" });
		expect(fetchOutbound).not.toHaveBeenCalled();
		expect(
			(await db.prepare("SELECT * FROM supplier_accounts").all()).results,
		).toHaveLength(0);
	});

	it("rolls back duplicate credentials without writing a second audit", async () => {
		await saveSupplierAccountFn({ data: input });
		respond();
		await expect(
			saveSupplierAccountFn({ data: { ...input, name: "Duplicate" } }),
		).rejects.toMatchObject({ code: "supplier_account_conflict" });
		expect(
			(await db.prepare("SELECT * FROM supplier_accounts").all()).results,
		).toHaveLength(1);
		expect((await audits()).results).toHaveLength(1);
	});

	it("rejects denied permission before making supplier requests", async () => {
		vi.mocked(getAdminRuntimeServerContext).mockRejectedValue(
			new DomainError("forbidden", 403, "Forbidden"),
		);
		await expect(saveSupplierAccountFn({ data: input })).rejects.toMatchObject({
			code: "forbidden",
		});
		expect(fetchOutbound).not.toHaveBeenCalled();
		expect((await audits()).results).toHaveLength(0);
	});

	it("redacts supplier authentication errors and writes nothing", async () => {
		vi.mocked(fetchOutbound).mockResolvedValue(
			Response.json({ message: "private upstream token" }, { status: 401 }),
		);
		await expect(saveSupplierAccountFn({ data: input })).rejects.toMatchObject({
			code: "dhru_read_failed",
			message: "Dhru request failed",
		});
		expect(
			(await db.prepare("SELECT * FROM supplier_accounts").all()).results,
		).toHaveLength(0);
		expect((await audits()).results).toHaveLength(0);
	});
});
