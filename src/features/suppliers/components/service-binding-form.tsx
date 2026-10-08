"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Input } from "#/components/pro/base/fields/input";
import { Select } from "#/components/pro/base/fields/select";
import { FormItem } from "#/components/pro/form";
import { formatMinorAmount } from "#/lib/format";
import { parseMajorInput } from "#/lib/money-input";
import { m } from "#/paraglide/messages";
import {
	bindServiceSupplierFn,
	listServiceBindingAccountsFn,
	previewServiceSupplierFn,
} from "../server/service-binding";

type BindingRequest = {
	sellableItemId: string;
	accountId: string;
	expectedRevision: number;
	productId: string;
	maxCostMinor: string;
};
type Preview = Awaited<ReturnType<typeof previewServiceSupplierFn>>;

type Item = {
	id: string;
	name: string;
	currency: string;
	currencyDecimals: number;
};
export function ServiceBindingForm({
	items,
	revision,
	disabled,
	onBound,
	onBusy,
}: {
	items: Item[];
	revision: number;
	disabled: boolean;
	onBound: () => Promise<unknown>;
	onBusy: (busy: boolean) => void;
}) {
	const fieldId = useId();
	const [itemId, setItemId] = useState("");
	const [accountId, setAccountId] = useState("");
	const [productId, setProductId] = useState("");
	const [limit, setLimit] = useState("");
	const [preview, setPreview] = useState<{
		key: string;
		value: Preview;
	} | null>(null);
	const [fields, setFields] = useState<string[]>([]);
	const item = items.find((i) => i.id === itemId);
	const accounts = useQuery({
		queryKey: ["admin", "suppliers", "service-binding-accounts"],
		queryFn: () => listServiceBindingAccountsFn(),
	});
	const eligible =
		accounts.data?.filter(
			(a) =>
				a.currency === item?.currency &&
				a.currency_decimals === item.currencyDecimals,
		) ?? [];
	const cost = item ? parseMajorInput(limit, item.currencyDecimals) : undefined;
	const request: BindingRequest | null =
		item &&
		cost != null &&
		productId.trim() &&
		eligible.some((a) => a.id === accountId)
			? {
					sellableItemId: item.id,
					accountId,
					expectedRevision: revision,
					productId: productId.trim(),
					maxCostMinor: cost,
				}
			: null;
	const requestKey = JSON.stringify(request);
	const currentPreview = preview?.key === requestKey ? preview.value : null;
	const previewMutation = useMutation({
		mutationFn: (data: BindingRequest) => previewServiceSupplierFn({ data }),
		onMutate: () => {
			setPreview(null);
			setFields([]);
			onBusy(true);
		},
		onSuccess: (value, data) =>
			setPreview({ key: JSON.stringify(data), value }),
		onError: () => toast.error(m.supplier_service_binding_error()),
		onSettled: () => onBusy(false),
	});

	const mutation = useMutation({
		mutationFn: async () => {
			if (!request || !currentPreview)
				throw new Error("invalid_service_binding");
			onBusy(true);
			return bindServiceSupplierFn({
				data: {
					...request,
					expectedServiceFingerprint: currentPreview.fingerprint,
				},
			});
		},
		onSuccess: async (result) => {
			setPreview(null);
			setFields(result.fields.map((f) => f.key));
			await onBound();
			toast.success(m.supplier_service_binding_saved());
		},
		onSettled: () => onBusy(false),
		onError: () => {
			setPreview(null);
			toast.error(m.supplier_service_binding_error());
		},
	});
	const busy = mutation.isPending || previewMutation.isPending;
	return (
		<section
			aria-label={m.supplier_service_binding_title()}
			className="grid gap-4 rounded-lg border p-4"
		>
			<div>
				<p className="font-medium">{m.supplier_service_binding_title()}</p>
				<p className="text-muted-foreground text-sm">
					{m.supplier_service_binding_description()}
				</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<FormItem
					htmlFor={`${fieldId}-plan`}
					label={m.supplier_sellable_item()}
					required
				>
					<Select
						id={`${fieldId}-plan`}
						disabled={disabled || busy}
						options={items.map((i) => ({ value: i.id, label: i.name }))}
						value={itemId}
						onChange={(value) => {
							setItemId(String(value ?? ""));
							setAccountId("");
							setFields([]);
						}}
					/>
				</FormItem>
				<FormItem
					htmlFor={`${fieldId}-account`}
					label={m.supplier_account()}
					required
				>
					<Select
						id={`${fieldId}-account`}
						disabled={disabled || busy || accounts.isPending}
						options={eligible.map((a) => ({ value: a.id, label: a.name }))}
						value={accountId}
						onChange={(value) => setAccountId(String(value ?? ""))}
					/>
				</FormItem>
				<FormItem
					htmlFor={`${fieldId}-product`}
					label={m.supplier_service_product_id()}
					required
				>
					<Input
						disabled={disabled || busy}
						id={`${fieldId}-product`}
						maxLength={512}
						value={productId}
						onChange={(e) => setProductId(e.target.value)}
					/>
				</FormItem>
				<FormItem
					htmlFor={`${fieldId}-cost`}
					label={`${m.supplier_cost_limit()} (${item?.currency ?? ""})`}
					required
				>
					<Input
						disabled={disabled || busy}
						id={`${fieldId}-cost`}
						maxLength={64}
						inputMode="decimal"
						value={limit}
						onChange={(e) => setLimit(e.target.value)}
					/>
				</FormItem>
			</div>
			{accounts.isError || previewMutation.isError || mutation.isError ? (
				<p role="alert" className="text-destructive text-sm">
					{m.supplier_service_binding_error()}
				</p>
			) : null}
			{disabled ? (
				<p className="text-muted-foreground text-sm">
					{m.supplier_service_binding_save_first()}
				</p>
			) : null}
			<ProButton
				type="button"
				variant="outline"
				disabled={disabled || busy || !request || accounts.isError}
				onClick={() => {
					if (request) previewMutation.mutate(request);
				}}
			>
				{m.supplier_service_preview_action()}
			</ProButton>
			{currentPreview ? (
				<div
					role="status"
					className="grid gap-3 rounded-md bg-muted/40 p-3 text-sm"
				>
					<p className="break-words font-medium">
						{currentPreview.name} ·{" "}
						{formatMinorAmount(
							currentPreview.costMinor,
							currentPreview.currency,
							currentPreview.currencyDecimals,
						)}
					</p>
					<p className="text-muted-foreground">
						{m.supplier_service_preview_review()}
					</p>
					{currentPreview.fields.length ? (
						<ul className="grid gap-2">
							{currentPreview.fields.map((field) => (
								<li key={field.key} className="break-words">
									<span className="font-medium">{field.key}</span> ·{" "}
									{field.required
										? m.store_input_required()
										: m.supplier_service_field_optional()}{" "}
									· {m.store_input_sensitive()}
									{field.validationPattern
										? ` · ${m.supplier_service_field_imei()}`
										: null}
								</li>
							))}
						</ul>
					) : (
						<p>{m.supplier_service_fields_none()}</p>
					)}
				</div>
			) : null}

			<ProButton
				type="button"
				disabled={
					disabled ||
					mutation.isPending ||
					!item ||
					!accountId ||
					!currentPreview ||
					!productId.trim() ||
					cost == null ||
					accounts.isError
				}
				onClick={() => mutation.mutate()}
			>
				{m.supplier_service_bind_import()}
			</ProButton>
			{fields.length ? (
				<p role="status" className="break-words text-sm">
					{m.supplier_service_imported_fields({ fields: fields.join(", ") })}
				</p>
			) : null}
		</section>
	);
}
