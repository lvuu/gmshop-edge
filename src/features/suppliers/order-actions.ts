export function supplierOrderActionAllowed(
	action: "reconcile" | "reselect",
	order: {
		state: string;
		orderStatus: string;
		accountId: string | null;
		accountLockedAt: number | null;
	},
) {
	if (!["paid", "fulfilling"].includes(order.orderStatus)) return false;
	if (action === "reconcile")
		return (
			["submitting", "uncertain"].includes(order.state) &&
			order.accountId !== null
		);
	return (
		["pending", "selecting", "failed"].includes(order.state) &&
		order.accountId === null &&
		order.accountLockedAt === null
	);
}
