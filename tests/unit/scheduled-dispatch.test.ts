import { describe, expect, it, vi } from "vitest";
import { handleScheduled } from "#/server/scheduled";

describe("Cloudflare scheduled dispatch", () => {
	it("only sends a non-secret maintenance envelope and tracks its promise", async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		const waitUntil = vi.fn();
		const scheduledTime = 1_791_729_000_000;
		const env = {
			COMMERCE_QUEUE: { send },
			get DB() {
				throw new Error("Cron must not touch D1 or run maintenance");
			},
		} as unknown as Env;
		handleScheduled(
			{ cron: "* * * * *", scheduledTime } as ScheduledController,
			env,
			{ waitUntil } as unknown as ExecutionContext,
		);
		expect(send).toHaveBeenCalledExactlyOnceWith({
			kind: "commerce.maintenance",
			version: 1,
			scheduledAt: scheduledTime,
		});
		expect(waitUntil).toHaveBeenCalledExactlyOnceWith(
			send.mock.results[0]?.value,
		);
		await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
	});

	it("leaves a failed queue send rejected for Cron observability", async () => {
		const failure = new Error("Queue unavailable");
		const waitUntil = vi.fn();
		handleScheduled(
			{ cron: "* * * * *", scheduledTime: Date.now() } as ScheduledController,
			{
				COMMERCE_QUEUE: { send: vi.fn().mockRejectedValue(failure) },
			} as unknown as Env,
			{ waitUntil } as unknown as ExecutionContext,
		);
		await expect(waitUntil.mock.calls[0]?.[0]).rejects.toBe(failure);
	});
});
