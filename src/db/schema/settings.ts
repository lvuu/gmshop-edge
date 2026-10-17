import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { timestamps } from "./common";

export const systemSettings = sqliteTable("system_settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>().notNull(),
	isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
	updatedBy: text("updated_by").references(() => users.id, {
		onDelete: "set null",
	}),
	...timestamps,
});

export const rateLimitCounters = sqliteTable(
	"rate_limit_counters",
	{
		id: text("id").primaryKey(),
		bucketKey: text("bucket_key").notNull(),
		windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
		count: integer("count").notNull().default(1),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("rate_limit_counters_bucket_window_uidx").on(
			table.bucketKey,
			table.windowStart,
		),
		index("rate_limit_counters_expiry_idx").on(table.expiresAt, table.id),
		check("rate_limit_counters_count_check", sql`${table.count} > 0`),
		check(
			"rate_limit_counters_expiry_check",
			sql`${table.expiresAt} > ${table.windowStart}`,
		),
	],
);

export const auditLogs = sqliteTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
		actorUserId: text("actor_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		action: text("action").notNull(),
		targetType: text("target_type").notNull(),
		targetId: text("target_id"),
		requestId: text("request_id"),
		ipAddress: text("ip_address"),
		before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
		after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("audit_logs_created_idx").on(table.createdAt, table.id)],
);

export const operationTaskRuns = sqliteTable(
	"operation_task_runs",
	{
		id: text("id").primaryKey(),
		task: text("task").notNull(),
		trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
		schedule: text("schedule"),
		status: text("status", { enum: ["running", "succeeded", "failed"] })
			.notNull()
			.default("running"),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		durationMs: integer("duration_ms"),
		errorCode: text("error_code"),
		result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
		artifactObjectKey: text("artifact_object_key"),
		requestedBy: text("requested_by").references(() => users.id, {
			onDelete: "set null",
		}),
		recordCount: integer("record_count"),
		deleteAfter: integer("delete_after", { mode: "timestamp_ms" }),
		artifactDeletedAt: integer("artifact_deleted_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("operation_task_runs_artifact_object_uidx").on(
			table.artifactObjectKey,
		),
		index("operation_task_runs_task_started_idx").on(
			table.task,
			table.startedAt,
		),
		index("operation_task_runs_task_status_started_idx").on(
			table.task,
			table.status,
			table.startedAt,
		),
		index("operation_task_runs_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} IN ('succeeded', 'failed')`),
		index("operation_task_runs_artifact_retention_idx")
			.on(table.deleteAfter, table.id)
			.where(
				sql`${table.artifactObjectKey} IS NOT NULL AND ${table.artifactDeletedAt} IS NULL`,
			),
	],
);
