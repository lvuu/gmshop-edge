export function supplierOrderActionAllowed(
	action: "reconcile" | "reselect",
	order: SupplierOrderActionContext,
) {
	if (!["paid", "fulfilling"].includes(order.orderStatus)) return false;
	if (action === "reconcile")
		return (
			["submitting", "uncertain"].includes(order.state) &&
			order.accountId !== null &&
			(order.provider !== "dhru" || order.upstreamOrderId !== null)
		);
	return (
		["pending", "selecting", "failed"].includes(order.state) &&
		order.accountId === null &&
		order.accountLockedAt === null &&
		order.upstreamOrderId === null
	);
}

type SupplierOrderActionContext = {
	state: string;
	orderStatus: string;
	accountId: string | null;
	accountLockedAt: number | null;
	provider: string;
	upstreamOrderId: string | null;
};

export function supplierOrderNeedsManualReview(
	order: Pick<
		SupplierOrderActionContext,
		"state" | "provider" | "accountId" | "upstreamOrderId"
	>,
) {
	return (
		order.state === "uncertain" &&
		order.provider === "dhru" &&
		order.accountId !== null &&
		order.upstreamOrderId === null
	);
}
