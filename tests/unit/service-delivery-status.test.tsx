import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceDeliveryStatus } from "#/features/storefront/components/service-delivery-status";
import { overwriteGetLocale } from "#/paraglide/runtime";

describe("customer service delivery progress", () => {
	for (const locale of ["en-US", "zh-CN"] as const) {
		it(`shows progress and support guidance without credentials in ${locale}`, () => {
			overwriteGetLocale(() => locale);
			const deliveries = [
				"awaiting_supply",
				"pending",
				"processing",
				"failed",
				"delivered",
			].map((status) => ({
				id: status,
				type: "service",
				status,
				productName: `product-${status}`,
				sellableItemName: "<script>private</script>",
			}));
			const html = renderToStaticMarkup(
				<ServiceDeliveryStatus deliveries={deliveries} />,
			);
			expect(html).toContain('aria-live="polite"');
			expect(html).toContain("product-awaiting_supply");
			expect(html).toContain("product-pending");
			expect(html).toContain("product-processing");
			expect(html).toContain("product-failed");
			expect(html).not.toContain("product-delivered");
			expect(html).not.toContain("<script>");
			expect(html).not.toContain("/reveal");
			expect(html).toContain(
				locale === "en-US" ? "Contact support" : "联系客服",
			);
			overwriteGetLocale(() => "en-US");
		});
	}
	it("does not mislabel stock or completed results as processing", () => {
		expect(
			renderToStaticMarkup(
				<ServiceDeliveryStatus
					deliveries={[
						{
							id: "stock",
							type: "stock",
							status: "awaiting_supply",
							productName: "Stock",
							sellableItemName: "Card",
						},
						{
							id: "service",
							type: "service",
							status: "delivered",
							productName: "Service",
							sellableItemName: "Result",
						},
					]}
				/>,
			),
		).toBe("");
	});
});
