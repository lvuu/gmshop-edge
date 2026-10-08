import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("account entitlement operations", () => {
	it("keeps automation in account while allowing public order downloads", async () => {
		const source = await readFile(
			resolve("src/features/storefront/pages/order.tsx"),
			"utf8",
		);

		expect(source).toContain('to="/account/entitlements"');
		expect(source).toContain("/downloads/");
		expect(source).toContain(
			"asset.accessLimit === null || asset.accessCount < asset.accessLimit",
		);
		expect(source).toContain("email: accountOrder ? undefined : guestEmail");
		expect(source).not.toContain("<AutomationEntitlementCard");
	});

	it("loads download, automation and service operations in account entitlements", async () => {
		const source = await readFile(
			resolve("src/features/storefront/pages/account-sections.tsx"),
			"utf8",
		);

		expect(source).toContain("getAccountOrderFn");
		expect(source).toContain("/downloads/");
		expect(source).toContain("<AutomationEntitlementCard");
		expect(source).toMatch(
			/\[\s*"stock",\s*"download",\s*"automation",\s*"service",?\s*\]/,
		);
		expect(source).toContain("<DeliveryRevealContent");
		const deliveryContent = await readFile(
			resolve("src/features/storefront/components/delivery-reveal-content.tsx"),
			"utf8",
		);
		expect(deliveryContent).toContain("<CopyButton");
	});

	it("keeps entitlement identity actions above an equal-height bottom operation area", async () => {
		const source = await readFile(
			resolve("src/features/storefront/pages/account-sections.tsx"),
			"utf8",
		);
		const card = source.indexOf("<article");
		const status = source.indexOf(
			"entitlementStatusLabel(entitlement.status)",
			card,
		);
		const renew = source.indexOf("m.store_entitlement_renew()", card);
		const purchase = source.indexOf(
			"m.store_account_entitlement_details()",
			card,
		);
		const operations = source.indexOf(
			"<AccountEntitlementActions entitlement={entitlement} />",
			card,
		);

		expect(source).toContain('className="grid gap-4 lg:grid-cols-2"');
		expect(source).toContain(
			'"group flex min-w-0 flex-col rounded-3xl border bg-card p-5 transition-colors hover:border-primary/35 sm:p-6"',
		);
		expect(source).toContain(
			'className="mt-6 flex min-h-9 flex-wrap items-end gap-2"',
		);
		expect(card).toBeGreaterThan(-1);
		expect(status).toBeGreaterThan(card);
		expect(renew).toBeGreaterThan(status);
		expect(purchase).toBeGreaterThan(status);
		expect(renew).toBeLessThan(operations);
		expect(purchase).toBeLessThan(operations);
	});

	it("delegates renewal eligibility to the server and presents asset operations in dialogs", async () => {
		const accountSource = await readFile(
			resolve("src/features/storefront/pages/account-sections.tsx"),
			"utf8",
		);
		const automationSource = await readFile(
			resolve("src/features/storefront/components/build-entitlement.tsx"),
			"utf8",
		);

		expect(accountSource).toContain("{entitlement.renewable ? (");
		expect(accountSource).not.toContain("Date.now()");
		expect(accountSource).toContain("<DialogTrigger asChild>");
		expect(accountSource).toContain(
			"<DialogTitle>{m.store_downloads()}</DialogTitle>",
		);
		expect(accountSource).toContain(
			"{entitlement.productName} · {entitlement.sellableItemName}",
		);
		expect(automationSource).toContain(
			"<Dialog open={automationOpen} onOpenChange={setAutomationOpen}>",
		);
		expect(automationSource).toContain(
			"<Dialog open={historyOpen} onOpenChange={setHistoryOpen}>",
		);
	});

	it("runs automation from an accessible mobile dialog", async () => {
		const source = await readFile(
			resolve("src/features/storefront/components/build-entitlement.tsx"),
			"utf8",
		);

		expect(source).toContain("<Dialog");
		expect(source).toContain("100dvh");
		expect(source).toContain("setAutomationOpen(false)");
		expect(source).toContain("automationMethodLabel(method.name, method.key)");
		expect(source).toContain("<ProCheckbox");
		expect(source).toContain("options={definition.options}");
		expect(source).not.toContain("{method.name} · {method.runtime}");
		expect(source).not.toContain(
			"<select\n\t\t\t\t\tid={id}\n\t\t\t\t\tmultiple",
		);
		expect(source).not.toContain("rounded-xl border p-5");
	});

	it("renders checkout multiselect inputs as checkbox groups", async () => {
		const source = await readFile(
			resolve("src/features/storefront/pages/checkout.tsx"),
			"utf8",
		);

		expect(source).toContain('if (input.inputType === "multiselect")');
		expect(source).toContain("<ProCheckbox");
		expect(source).toContain("options={input.options}");
		expect(source).not.toContain(
			'multiple={input.inputType === "multiselect"}',
		);
	});
});
