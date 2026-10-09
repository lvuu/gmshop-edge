import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getAdminRuntimeServerContext } from "#/server/context";
import {
	type SupplierProvider,
	supplierAccountEnabledSchema,
	supplierAccountIdSchema,
	supplierAccountInputSchema,
	supplierAccountListSchema,
	supplierSyncNowSchema,
	supplierSyncSettingsSchema,
} from "../schema";
import {
	createSupplierCredentialVault,
	rotateSupplierCredentialVault,
	supplierCredentialFingerprint,
} from "../secrets";
import { adapterForSupplierAccount } from "./account-runtime";
import { normalizeSupplierSource, sameSupplierSource } from "./source-url";
import {
	loadSupplierSyncSettings,
	supplierSyncSettingKeys,
	syncAllSupplierCatalogs,
} from "./sync-settings";

const MAX_ENABLED_ACCOUNTS_PER_SOURCE = 20;

type SupplierAccountRow = {
	id: string;
	provider: SupplierProvider;
	base_url: string;
	normalized_api_origin: string;
	protocol_version: string;
	currency: string;
	currency_decimals: number;
	name: string;
	credentials_encrypted: string;
	credentials_revision: number;
	credential_fingerprint: string;
	balance_minor: string | null;
	balance_synced_at: number | null;
	reserve_balance_minor: string;
	low_balance_minor: string;
	max_order_cost_minor: string | null;
	health_status: "unknown" | "healthy" | "degraded" | "unavailable";
	consecutive_failures: number;
	cooldown_until: number | null;
	last_selected_at: number | null;
	last_error_code: string | null;
	last_error_at: number | null;
	enabled: number;
	created_at: number;
	updated_at: number;
};

export const listSupplierAccountsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof supplierAccountListSchema>) =>
		supplierAccountListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "read"),
		);
		const search = data.search ? `%${data.search}%` : null;
		const where = search
			? "WHERE name LIKE ? OR normalized_api_origin LIKE ? OR provider LIKE ?"
			: "";
		const bindings = search ? [search, search, search] : [];
		const orderBy =
			data.enabledSort === "asc"
				? "enabled ASC, provider, normalized_api_origin, name, id"
				: data.enabledSort === "desc"
					? "enabled DESC, provider, normalized_api_origin, name, id"
					: "provider, normalized_api_origin, name, id";
		const [count, rows] = await db.batch([
			db
				.prepare(`SELECT COUNT(*) AS total FROM supplier_accounts ${where}`)
				.bind(...bindings),
			db
				.prepare(
					`SELECT * FROM supplier_accounts ${where}
					 ORDER BY ${orderBy}
					 LIMIT ? OFFSET ?`,
				)
				.bind(...bindings, data.pageSize, data.pageIndex * data.pageSize),
		]);
		return {
			data: ((rows?.results ?? []) as SupplierAccountRow[]).map(presentAccount),
			total: Number(
				(count?.results[0] as { total?: unknown } | undefined)?.total ?? 0,
			),
		};
	});

