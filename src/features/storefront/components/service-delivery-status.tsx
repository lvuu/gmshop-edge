import { m } from "#/paraglide/messages";

export function ServiceDeliveryStatus({
	deliveries,
}: {
	deliveries: {
		id: string;
		type: string;
		status: string;
		productName: string;
		sellableItemName: string;
	}[];
}) {
	const pending = deliveries.filter(
		(delivery) =>
			delivery.type === "service" &&
			["awaiting_supply", "pending", "processing", "failed"].includes(
				delivery.status,
			),
	);
	if (!pending.length) return null;
	return (
		<section
			aria-label={m.store_service_result()}
			className="grid gap-3 border-t pt-6"
			aria-live="polite"
		>
			{pending.map((delivery) => (
				<div key={delivery.id} className="rounded-xl border p-4">
					<strong className="text-sm">
						{delivery.productName} · {delivery.sellableItemName}
					</strong>
					<p className="mt-2 text-muted-foreground text-sm">
						{delivery.status === "failed"
							? m.store_service_failed()
							: m.store_service_processing()}
					</p>
				</div>
			))}
		</section>
	);
}
