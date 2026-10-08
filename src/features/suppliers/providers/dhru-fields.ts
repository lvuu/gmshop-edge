import { z } from "zod";
import { parseProductInputDefinitions } from "#/features/catalog/input-values";
import { DomainError } from "#/lib/domain-error";
import { supplierServiceOrderInputSchema } from "../schema";

// Only documented scalar inputs are imported. Unknown constraints/types fail
// closed rather than silently publishing an incomplete customer form.
const fieldsSchema = z
	.array(
		z
			.object({
				name: z.string().min(1).max(120),
				type: z.enum(["imei", "text"]),
				required: z.boolean().default(false),
			})
			.strict(),
	)
	.max(100);

export function importDhruFields(raw: unknown) {
	const parsed = fieldsSchema.safeParse(raw);
	if (!parsed.success) throw unsupportedFields();
	const seen = new Set<string>();
	const definitions = parsed.data.map((field, sortOrder) => {
		if (
			seen.has(field.name) ||
			!supplierServiceOrderInputSchema.safeParse({
				productId: "1",
				inputData: Object.fromEntries([[field.name, ""]]),
			}).success
		)
			throw unsupportedFields();
		seen.add(field.name);
		return {
			key: field.name,
			name: field.name,
			description: "",
			inputType: "text" as const,
			scope: "order" as const,
			required: field.required,
			sensitive: true,
			validationPattern: field.type === "imei" ? "^[0-9]{15}$" : "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "",
			exampleValue: "",
			sortOrder,
			options: [],
		};
	});
	parseProductInputDefinitions("import", JSON.stringify(definitions));
	return definitions;
}
function unsupportedFields() {
	return new DomainError(
		"supplier_service_fields_unsupported",
		409,
		"Service input schema is unsupported",
	);
}