export const saveSupplierAccountFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierAccountInputSchema>) =>
		supplierAccountInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", data.id ? "update" : "create"),
		);
		if (!context.runtime.commerceSecret)
			throw new DomainError(
				"supplier_configuration_unavailable",
				503,
				"Supplier configuration unavailable",
			);
		const source = normalizeSupplierSource(data.provider, data.baseUrl);
		const before = data.id ? await findAccount(context.db, data.id) : null;
		if (data.id && !before)
			throw new DomainError(
				"supplier_account_not_found",
				404,
				"Supplier account not found",
			);
		if (
			before &&
			!sameSupplierSource(source, {
				provider: before.provider,
				normalizedApiOrigin: before.normalized_api_origin,
				protocolVersion: before.protocol_version,
			})
		)
			throw new DomainError(
				"supplier_source_immutable",
				409,
				"Supplier source cannot be changed",
			);
		if (!before && data.credentials === undefined)
			throw new DomainError(
				"supplier_credentials_required",
				400,
				"Supplier credentials are required",
			);
		const sourceCurrency = await context.db
			.prepare(
				`SELECT currency, currency_decimals FROM supplier_accounts
				 WHERE provider = ? AND normalized_api_origin = ?
				  AND protocol_version = ? AND id <> ?
				 ORDER BY created_at, id LIMIT 1`,
			)
			.bind(
				source.provider,
				source.normalizedApiOrigin,
				source.protocolVersion,
				data.id ?? "",
			)
			.first<{ currency: string; currency_decimals: number }>();
		if (
			sourceCurrency &&
			(sourceCurrency.currency !== data.currency ||
				sourceCurrency.currency_decimals !== data.currencyDecimals)
		)
			throw new DomainError(
				"supplier_source_currency_mismatch",
				409,
				"All accounts in a supplier source must use the same currency",
			);

		const credential = await prepareCredential(
			data,
			before,
			context.runtime.commerceSecret,
		);
		if (data.enabled && !before?.enabled)
			await assertEnabledAccountCapacity(context.db, source);

		const id = data.id ?? crypto.randomUUID();
		const now = Date.now();
		const testRow: SupplierAccountRow = {
			...(before ?? emptyAccountRow(id, now)),
			id,
			provider: source.provider,
			base_url: source.baseUrl,
			normalized_api_origin: source.normalizedApiOrigin,
			protocol_version: source.protocolVersion,
			currency: data.currency,
			currency_decimals: data.currencyDecimals,
			credentials_encrypted: credential.encrypted,
			credentials_revision: credential.revision,
		};
		let connection: Awaited<
			ReturnType<
				Awaited<ReturnType<typeof adapterForSupplierAccount>>["testConnection"]
			>
		> | null = null;
		if (!before || data.credentials !== undefined) {
			const adapter = await adapterForSupplierAccount(testRow, context.runtime);
			connection = await adapter.testConnection();
			if (source.provider !== "dhru")
				await adapter.listProducts({ page: 1, pageSize: 1 });
		}

		const statement = before
			? context.db
					.prepare(
						`UPDATE supplier_accounts SET name = ?, currency = ?,
						 currency_decimals = ?, credentials_encrypted = ?,
						 credentials_revision = ?, credential_fingerprint = ?,
						 reserve_balance_minor = ?, low_balance_minor = ?,
						 max_order_cost_minor = ?, balance_minor = COALESCE(?, balance_minor),
						 balance_synced_at = CASE WHEN ? IS NULL THEN balance_synced_at ELSE ? END,
						 health_status = CASE WHEN ? IS NULL THEN health_status ELSE 'healthy' END,
						 consecutive_failures = CASE WHEN ? IS NULL THEN consecutive_failures ELSE 0 END,
						 cooldown_until = CASE WHEN ? IS NULL THEN cooldown_until ELSE NULL END,
						 last_error_code = CASE WHEN ? IS NULL THEN last_error_code ELSE NULL END,
						 enabled = ?, updated_at = ? WHERE id = ?`,
					)
					.bind(
						data.name,
						data.currency,
						data.currencyDecimals,
						credential.encrypted,
						credential.revision,
						credential.fingerprint,
						data.reserveBalanceMinor,
						data.lowBalanceMinor,
						data.maxOrderCostMinor,
						connection?.balance.amountMinor ?? null,
						connection ? 1 : null,
						now,
						connection ? 1 : null,
						connection ? 1 : null,
						connection ? 1 : null,
						connection ? 1 : null,
						data.enabled ? 1 : 0,
						now,
						id,
					)
			: context.db
					.prepare(
						`INSERT INTO supplier_accounts
						 (id, provider, base_url, normalized_api_origin, protocol_version,
						  currency, currency_decimals, name, credentials_encrypted,
						  credentials_revision, credential_fingerprint, balance_minor,
						  balance_synced_at, reserve_balance_minor, low_balance_minor,
						  max_order_cost_minor, health_status, enabled, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', ?, ?, ?)`,
					)
					.bind(
						id,
						source.provider,
						source.baseUrl,
						source.normalizedApiOrigin,
						source.protocolVersion,
						data.currency,
						data.currencyDecimals,
						data.name,
						credential.encrypted,
						credential.revision,
						credential.fingerprint,
						connection?.balance.amountMinor ?? null,
						now,
						data.reserveBalanceMinor,
						data.lowBalanceMinor,
						data.maxOrderCostMinor,
						data.enabled ? 1 : 0,
						now,
						now,
					);
		try {
			await context.db.batch([
				statement,
				createAuditStatement(
					context.db,
					context.request,
					context.currentUser.id,
					{
						action: before
							? "supplier_account.updated"
							: "supplier_account.created",
						targetType: "supplier_account",
						targetId: id,
						before: before ? presentAccount(before) : null,
						after: {
							provider: source.provider,
							normalizedApiOrigin: source.normalizedApiOrigin,
							name: data.name,
							currency: data.currency,
							credentialsRevision: credential.revision,
							enabled: data.enabled,
						},
					},
				),
			]);
		} catch {
			throw new DomainError(
				"supplier_account_conflict",
				409,
				"Supplier account conflicts with an existing account",
			);
		}
		return { id };
	});

