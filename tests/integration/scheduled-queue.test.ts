import { Miniflare } from "miniflare";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { handleQueue } from "#/server/queue/routing";
import type { CommerceQueueMessage } from "#/server/queue/types";
import { handleScheduled } from "#/server/scheduled";
import { applyMigrations } from "./migrations";

describe("durable scheduled commerce work", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let env: Env;
	const send = vi.fn();
	const sendBatch = vi.fn();

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
			r2Buckets: { FILES: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		env = {
			DB: database,
			FILES: await miniflare.getR2Bucket("FILES"),
			COMMERCE_QUEUE: { send, sendBatch },
		} as unknown as Env;
	});

	afterAll(async () => miniflare.dispose());

	beforeEach(async () => {
		vi.restoreAllMocks();
		send.mockReset().mockResolvedValue(undefined);
		sendBatch.mockReset().mockResolvedValue(undefined);
		await database.batch([
			database.prepare("DELETE FROM operation_task_runs"),
			database.prepare("DELETE FROM rate_limit_counters"),
			database.prepare("DELETE FROM outbox_events"),
		]);
	});

	it("keeps Cron light, then publishes outbox work and cleans up at consumption time", async () => {
		const scheduledAt = Date.now() - 10 * 60_000;
		await expiredCounter("expired-after-scheduling", Date.now() - 1);
		await database
			.prepare(
				`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 VALUES ('scheduled-delivery', 'delivery.requested', 'delivery', 'delivery-1',
			  'scheduled-delivery', '{"deliveryId":"delivery-1","orderItemId":"item-1"}',
			  'pending', 0, 1, 1)`,
			)
			.run();
		const waitUntil = vi.fn();
		handleScheduled(
			{ cron: "* * * * *", scheduledTime: scheduledAt } as ScheduledController,
			env,
			{ waitUntil } as unknown as ExecutionContext,
		);
		await waitUntil.mock.calls[0]?.[0];
		expect(await counterCount()).toBe(1);
		expect(sendBatch).not.toHaveBeenCalled();
		const body = send.mock.calls[0]?.[0] as CommerceQueueMessage;
		expect(await consume(body)).toEqual(["ack"]);
		expect(await counterCount()).toBe(0);
		expect(sendBatch).toHaveBeenCalledExactlyOnceWith([
			{
				body: {
					kind: "commerce.delivery",
					version: 1,
					deliveryId: "delivery-1",
				},
			},
		]);
		expect(
			await database
				.prepare(
					"SELECT status FROM outbox_events WHERE id = 'scheduled-delivery'",
				)
				.first("status"),
		).toBe("published");
	});

	it("coalesces duplicates without allowing skipped records to suppress a newer tick", async () => {
		const oldTick = Date.now() - 60_000;
		expect(await consume(maintenance(oldTick))).toEqual(["ack"]);
		await expiredCounter("after-first-run", Date.now() - 1);
		expect(await consume(maintenance(oldTick))).toEqual(["ack"]);
		expect(await counterCount()).toBe(1);
		// A duplicate finished after this tick, but did no work. It must not
		// serve as a completion watermark for the new tick.
		await database
			.prepare(
				`UPDATE operation_task_runs SET started_at = ?
			 WHERE json_extract(result, '$.skipped') = 'already_completed'`,
			)
			.bind(Date.now() + 60_000)
			.run();
		expect(await consume(maintenance(Date.now()))).toEqual(["ack"]);
		expect(await counterCount()).toBe(0);
	});

	it("acknowledges overlapping ticks and recovers an expired maintenance lease", async () => {
		await database
			.prepare(
				`INSERT INTO operation_task_runs (id, task, trigger, schedule, status, started_at)
			 VALUES ('active-maintenance', 'commerce.maintenance', 'scheduled', '* * * * *', 'running', ?)`,
			)
			.bind(Date.now())
			.run();
		await expiredCounter("blocked-by-lease", Date.now() - 1);
		expect(await consume(maintenance(Date.now()))).toEqual(["ack"]);
		expect(await counterCount()).toBe(1);
		await database
			.prepare(
				"UPDATE operation_task_runs SET started_at = ? WHERE id = 'active-maintenance'",
			)
			.bind(Date.now() - 31 * 60_000)
			.run();
		expect(await consume(maintenance(Date.now()))).toEqual(["ack"]);
		expect(await counterCount()).toBe(0);
		expect(
			await database
				.prepare(
					"SELECT error_code FROM operation_task_runs WHERE id = 'active-maintenance'",
				)
				.first("error_code"),
		).toBe("lease_expired");
	});

	it("retries failed work and acknowledges it only after a successful recovery", async () => {
		await database
			.prepare(
				`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 VALUES ('retry-delivery', 'delivery.requested', 'delivery', 'delivery-1',
			  'retry-delivery', '{"deliveryId":"delivery-1","orderItemId":"item-1"}',
			  'pending', 0, 1, 1)`,
			)
			.run();
		sendBatch.mockRejectedValueOnce(new Error("temporary Queue outage"));
		const body = maintenance(Date.now());
		expect(await consume(body)).toEqual(["retry:15"]);
		expect(
			await database
				.prepare(
					"SELECT status FROM operation_task_runs WHERE task = 'commerce.maintenance'",
				)
				.first("status"),
		).toBe("failed");
		await expiredCounter("retry-cleanup", Date.now() - 1);
		expect(await consume(body, 2)).toEqual(["ack"]);
		expect(await counterCount()).toBe(0);
		expect(sendBatch).toHaveBeenCalledTimes(2);
	});

	async function expiredCounter(id: string, expiresAt: number) {
		await database
			.prepare(
				`INSERT INTO rate_limit_counters
			 (id, bucket_key, window_start, count, expires_at, created_at, updated_at)
			 VALUES (?, ?, 0, 1, ?, 1, 1)`,
			)
			.bind(id, id, expiresAt)
			.run();
	}

	async function counterCount() {
		return database
			.prepare("SELECT COUNT(*) FROM rate_limit_counters")
			.first<number>("COUNT(*)");
	}

	async function consume(body: CommerceQueueMessage, attempts = 1) {
		const outcomes: string[] = [];
		await handleQueue(
			{
				queue: "gmshop-edge-commerce",
				metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
				messages: [
					{
						id: crypto.randomUUID(),
						timestamp: new Date(),
						attempts,
						body,
						ack() {
							outcomes.push("ack");
						},
						retry(options?: QueueRetryOptions) {
							outcomes.push(`retry:${options?.delaySeconds}`);
						},
					},
				],
				ackAll() {},
				retryAll() {},
			},
			env,
		);
		return outcomes;
	}
});

function maintenance(scheduledAt: number): CommerceQueueMessage {
	return { kind: "commerce.maintenance", version: 1, scheduledAt };
}
