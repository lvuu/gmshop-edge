import { expect, it } from "vitest";
import {
	parseProductInputDefinitions,
	serializeInputValue,
} from "#/features/catalog/input-values";
import { importDhruFields } from "#/features/suppliers/providers/dhru-fields";

it("preserves exact keys, required flags and leading zero IMEIs as encrypted text", () => {
	const imported = importDhruFields([
		{ name: "IMEI", type: "imei", required: true },
		{ name: "Note", type: "text" },
	]);
	const definitions = parseProductInputDefinitions(
		"v1",
		JSON.stringify(imported),
	);
	expect(definitions[0]).toMatchObject({
		definition_key: "IMEI",
		required: 1,
		sensitive: 1,
		scope: "order",
		input_type: "text",
	});
	const first = definitions[0];
	if (!first) throw new Error("missing definition");
	expect(serializeInputValue(first, "012345678901234", "order")).toBe(
		"012345678901234",
	);
	expect(() => serializeInputValue(first, "bad", "order")).toThrow();
	expect(definitions[1]).toMatchObject({ required: 0, sensitive: 1 });
});
it.each([
	"reference_id",
	"feedback_url",
	"Quantity",
	"__proto__",
	"constructor",
	"prototype",
])("refuses reserved field %s", (name) => {
	expect(() => importDhruFields([{ name, type: "text" }])).toThrow();
});
it("fails closed on missing schemas, duplicates, unsupported types or unknown constraints", () => {
	for (const fields of [
		undefined,
		[{ name: "File", type: "file", required: true }],
		[{ name: "Choice", type: "select", options: ["a"] }],
		[{ name: "IMEI", type: "imei", max: 10 }],
		[
			{ name: "A", type: "text" },
			{ name: "A", type: "text" },
		],
		Array.from({ length: 101 }, (_, i) => ({ name: String(i), type: "text" })),
	])
		expect(() => importDhruFields(fields)).toThrow();
	expect(importDhruFields([])).toEqual([]);
});
