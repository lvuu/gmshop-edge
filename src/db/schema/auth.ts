import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { timestamps } from "./common";

export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		emailVerified: integer("email_verified", { mode: "boolean" })
			.notNull()
			.default(false),
		preferredLocale: text("preferred_locale", {
			enum: ["en-US", "zh-CN"],
		})
			.notNull()
			.default("en-US"),
		image: text("image"),
		telegramId: text("telegram_id"),
		telegramUsername: text("telegram_username"),
		telegramPhoneNumber: text("telegram_phone_number"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		balanceMinor: text("balance_minor").notNull().default("0"),
		balanceVersion: integer("balance_version").notNull().default(1),
		customerNote: text("customer_note"),
		lastOrderedAt: integer("last_ordered_at", { mode: "timestamp_ms" }),
		roleIds: text("role_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		index("users_created_idx").on(table.createdAt, table.id),
		check(
			"users_role_ids_json_check",
			sql`json_valid(${table.roleIds}) AND json_type(${table.roleIds}) = 'array' AND json_array_length(${table.roleIds}) <= 32`,
		),
		check(
			"users_balance_check",
			sql`${table.balanceMinor} <> '' AND ${table.balanceMinor} NOT GLOB '*[^0-9]*'`,
		),
		check("users_balance_version_check", sql`${table.balanceVersion} > 0`),
	],
);

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		...timestamps,
	},
	(table) => [index("sessions_user_idx").on(table.userId)],
);

export const accounts = sqliteTable(
	"accounts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {
			mode: "timestamp_ms",
		}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {
			mode: "timestamp_ms",
		}),
		scope: text("scope"),
		password: text("password"),
		telegramId: text("telegram_id"),
		telegramUsername: text("telegram_username"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("accounts_provider_account_uidx").on(
			table.providerId,
			table.accountId,
		),
	],
);

export const verifications = sqliteTable(
	"verifications",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		...timestamps,
	},
	(table) => [
		index("verifications_identifier_idx").on(table.identifier),
		index("verifications_expiry_idx").on(table.expiresAt, table.id),
	],
);

export const user = users;
export const session = sessions;
export const account = accounts;
export const verification = verifications;
