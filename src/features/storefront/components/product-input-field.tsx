import { Checkbox as ProCheckbox } from "#/components/pro/base/fields/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { m } from "#/paraglide/messages";

export type StorefrontInputValue = string | number | boolean | string[];

export type StorefrontProductInput = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	inputType: "text" | "number" | "boolean" | "select" | "multiselect";
	scope: "authorization" | "automation" | "order";
	required: boolean;
	sensitive: boolean;
	validationPattern: string | null;
	minimumValue: number | null;
	maximumValue: number | null;
	defaultValue: string | null;
	exampleValue: string | null;
	options: { value: string; label: string }[];
};

type Props = {
	input: StorefrontProductInput;
	value: StorefrontInputValue | undefined;
	onChange: (value: StorefrontInputValue) => void;
	idPrefix?: string;
};

/** Renders a single product order input. Shared by the product and checkout pages. */
export function ProductInputField({
	input,
	value,
	onChange,
	idPrefix = "storefront",
}: Props) {
	const id = `${idPrefix}-${input.id}`;
	const hint = (
		<span className="block text-muted-foreground text-xs">
			{input.required ? m.store_input_required() : null}
			{input.sensitive ? ` · ${m.store_input_sensitive()}` : null}
		</span>
	);
	if (input.inputType === "boolean")
		return (
			<div className="flex items-center justify-between gap-4 rounded-lg border p-3">
				<div>
					<Label htmlFor={id}>{input.name}</Label>
					{hint}
				</div>
				<Switch checked={Boolean(value)} id={id} onCheckedChange={onChange} />
			</div>
		);
	if (input.inputType === "multiselect")
		return (
			<div className="grid gap-2">
				<div>
					<Label>{input.name}</Label>
					{hint}
				</div>
				<ProCheckbox
					id={id}
					onChange={onChange}
					options={input.options}
					optionsClassName="grid gap-3 sm:grid-cols-2"
					value={Array.isArray(value) ? value : []}
				/>
			</div>
		);
	if (input.inputType === "select")
		return (
			<div className="grid gap-2">
				<div>
					<Label htmlFor={id}>{input.name}</Label>
					{hint}
				</div>
				<select
					className="min-h-9 rounded-md border bg-transparent px-3 py-2 text-sm"
					id={id}
					onChange={(event) => onChange(event.currentTarget.value)}
					required={input.required}
					value={String(value ?? "")}
				>
					<option value="">{m.store_checkout_select_option()}</option>
					{input.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
		);
	return (
		<div className="grid gap-2">
			<div>
				<Label htmlFor={id}>{input.name}</Label>
				{hint}
			</div>
			<Input
				id={id}
				onChange={(event) => onChange(event.target.value)}
				required={input.required}
				placeholder={input.exampleValue ?? undefined}
				type={
					input.sensitive
						? "password"
						: input.inputType === "number"
							? "number"
							: "text"
				}
				value={String(value ?? input.defaultValue ?? "")}
			/>
		</div>
	);
}
