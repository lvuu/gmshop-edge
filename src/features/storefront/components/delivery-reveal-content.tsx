"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton } from "#/components/pro/base/button";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export function DeliveryRevealContent({
	deliveryId,
	orderNumber,
	email,
	className,
	skeletonClassName,
}: {
	deliveryId: string;
	orderNumber: string;
	email?: string;
	className?: string;
	skeletonClassName?: string;
}) {
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{
		key: string;
		content: string | null;
		failed: boolean;
	} | null>(null);
	const endpoint = `/api/shop/orders/${encodeURIComponent(orderNumber)}/deliveries/${encodeURIComponent(deliveryId)}/reveal`;
	const requestKey = JSON.stringify([endpoint, email ?? null, attempt]);
	const current = result?.key === requestKey ? result : null;

	useEffect(() => {
		const controller = new AbortController();
		void fetch(endpoint, { ...revealRequest(email), signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("delivery_reveal_failed");
				const body = (await response.json()) as { content?: unknown };
				if (typeof body.content !== "string" || !body.content.trim())
					throw new Error("delivery_reveal_failed");
				if (!controller.signal.aborted)
					setResult({ key: requestKey, content: body.content, failed: false });
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setResult({ key: requestKey, content: null, failed: true });
			});
		return () => controller.abort();
	}, [email, endpoint, requestKey]);

	if (current?.failed)
		return (
			<div className="flex flex-wrap items-center gap-3">
				<p role="alert" className="text-destructive text-sm">
					{m.store_delivery_reveal_failed()}
				</p>
				<Button
					size="sm"
					variant="outline"
					onClick={() => setAttempt((value) => value + 1)}
				>
					{m.common_retry()}
				</Button>
			</div>
		);
	const content = current?.content;
	if (!content)
		return (
			<Skeleton className={cn("h-12 w-full rounded-xl", skeletonClassName)} />
		);
	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-2 rounded-xl border bg-muted/30 p-2 pl-3",
				className,
			)}
		>
			<code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-pre">
				{content}
			</code>
			<CopyButton
				aria-label={m.store_copy_delivery()}
				copy={content}
				icon={<Copy />}
				onClick={() =>
					void fetch(endpoint, revealRequest(email, "copied")).catch(
						() => undefined,
					)
				}
				size="icon-sm"
				tooltip={m.store_copy_delivery()}
				variant="ghost"
			/>
		</div>
	);
}

function revealRequest(email?: string, action?: "copied"): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, email }),
		credentials: "same-origin",
	};
}
