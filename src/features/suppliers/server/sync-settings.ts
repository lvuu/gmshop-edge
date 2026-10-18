import { z } from "zod";
import type { RuntimeConfig } from "#/server/runtime-config";
import type { SupplierProvider } from "../schema";
import { syncSupplierSource } from "./source-sync";

const DEFAULT_INTERVAL_MS = 10 * 60_000;

export const supplierSyncSettingKeys = {
	config: "suppliers.sync.config",
	status: "suppliers.sync.status",
} as const;

const configSchema = z.object({
	enabled: z.boolean(),
	intervalMs: z
		.number()
		.int()
		.min(DEFAULT_INTERVAL_MS)
		.max(30 * 86_400_000),
});

const statusSchema = z.object({
	lastSyncedAt: z.number().int().nonnegative().nullable(),
	lastStatus: z.enum(["never", "succeeded", "failed"]),
	lastErrorCode: z.string().nullable(),
});

export type SupplierSyncSettings = {
	enabled: boolean;
	intervalMs: number;
	lastSyncedAt: number | null;
	lastStatus: "never" | "succeeded" | "failed";
	lastErrorCode: string | null;
};

type SourceRow = {
	provider: SupplierProvider;
	normalized_api_origin: string;
	protocol_version: string;
};

export async function loadSupplierSyncSettings(
	db: D1Database,
): Promise<SupplierSyncSettings> {
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings
			 WHERE key IN (?, ?)`,
		)
		.bind(supplierSyncSettingKeys.config, supplierSyncSettingKeys.status)
		.all<{ key: string; value: string }>();
	const values = new Map(rows.results.map((row) => [row.key, row.value]));
	const config = parseSetting(
		values.get(supplierSyncSettingKeys.config),
		configSchema,
		{ enabled: true, intervalMs: DEFAULT_INTERVAL_MS },
	);
	const status = parseSetting(
		values.get(supplierSyncSettingKeys.status),
		statusSchema,
		{
			lastSyncedAt: null,
			lastStatus: "never" as const,
			lastErrorCode: null,
		},
	);
	return { ...config, ...status };
}

export async function syncAllSupplierCatalogs(input: {
	db: D1Database;
	cache?: KVNamespace;
	runtime: Pick<RuntimeConfig, "commerceSecret">;
	trigger: "manual" | "scheduled";
	full?: boolean;
	now?: number;
	fetcher?: typeof fetch;
}) {
	const now = input.now ?? Date.now();
	const rows = await input.db
		.prepare(
			`SELECT DISTINCT provider, normalized_api_origin, protocol_version
			 FROM supplier_accounts WHERE enabled = 1
			 ORDER BY provider, normalized_api_origin, protocol_version`,
		)
		.all<SourceRow>();
	let updated = 0;
	let skipped = 0;
	let failed = 0;
	for (const source of rows.results) {
		try {
			const result = await syncSupplierSource({
				db: input.db,
				cache: input.cache,
				runtime: input.runtime,
				source: {
					provider: source.provider,
					normalizedApiOrigin: source.normalized_api_origin,
					protocolVersion: source.protocol_version,
				},
				trigger: input.trigger,
				full: input.full,
				now,
				fetcher: input.fetcher,
			});
			if (result.skipped) skipped += 1;
			else updated += 1;
		} catch {
			failed += 1;
		}
	}
	const lastStatus =
		failed > 0 && updated === 0 && skipped === 0 ? "failed" : "succeeded";
	await saveSyncStatus(input.db, {
		lastSyncedAt: now,
		lastStatus,
		lastErrorCode:
			lastStatus === "failed" ? "supplier_catalog_sync_failed" : null,
	});
	return { updated, skipped, failed, sourceCount: rows.results.length };
}

export async function syncSupplierCatalogsIfDue(input: {
	db: D1Database;
	cache?: KVNamespace;
	runtime: Pick<RuntimeConfig, "commerceSecret">;
	now?: number;
	fetcher?: typeof fetch;
}) {
	const now = input.now ?? Date.now();
	const settings = await loadSupplierSyncSettings(input.db);
	if (
		!settings.enabled ||
		(settings.lastSyncedAt !== null &&
			settings.lastSyncedAt > now - settings.intervalMs)
	)
		return { updated: 0, skipped: 0, failed: 0, sourceCount: 0 };
	return syncAllSupplierCatalogs({
		...input,
		trigger: "scheduled",
		now,
	});
}

function parseSetting<T>(
	raw: string | undefined,
	schema: z.ZodType<T>,
	fallback: T,
) {
	if (!raw) return fallback;
	try {
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : fallback;
	} catch {
		return fallback;
	}
}

async function saveSyncStatus(
	db: D1Database,
	status: z.infer<typeof statusSchema>,
) {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 is_secret = 0, updated_at = excluded.updated_at`,
		)
		.bind(
			supplierSyncSettingKeys.status,
			JSON.stringify(statusSchema.parse(status)),
			now,
			now,
		)
		.run();
}