export const testSupplierAccountFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierAccountIdSchema>) =>
		supplierAccountIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "test"),
		);
		const account = await requireAccount(context.db, data.id);
		const now = Date.now();
		try {
			const adapter = await adapterForSupplierAccount(account, context.runtime);
			const connection = await adapter.testConnection();
			await context.db.batch([
				context.db
					.prepare(
						`UPDATE supplier_accounts SET balance_minor = ?,
						 balance_synced_at = ?, health_status = 'healthy',
						 consecutive_failures = 0, cooldown_until = NULL,
						 last_error_code = NULL, updated_at = ? WHERE id = ?`,
					)
					.bind(connection.balance.amountMinor, now, now, data.id),
				createAuditStatement(
					context.db,
					context.request,
					context.currentUser.id,
					{
						action: "supplier_account.tested",
						targetType: "supplier_account",
						targetId: data.id,
						after: { healthy: true },
					},
				),
			]);
			return {
				siteName: connection.siteName,
				balanceMinor: connection.balance.amountMinor,
				currency: connection.balance.currency,
			};
		} catch {
			await context.db
				.prepare(
					`UPDATE supplier_accounts SET health_status = 'unavailable',
					 consecutive_failures = consecutive_failures + 1,
					 last_error_code = 'connection_failed', last_error_at = ?,
					 updated_at = ? WHERE id = ?`,
				)
				.bind(now, now, data.id)
				.run();
			throw new DomainError(
				"supplier_connection_failed",
				502,
				"Supplier connection test failed",
			);
		}
	});

export const getSupplierSyncSettingsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminRuntimeServerContext(
		systemPermission("suppliers", "read"),
	);
	return loadSupplierSyncSettings(db);
});

export const saveSupplierSyncSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierSyncSettingsSchema>) =>
		supplierSyncSettingsSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "update"),
		);
		const before = await loadSupplierSyncSettings(context.db);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					`INSERT INTO system_settings
					 (key, value, is_secret, updated_by, created_at, updated_at)
					 VALUES (?, ?, 0, ?, ?, ?)
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
					 is_secret = 0, updated_by = excluded.updated_by,
					 updated_at = excluded.updated_at`,
				)
				.bind(
					supplierSyncSettingKeys.config,
					JSON.stringify(data),
					context.currentUser.id,
					now,
					now,
				),
			createAuditStatement(
				context.db,
				context.request,
				context.currentUser.id,
				{
					action: "supplier_sync.settings_updated",
					targetType: "supplier_sync",
					targetId: "catalogs",
					before: {
						enabled: before.enabled,
						intervalMs: before.intervalMs,
					},
					after: data,
				},
			),
		]);
		return loadSupplierSyncSettings(context.db);
	});

export const syncAllSupplierSourcesFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierSyncNowSchema>) =>
		supplierSyncNowSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "test"),
		);
		const result = await syncAllSupplierCatalogs({
			db: context.db,
			cache: context.env.CACHE,
			runtime: context.runtime,
			trigger: "manual",
			full: data.full,
		});
		await createAuditStatement(
			context.db,
			context.request,
			context.currentUser.id,
			{
				action: "supplier_catalogs.synchronized",
				targetType: "supplier_sync",
				targetId: "catalogs",
				after: result,
			},
		).run();
		return result;
	});

export const setSupplierAccountEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierAccountEnabledSchema>) =>
		supplierAccountEnabledSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "update"),
		);
		const account = await requireAccount(context.db, data.id);
		if (data.enabled && !account.enabled)
			await assertEnabledAccountCapacity(context.db, {
				provider: account.provider,
				baseUrl: account.base_url,
				normalizedApiOrigin: account.normalized_api_origin,
				protocolVersion: account.protocol_version,
			});
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					"UPDATE supplier_accounts SET enabled = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.enabled ? 1 : 0, now, data.id),
			createAuditStatement(
				context.db,
				context.request,
				context.currentUser.id,
				{
					action: data.enabled
						? "supplier_account.enabled"
						: "supplier_account.disabled",
					targetType: "supplier_account",
					targetId: data.id,
					before: { enabled: Boolean(account.enabled) },
					after: { enabled: data.enabled },
				},
			),
		]);
		return { id: data.id };
	});

