import { DomainError } from "#/lib/domain-error";

export function decimalToMinor(value: string, decimals: number): string {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
		throw new DomainError(
			"invalid_supplier_money",
			502,
			"Supplier returned an invalid monetary value",
		);
	}
	const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
	if (!match || (match[2]?.length ?? 0) > decimals) {
		throw new DomainError(
			"invalid_supplier_money",
			502,
			"Supplier returned an invalid monetary value",
		);
	}
	const fraction = (match[2] ?? "").padEnd(decimals, "0");
	return (
		BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) +
		BigInt(fraction || "0")
	).toString();
}

/**
 * Rounds a non-negative decimal string to `decimals` fraction digits, half up.
 * Suppliers publish quoted costs with more precision than the account currency
 * exposes (Dhru returns amounts like `0.91500`), so catalog prices are quantized
 * before conversion. Integer math only; never floating point.
 */
export function roundDecimal(value: string, decimals: number): string {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
		throw new DomainError(
			"invalid_supplier_money",
			502,
			"Supplier returned an invalid monetary value",
		);
	}
	const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
	if (!match) {
		throw new DomainError(
			"invalid_supplier_money",
			502,
			"Supplier returned an invalid monetary value",
		);
	}
	const fraction = match[2] ?? "";
	if (fraction.length <= decimals) return value.trim();
	const scale = 10n ** BigInt(decimals);
	const rounded =
		BigInt(match[1] ?? "0") * scale +
		BigInt(fraction.slice(0, decimals) || "0") +
		(Number(fraction[decimals]) >= 5 ? 1n : 0n);
	const whole = rounded / scale;
	if (decimals === 0) return whole.toString();
	const rest = (rounded % scale).toString().padStart(decimals, "0");
	return `${whole}.${rest}`;
}

export function multiplyMinor(unitMinor: string, quantity: number): string {
	if (
		!/^(0|[1-9]\d*)$/.test(unitMinor) ||
		!Number.isSafeInteger(quantity) ||
		quantity < 1
	) {
		throw new DomainError(
			"invalid_supplier_money",
			500,
			"Supplier money calculation is invalid",
		);
	}
	return (BigInt(unitMinor) * BigInt(quantity)).toString();
}

export function markupMinor(
	costMinor: string,
	fixedMinor: string,
	markupBps: number,
) {
	if (
		!/^(0|[1-9]\d*)$/.test(costMinor) ||
		!/^(0|[1-9]\d*)$/.test(fixedMinor) ||
		!Number.isSafeInteger(markupBps) ||
		markupBps < 0
	)
		throw new DomainError(
			"invalid_supplier_money",
			500,
			"Supplier money calculation is invalid",
		);
	const cost = BigInt(costMinor);
	const proportional = (cost * BigInt(10_000 + markupBps) + 9_999n) / 10_000n;
	return (proportional + BigInt(fixedMinor)).toString();
}
