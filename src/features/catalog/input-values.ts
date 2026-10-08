import { z } from "zod";
import { DomainError } from "#/lib/domain-error";

export type ProductInputValue = string | number | boolean | string[];

export type ProductInputDefinition = {
	id: string;
	definition_key: string;
	name: string;
	description: string | null;
	input_type: "text" | "number" | "boolean" | "select" | "multiselect";
	scope: "authorization" | "automation" | "order";
	required: number;
	sensitive: number;
	validation_pattern: string | null;
	minimum_value: number | null;
	maximum_value: number | null;
	default_value: string | null;
	example_value: string | null;
	options: string;
};

const persistedDefinitionSchema = z.object({
	key: z.string().min(1),
	name: z.string(),
	description: z.string(),
	inputType: z.enum(["text", "number", "boolean", "select", "multiselect"]),
	scope: z.enum(["authorization", "automation", "order"]),
	required: z.boolean(),
	sensitive: z.boolean(),
	validationPattern: z.string(),
	minimumValue: z.number().int().nullable(),
	maximumValue: z.number().int().nullable(),
	defaultValue: z.string(),
	exampleValue: z.string().default(""),
	sortOrder: z.number().int(),
	options: z.array(z.object({ value: z.string(), label: z.string() })),
});

export const publishedProductInputDefinitionsSchema = z.array(
	persistedDefinitionSchema,
);

export function parseProductInputDefinitions(
	versionId: string,
	value: string,
): ProductInputDefinition[] {
	let raw: unknown;
	try {
		raw = JSON.parse(value);
	} catch {
		raw = null;
	}
	const parsed = publishedProductInputDefinitionsSchema.safeParse(raw);
	if (!parsed.success)
		throw new DomainError(
			"input_definition_invalid",
			500,
			"Published input definition is invalid",
		);
	return parsed.data
		.sort((left, right) => left.sortOrder - right.sortOrder)
		.map((definition) => ({
			id: `${versionId}:${definition.key}`,
			definition_key: definition.key,
			name: definition.name,
			description: definition.description || null,
			input_type: definition.inputType,
			scope: definition.scope,
			required: definition.required ? 1 : 0,
			sensitive: definition.sensitive ? 1 : 0,
			validation_pattern: definition.validationPattern || null,
			minimum_value: definition.minimumValue,
			maximum_value: definition.maximumValue,
			default_value: definition.defaultValue || null,
			example_value: definition.exampleValue || null,
			options: JSON.stringify(definition.options.map((option) => option.value)),
		}));
}

export function assertKnownInputKeys(
	values: Record<string, ProductInputValue>,
	definitions: ProductInputDefinition[],
	scope: ProductInputDefinition["scope"],
	errorPrefix: "automation" | "order",
) {
	const keys = new Set(
		definitions
			.filter((definition) => definition.scope === scope)
			.map((definition) => definition.definition_key),
	);
	if (Object.keys(values).some((key) => !keys.has(key)))
		throw inputError(errorPrefix, "unknown", "Unknown input");
}

export function serializeInputValue(
	definition: ProductInputDefinition,
	rawValue: ProductInputValue,
	errorPrefix: "automation" | "order",
) {
	let value: string;
	if (definition.input_type === "multiselect") {
		if (!Array.isArray(rawValue))
			throw inputError(errorPrefix, "invalid", "Invalid input");
		value = JSON.stringify(rawValue);
	} else if (Array.isArray(rawValue))
		throw inputError(errorPrefix, "invalid", "Invalid input");
	else if (definition.input_type === "boolean") {
		if (typeof rawValue !== "boolean")
			throw inputError(errorPrefix, "invalid", "Invalid input");
		value = rawValue ? "true" : "false";
	} else if (definition.input_type === "number") {
		const number = typeof rawValue === "number" ? rawValue : Number(rawValue);
		if (!Number.isSafeInteger(number))
			throw inputError(errorPrefix, "invalid", "Invalid input");
		if (definition.minimum_value != null && number < definition.minimum_value)
			throw inputError(errorPrefix, "invalid", "Invalid input");
		if (definition.maximum_value != null && number > definition.maximum_value)
			throw inputError(errorPrefix, "invalid", "Invalid input");
		value = String(number);
	} else value = String(rawValue).trim();
	if (
		definition.required &&
		(!value ||
			(definition.input_type === "multiselect" &&
				(JSON.parse(value) as string[]).length === 0))
	)
		throw inputError(errorPrefix, "required", "Input is required");
	const options = parseOptions(definition.options, errorPrefix);
	if (definition.input_type === "select" && !options.includes(value))
		throw inputError(errorPrefix, "invalid", "Invalid input");
	if (definition.input_type === "multiselect") {
		const selected = JSON.parse(value) as string[];
		if (selected.some((option) => !options.includes(option)))
			throw inputError(errorPrefix, "invalid", "Invalid input");
	}
	if (
		definition.validation_pattern &&
		!new RegExp(definition.validation_pattern, "u").test(value)
	)
		throw inputError(errorPrefix, "invalid", "Invalid input");
	return value;
}

function parseOptions(value: string, errorPrefix: "automation" | "order") {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			Array.isArray(parsed) &&
			parsed.every((option) => typeof option === "string")
		)
			return parsed;
	} catch {
		// Published definitions are validated, but corrupt persistence fails closed.
	}
	throw inputError(errorPrefix, "invalid", "Invalid input definition");
}

function inputError(
	prefix: "automation" | "order",
	kind: "unknown" | "invalid" | "required",
	message: string,
) {
	return new DomainError(`${prefix}_input_${kind}`, 400, message);
}