export const deleteSupplierAccountFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierAccountIdSchema>) =>
		supplierAccountIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("suppliers", "delete"),
		);
		const account = await requireAccount(context.db, data.id);
		const order = await context.db
			.prepare(
				"SELECT id FROM supplier_orders WHERE selected_account_id = ? LIMIT 1",
			)
			.bind(data.id)
			.first();
		if (order)
			throw new DomainError(
				"supplier_account_in_use",
				409,
				"Accounts with supplier order history cannot be deleted",
			);
		await context.db.batch([
			context.db
				.prepare("DELETE FROM supplier_accounts WHERE id = ?")
				.bind(data.id),
			createAuditStatement(
				context.db,
				context.request,
				context.currentUser.id,
				{
					action: "supplier_account.deleted",
					targetType: "supplier_account",
					targetId: data.id,
					before: presentAccount(account),
				},
			),
		]);
		return { id: data.id };
	});

async function prepareCredential(
	data: z.output<typeof supplierAccountInputSchema>,
	before: SupplierAccountRow | null,
	commerceSecret: string,
) {
	if (data.credentials === undefined && before)
		return {
			encrypted: before.credentials_encrypted,
			revision: before.credentials_revision,
			fingerprint: before.credential_fingerprint,
		};
	const fingerprint = await supplierCredentialFingerprint(
		data.provider,
		data.credentials,
		commerceSecret,
	);
	if (!before)
		return {
			encrypted: await createSupplierCredentialVault(
				data.provider,
				data.credentials,
				commerceSecret,
			),
			revision: 1,
			fingerprint,
		};
	const rotated = await rotateSupplierCredentialVault(
		before.credentials_encrypted,
		data.provider,
		data.credentials,
		commerceSecret,
	);
	return { ...rotated, fingerprint };
}

async function assertEnabledAccountCapacity(
	db: D1Database,
	source: ReturnType<typeof normalizeSupplierSource>,
) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total FROM supplier_accounts
			 WHERE provider = ? AND normalized_api_origin = ?
			 AND protocol_version = ? AND enabled = 1`,
		)
		.bind(source.provider, source.normalizedApiOrigin, source.protocolVersion)
		.first<{ total: number }>();
	if (Number(row?.total ?? 0) >= MAX_ENABLED_ACCOUNTS_PER_SOURCE)
		throw new DomainError(
			"supplier_account_pool_limit",
			409,
			"A supplier source supports at most 20 enabled accounts",
		);
}

async function findAccount(db: D1Database, id: string) {
	return db
		.prepare("SELECT * FROM supplier_accounts WHERE id = ? LIMIT 1")
		.bind(id)
		.first<SupplierAccountRow>();
}

async function requireAccount(db: D1Database, id: string) {
	const account = await findAccount(db, id);
	if (!account)
		throw new DomainError(
			"supplier_account_not_found",
			404,
			"Supplier account not found",
		);
	return account;
}

function emptyAccountRow(id: string, now: number): SupplierAccountRow {
	return {
		id,
		provider: "acg",
		base_url: "",
		normalized_api_origin: "",
		protocol_version: "",
		currency: "CNY",
		currency_decimals: 2,
		name: "",
		credentials_encrypted: "",
		credentials_revision: 1,
		credential_fingerprint: "",
		balance_minor: null,
		balance_synced_at: null,
		reserve_balance_minor: "0",
		low_balance_minor: "0",
		max_order_cost_minor: null,
		health_status: "unknown",
		consecutive_failures: 0,
		cooldown_until: null,
		last_selected_at: null,
		last_error_code: null,
		last_error_at: null,
		enabled: 0,
		created_at: now,
		updated_at: now,
	};
}

function presentAccount(row: SupplierAccountRow) {
	return {
		id: row.id,
		provider: row.provider,
		baseUrl: row.base_url,
		normalizedApiOrigin: row.normalized_api_origin,
		protocolVersion: row.protocol_version,
		currency: row.currency,
		currencyDecimals: row.currency_decimals,
		name: row.name,
		credentialsRevision: row.credentials_revision,
		hasCredentials: Boolean(row.credentials_encrypted),
		balanceMinor: row.balance_minor,
		balanceSyncedAt: row.balance_synced_at,
		reserveBalanceMinor: row.reserve_balance_minor,
		lowBalanceMinor: row.low_balance_minor,
		maxOrderCostMinor: row.max_order_cost_minor,
		healthStatus: row.health_status,
		consecutiveFailures: row.consecutive_failures,
		cooldownUntil: row.cooldown_until,
		lastSelectedAt: row.last_selected_at,
		lastErrorCode: row.last_error_code,
		lastErrorAt: row.last_error_at,
		enabled: Boolean(row.enabled),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
