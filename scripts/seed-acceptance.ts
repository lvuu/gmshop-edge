import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { hashPassword } from "better-auth/crypto";
import { storefrontCustomerRoleName } from "#/features/access/storefront-access";
import { telegramIdentityEmail } from "#/features/auth/identity-email";
import {
	authProviderSecretKey,
	authProviderSecretPurpose,
	authProviderSettingKeys,
	initialStoredAuthProviders,
	storedAuthProvidersSchema,
} from "#/features/auth/provider-settings";
import {
	encryptAutomationCallbackSecret,
	encryptBuildConfigSecret,
	encryptBuildInput,
} from "#/features/builds/secrets";
import {
	fingerprintInventorySecret,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	createSupplierCredentialVault,
	supplierCredentialFingerprint,
} from "#/features/suppliers/secrets";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { createDhruAcceptanceStatements } from "./seed-dhru-fixtures";

const databaseName = "gmshop-edge";
const bucketName = "gmshop-edge-files";
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const now = Date.now();
const scriptArgs = process.argv.slice(2);
const withR2 = scriptArgs.includes("--with-r2");
const force = scriptArgs.includes("--force");
const telegramProviderId = "77700000-0000-4000-8000-000000000001";
const telegramBotUserId = "777000";
const telegramBotUsername = "gmshop_local_bot";
const telegramBotToken =
	"777000:AAH_local_Telegram_Mini_App_fixture_token_2026";
const telegramUserId = "777000123";
const telegramEmail = telegramIdentityEmail(telegramUserId);
const persistToIndex = scriptArgs.indexOf("--persist-to");
const persistTo =
	persistToIndex >= 0 ? scriptArgs[persistToIndex + 1]?.trim() : undefined;
if (persistToIndex >= 0 && !persistTo)
	throw new Error("--persist-to requires a directory.");

if (!scriptArgs.includes("--local") || scriptArgs.includes("--remote"))
	throw new Error(
		"Acceptance fixtures are local-only. Run `bun run seed:local`.",
	);

const settings = await queryRows(
	"SELECT key, value FROM system_settings WHERE key = 'runtime.data_encryption_secret'",
);
const commerceSecret = readSetting(settings, "runtime.data_encryption_secret");
const customerEmail = "root@example.com";
const customerPassword = "root@example.com";
const fixtureOwners = await queryRows(
	`SELECT 'user' AS key, id AS value FROM users
	 WHERE email = ${q(customerEmail)} AND enabled = 1`,
);
const customerUserId = requireValue(
	fixtureOwners.find((row) => row.key === "user")?.value,
	"Install the local store before seeding (enabled root user).",
);
const customerPasswordHash = await hashPassword(customerPassword);

const paymentChannels = [
	{
		id: uuid(6, 1),
		provider: "gmpay",
		name: "GMpay",
		currency: "USD",
		defaultToken: "usdt",
		defaultNetwork: "tron",
		credential: {
			baseUrl: "https://payments.example.invalid",
			pid: "demo-store",
			secretKey: "demo-secret-not-real",
		},
		feeBps: 100,
		fixedFeeMinor: "0",
		sortOrder: 100,
	},
	{
		id: uuid(6, 2),
		provider: "epay",
		name: "EPay",
		currency: "USD",
		defaultToken: "usdt",
		defaultNetwork: "tron",
		credential: {
			baseUrl: "https://payments.example.invalid",
			pid: "10001",
			secretKey: "demo-secret-not-real",
		},
		feeBps: 150,
		fixedFeeMinor: "0",
		sortOrder: 200,
	},
	{
		id: uuid(6, 3),
		provider: "stripe",
		name: "Stripe",
		currency: "USD",
		defaultToken: "",
		defaultNetwork: "",
		credential: {
			secretKey: "sk_test_demo_not_real",
			webhookSecret: "whsec_demo_not_real",
		},
		feeBps: 290,
		fixedFeeMinor: "30",
		sortOrder: 300,
	},
	{
		id: uuid(6, 8),
		provider: "cryptomus",
		name: "Cryptomus",
		currency: "USD",
		defaultToken: "",
		defaultNetwork: "",
		credential: {
			merchantId: uuid(9, 1),
			paymentApiKey: "demo-cryptomus-payment-key-not-real",
		},
		feeBps: 40,
		fixedFeeMinor: "0",
		sortOrder: 350,
	},
	{
		id: uuid(6, 4),
		provider: "alipay_page",
		name: "支付宝电脑网站支付",
		currency: "CNY",
		defaultToken: "",
		defaultNetwork: "",
		credential: alipayCredential("page"),
		feeBps: 60,
		fixedFeeMinor: "0",
		sortOrder: 400,
	},
	{
		id: uuid(6, 5),
		provider: "alipay_wap",
		name: "支付宝手机网站支付",
		currency: "CNY",
		defaultToken: "",
		defaultNetwork: "",
		credential: alipayCredential("wap"),
		feeBps: 60,
		fixedFeeMinor: "0",
		sortOrder: 500,
	},
	{
		id: uuid(6, 6),
		provider: "wechat_native",
		name: "微信扫码支付",
		currency: "CNY",
		defaultToken: "",
		defaultNetwork: "",
		credential: wechatCredential("native"),
		feeBps: 60,
		fixedFeeMinor: "0",
		sortOrder: 600,
	},
	{
		id: uuid(6, 7),
		provider: "wechat_h5",
		name: "微信 H5 支付",
		currency: "CNY",
		defaultToken: "",
		defaultNetwork: "",
		credential: wechatCredential("h5"),
		feeBps: 60,
		fixedFeeMinor: "0",
		sortOrder: 700,
	},
] as const;

const products = [
	product(
		1,
		"stock",
		"开发者工具授权码",
		"付款后自动发放授权码，可用于激活开发者工具。",
		100,
	),
	product(
		2,
		"download",
		"设计资源下载包",
		"购买后可从订单和资产库下载完整设计资源。",
		200,
		withR2 ? "active" : "draft",
	),
	product(
		3,
		"automation",
		"云端环境开通",
		"自动执行环境部署、初始化脚本和资源开通。",
		300,
	),
	product(
		4,
		"automation",
		"应用构建服务",
		"按额度运行应用构建任务，并生成可下载的构建产物。",
		400,
	),
	product(
		5,
		"download",
		"免费入门资料",
		"包含快速开始指南、示例配置和常用操作说明。",
		500,
		withR2 ? "active" : "draft",
	),
	product(
		101,
		"stock",
		"团队账号凭证",
		"按购买数量自动分配独立账号凭证，支持单份和组合方案。",
		600,
	),
	product(
		201,
		"stock",
		"异次元供应商品",
		"仅供开发环境使用的异次元供应商履约商品，不会请求真实上游。",
		700,
		"draft",
	),
	product(
		202,
		"stock",
		"独角数卡供应商品",
		"仅供开发环境使用的独角数卡 Next 供应商履约商品，不会请求真实上游。",
		800,
		"draft",
	),
] as const;

const items = [
	sellableItem(1, 1, 1, "标准方案", "990", 100, 1),
	sellableItem(2, 2, 2, "下载方案", "1290", 100, 5),
	sellableItem(3, 3, 3, "三次资源开通", "1990", 100, 1),
	sellableItem(4, 4, 4, "五次自动化", "1590", 100, 1),
	sellableItem(51, 1, 51, "永久授权", "490", 100, 1),
	sellableItem(61, 1, 61, "30 天授权", "590", 200, 1),
	sellableItem(62, 1, 62, "7 天免费试用授权", "0", 250, 1),
	sellableItem(52, 2, 52, "永久下载", "790", 300, 3),
	sellableItem(55, 2, 55, "30 天不限下载", "890", 400, 3),
	sellableItem(56, 2, 56, "永久下载 3 次", "690", 500, 1),
	sellableItem(57, 2, 57, "30 天下载 10 次", "1090", 600, 1),
	sellableItem(59, 5, 59, "7 天试用下载", "0", 700, 1),
	sellableItem(71, 5, 71, "免费永久下载", "0", 710, 1),
	sellableItem(72, 5, 72, "免费 30 天不限下载", "0", 720, 1),
	sellableItem(73, 5, 73, "免费永久下载 3 次", "0", 730, 1),
	sellableItem(58, 3, 58, "单次自动部署", "1990", 800, 1),
	sellableItem(53, 3, 53, "两次脚本执行", "1490", 900, 1),
	sellableItem(74, 3, 74, "30 天单次资源开通", "990", 910, 1),
	sellableItem(75, 3, 75, "30 天三次自动部署", "2490", 920, 1),
	sellableItem(76, 3, 76, "免费单次试运行", "0", 930, 1),
	sellableItem(77, 3, 77, "7 天两次试用自动化", "0", 940, 1),
	sellableItem(60, 4, 60, "永久 5 次自动化", "590", 1_000, 1),
	sellableItem(54, 4, 54, "30 天 10 次自动化", "990", 1_100, 1),
	sellableItem(78, 4, 78, "永久单次自动化", "290", 1_110, 1),
	sellableItem(79, 4, 79, "免费单次自动化", "0", 1_120, 1),
	sellableItem(80, 4, 80, "7 天免费试用自动化", "0", 1_130, 1),
	sellableItem(81, 4, 81, "30 天 5 次自动化", "690", 1_140, 1),
	sellableItem(82, 101, 82, "单份账号凭证", "1290", 1_200, 1),
	sellableItem(83, 101, 83, "三份凭证包", "2990", 1_210, 3),
	sellableItem(201, 201, 201, "异次元标准卡密", "1990", 1_300, 5, "CNY"),
	sellableItem(202, 202, 202, "独角数卡月卡", "2990", 1_400, 3, "CNY"),
	sellableItem(203, 202, 203, "独角数卡季卡", "6990", 1_410, 2, "CNY"),
] as const;

const components = [
	component(1, 1, "stock", { lowStockThreshold: 2 }),
	component(2, 2, "download", { durationMs: 30 * 86_400_000 }),
	component(3, 3, "automation", { usageLimit: 3 }),
	component(4, 4, "automation", { usageLimit: 5 }),
	component(51, 1, "stock", { lowStockThreshold: 2 }),
	component(61, 1, "stock", {
		durationMs: 30 * 86_400_000,
		lowStockThreshold: 2,
	}),
	component(62, 1, "stock", {
		durationMs: 7 * 86_400_000,
		lowStockThreshold: 2,
	}),
	component(52, 2, "download", {}),
	component(55, 2, "download", { durationMs: 30 * 86_400_000 }),
	component(56, 2, "download", { accessLimit: 3 }),
	component(57, 2, "download", {
		durationMs: 30 * 86_400_000,
		accessLimit: 10,
	}),
	component(59, 5, "download", {
		durationMs: 7 * 86_400_000,
		accessLimit: 1,
	}),
	component(71, 5, "download", {}),
	component(72, 5, "download", { durationMs: 30 * 86_400_000 }),
	component(73, 5, "download", { accessLimit: 3 }),
	component(58, 3, "automation", { usageLimit: 1 }),
	component(53, 3, "automation", { usageLimit: 2 }),
	component(74, 3, "automation", {
		durationMs: 30 * 86_400_000,
		usageLimit: 1,
	}),
	component(75, 3, "automation", {
		durationMs: 30 * 86_400_000,
		usageLimit: 3,
	}),
	component(76, 3, "automation", { usageLimit: 1 }),
	component(77, 3, "automation", {
		durationMs: 7 * 86_400_000,
		usageLimit: 2,
	}),
	component(60, 4, "automation", { usageLimit: 5 }),
	component(54, 4, "automation", {
		durationMs: 30 * 86_400_000,
		usageLimit: 10,
	}),
	component(78, 4, "automation", { usageLimit: 1 }),
	component(79, 4, "automation", { usageLimit: 1 }),
	component(80, 4, "automation", {
		durationMs: 7 * 86_400_000,
		usageLimit: 1,
	}),
	component(81, 4, "automation", {
		durationMs: 30 * 86_400_000,
		usageLimit: 5,
	}),
	component(82, 101, "stock", { lowStockThreshold: 3 }),
	component(83, 101, "stock", { lowStockThreshold: 6 }),
	component(201, 201, "stock", { lowStockThreshold: 3 }),
	component(202, 202, "stock", { lowStockThreshold: 3 }),
	component(203, 202, "stock", { lowStockThreshold: 2 }),
] as const;

const productTypes = new Map(
	products.map((productRow) => [productRow.id, productRow.productType]),
);
const componentsById = new Map(components.map((row) => [row.id, row]));
const sellableItemIdByComponent = new Map(
	items.map((row) => [row.componentId, row.id]),
);
for (const item of items) {
	const delivery = componentsById.get(item.componentId);
	if (
		!delivery ||
		delivery.productId !== item.productId ||
		delivery.type !== productTypes.get(item.productId)
	)
		throw new Error(
			`Acceptance fixture ${item.id} does not inherit its product delivery type.`,
		);
}

const downloadFixtures = [
	downloadFixture(2, 2, "design-assets.txt"),
	downloadFixture(2, 52, "design-assets-permanent.txt"),
	downloadFixture(2, 55, "design-assets-30-days.txt"),
	downloadFixture(2, 56, "design-assets-three-downloads.txt"),
	downloadFixture(2, 57, "design-assets-30-days-ten-downloads.txt"),
	downloadFixture(5, 59, "getting-started-trial.txt"),
	downloadFixture(5, 71, "getting-started-permanent.txt"),
	downloadFixture(5, 72, "getting-started-30-days.txt"),
	downloadFixture(5, 73, "getting-started-three-downloads.txt"),
] as const;

const mediaFixtures = [
	mediaFixture(1, 1, [40, 95, 180]),
	mediaFixture(1, 11, [30, 125, 185]),
	mediaFixture(1, 12, [65, 85, 170]),
	mediaFixture(2, 2, [20, 135, 105]),
	mediaFixture(2, 21, [35, 155, 125]),
	mediaFixture(2, 22, [15, 105, 85]),
	mediaFixture(3, 3, [170, 95, 35]),
	mediaFixture(3, 31, [195, 120, 45]),
	mediaFixture(3, 32, [145, 75, 25]),
	mediaFixture(4, 4, [105, 65, 180]),
	mediaFixture(4, 41, [125, 85, 205]),
	mediaFixture(4, 42, [80, 45, 150]),
	mediaFixture(5, 51, [25, 105, 155]),
	mediaFixture(5, 52, [25, 145, 125]),
	mediaFixture(5, 53, [135, 75, 165]),
	mediaFixture(101, 6, [175, 70, 85]),
	mediaFixture(101, 61, [205, 95, 105]),
	mediaFixture(101, 62, [145, 50, 70]),
] as const;

const customerPurchases = [
	customerPurchase(1, 1, 51, "active", 18, {
		usageCount: 0,
		accessCount: 0,
	}),
	customerPurchase(2, 2, 57, "active", 10, {
		usageCount: 0,
		accessCount: 2,
	}),
	customerPurchase(3, 2, 56, "exhausted", 16, {
		usageCount: 0,
		accessCount: 3,
	}),
	customerPurchase(4, 2, 55, "expired", 40, {
		usageCount: 0,
		accessCount: 1,
	}),
	customerPurchase(5, 4, 60, "active", 12, {
		usageCount: 2,
		accessCount: 1,
	}),
	customerPurchase(6, 3, 58, "exhausted", 14, {
		usageCount: 1,
		accessCount: 0,
	}),
	customerPurchase(7, 3, 77, "expired", 10, {
		usageCount: 1,
		accessCount: 0,
	}),
] as const;

const supplierCatalogFixtures = [
	{
		version: 1 as const,
		provider: "acg" as const,
		normalizedApiOrigin: "https://acg.example.invalid",
		protocolVersion: "3.5.5-v4",
		syncedAt: now - 600_000,
		products: [
			{
				id: "demo-acg-product-1",
				name: "异次元演示卡密",
				description: "用于验证已导入与未导入 SKU 的本地目录快照。",
				imageUrls: [],
				categoryNames: ["演示", "卡密"],
				active: true,
				skus: [
					{
						id: "demo-acg-sku-standard",
						name: "标准版",
						costMinor: "990",
						stockQuantity: 88,
						active: true,
					},
					{
						id: "demo-acg-sku-premium",
						name: "高级版",
						costMinor: "1490",
						stockQuantity: 42,
						active: true,
					},
				],
			},
			{
				id: "demo-acg-product-2",
				name: "异次元演示礼品卡",
				description: "用于验证同步后批量选择导入。",
				imageUrls: [],
				categoryNames: ["演示", "礼品卡"],
				active: true,
				skus: [
					{
						id: "demo-acg-sku-gift-100",
						name: "100 元面值",
						costMinor: "8500",
						stockQuantity: 20,
						active: true,
					},
				],
			},
		],
	},
	{
		version: 1 as const,
		provider: "dujiao_next" as const,
		normalizedApiOrigin: "https://dujiao.example.invalid",
		protocolVersion: "1.3.1-upstream-v1",
		syncedAt: now - 600_000,
		products: [
			{
				id: "demo-dujiao-product-1",
				name: "独角数卡演示会员",
				description: "用于验证多 SKU、停售和批量导入。",
				imageUrls: [],
				categoryNames: ["演示", "会员"],
				active: true,
				skus: [
					{
						id: "demo-dujiao-sku-month",
						name: "月卡",
						costMinor: "1590",
						stockQuantity: 36,
						active: true,
					},
					{
						id: "demo-dujiao-sku-quarter",
						name: "季卡",
						costMinor: "3990",
						stockQuantity: 0,
						active: false,
					},
					{
						id: "demo-dujiao-sku-year",
						name: "年卡",
						costMinor: "9990",
						stockQuantity: 12,
						active: true,
					},
				],
			},
			{
				id: "demo-dujiao-product-2",
				name: "独角数卡演示点数",
				description: "用于验证所有来源目录与批量选择导入。",
				imageUrls: [],
				categoryNames: ["演示", "点数"],
				active: true,
				skus: [
					{
						id: "demo-dujiao-sku-points",
						name: "1000 点",
						costMinor: "5000",
						stockQuantity: 100,
						active: true,
					},
				],
			},
		],
	},
] as const;

const automationArtifactBody = new TextEncoder().encode(
	"GMShop Edge example automation artifact\n",
);
const automationArtifactFixture = {
	id: uuid(21, 1),
	jobId: uuid(20, 6_001),
	objectKey: `automation/${uuid(20, 6_001)}/demo-build.zip`,
	fileName: "demo-build.zip",
	contentType: "application/zip",
	body: automationArtifactBody,
	checksum: createHash("sha256").update(automationArtifactBody).digest("hex"),
};

if (withR2) {
	for (const fixture of mediaFixtures)
		await putR2Object(fixture.objectKey, fixture.body, "image/png");
	for (const fixture of downloadFixtures)
		await putR2Object(
			fixture.objectKey,
			fixture.body,
			"text/plain; charset=utf-8",
		);
	await putR2Object(
		automationArtifactFixture.objectKey,
		automationArtifactFixture.body,
		automationArtifactFixture.contentType,
	);
}

const sql: string[] = [];
sql.push(
	`UPDATE accounts SET password = ${q(customerPasswordHash)},
	  updated_at = ${now}
	 WHERE user_id = ${q(customerUserId)} AND provider_id = 'credential'
	  AND account_id = ${q(customerUserId)}`,
);

for (const channel of paymentChannels)
	sql.push(
		`INSERT INTO payment_channels
		 (id, provider, name, currency, default_token, default_network,
		  credential_encrypted, credential_key_version, fee_bps, fixed_fee_minor,
		  sort_order, enabled, last_health_status, created_at, updated_at)
		 VALUES (${q(channel.id)}, ${q(channel.provider)}, ${q(channel.name)},
		  ${q(channel.currency)}, ${q(channel.defaultToken)}, ${q(channel.defaultNetwork)},
		  ${q(await encryptSecret(JSON.stringify(channel.credential), commerceSecret, "payment-credential"))},
		  1, ${channel.feeBps}, ${q(channel.fixedFeeMinor)}, ${channel.sortOrder},
		  1, 'unknown', ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET provider = excluded.provider,
		  name = excluded.name, currency = excluded.currency,
		  default_token = excluded.default_token,
		  default_network = excluded.default_network,
		  credential_encrypted = excluded.credential_encrypted,
		  credential_key_version = excluded.credential_key_version,
		  fee_bps = excluded.fee_bps,
		  fixed_fee_minor = excluded.fixed_fee_minor,
		  sort_order = excluded.sort_order, enabled = excluded.enabled,
		  last_health_status = excluded.last_health_status,
		  last_checked_at = NULL, updated_at = excluded.updated_at`,
	);

for (const row of products) {
	const tagNames = [
		"精选",
		row.productType === "automation" ? "自动化服务" : "即时交付",
	];
	sql.push(
		`INSERT INTO products
		 (id, product_type, name, description, tag_names, status, cover_object_key, revision, revision_token,
		  sort_order, created_at, updated_at)
		 VALUES (${q(row.id)}, ${q(row.productType)}, ${q(row.name)}, ${q(row.description)}, ${q(JSON.stringify(tagNames))}, ${q(row.status)},
		  ${q(withR2 ? (mediaFixtures.find((media) => media.productId === row.id)?.objectKey ?? null) : null)},
		  1, lower(hex(randomblob(16))), ${row.sortOrder}, ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
		  description = excluded.description, tag_names = excluded.tag_names,
		  status = excluded.status,
		  cover_object_key = excluded.cover_object_key, sort_order = excluded.sort_order,
		  updated_at = excluded.updated_at`,
	);
}

for (const row of items) {
	const delivery = componentsById.get(row.componentId);
	if (!delivery) throw new Error(`Missing delivery policy for ${row.id}`);
	sql.push(
		`INSERT INTO product_sellable_items
		 (id, product_id, name, duration_ms, usage_limit, access_limit, renewal_mode,
		  email_mode, show_on_order_page, allow_resend, low_stock_threshold, version,
		  currency, currency_decimals,
		  price_minor, minimum_quantity, maximum_quantity, sort_order, enabled,
		  created_at, updated_at)
		 VALUES (${q(row.id)}, ${q(row.productId)}, ${q(row.name)},
		  ${q(delivery.durationMs)}, ${q(delivery.usageLimit)}, ${q(delivery.accessLimit)},
		  'stack', 'none', 1, 1, ${delivery.lowStockThreshold}, 1,
		  ${q(row.currency)}, 2, ${q(row.priceMinor)}, 1, ${row.maximumQuantity},
		  ${row.sortOrder}, 1, ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id,
		  name = excluded.name, duration_ms = excluded.duration_ms,
		  usage_limit = excluded.usage_limit, access_limit = excluded.access_limit,
		  renewal_mode = excluded.renewal_mode, email_mode = excluded.email_mode,
		  show_on_order_page = excluded.show_on_order_page,
		  allow_resend = excluded.allow_resend,
		  low_stock_threshold = excluded.low_stock_threshold,
		  currency = excluded.currency, currency_decimals = excluded.currency_decimals,
		  price_minor = excluded.price_minor,
		  minimum_quantity = excluded.minimum_quantity,
		  maximum_quantity = excluded.maximum_quantity,
		  sort_order = excluded.sort_order, enabled = excluded.enabled,
		  updated_at = excluded.updated_at`,
	);
}

if (withR2)
	for (const fixture of mediaFixtures)
		sql.push(
			`INSERT INTO product_media
		 (id, product_id, object_key, alt_text, content_type, size_bytes,
		  sort_order, created_at, updated_at)
		 VALUES (${q(fixture.id)}, ${q(fixture.productId)}, ${q(fixture.objectKey)},
		  ${q(fixture.altText)}, 'image/png', ${fixture.body.byteLength},
		  ${fixture.sortOrder}, ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET object_key = excluded.object_key,
		  alt_text = excluded.alt_text, content_type = excluded.content_type,
		  size_bytes = excluded.size_bytes, sort_order = excluded.sort_order,
		  updated_at = excluded.updated_at`,
		);

if (withR2)
	for (const fixture of downloadFixtures) {
		const sellableItemId = sellableItemIdByComponent.get(fixture.componentId);
		if (!sellableItemId)
			throw new Error(`Missing sellable item for ${fixture.componentId}`);
		sql.push(
			`INSERT INTO download_assets
		 (id, product_id, object_key, file_name, content_type, size_bytes,
		  checksum_sha256, version, download_enabled, sort_order, created_at, updated_at)
		 VALUES (${q(fixture.id)}, ${q(fixture.productId)}, ${q(fixture.objectKey)},
		  ${q(fixture.fileName)}, 'text/plain; charset=utf-8', ${fixture.body.byteLength},
		  ${q(fixture.checksum)}, 1, 1, 100, ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET object_key = excluded.object_key,
		  file_name = excluded.file_name, content_type = excluded.content_type,
		  size_bytes = excluded.size_bytes, checksum_sha256 = excluded.checksum_sha256,
		  download_enabled = excluded.download_enabled, updated_at = excluded.updated_at`,
			`INSERT INTO download_asset_sellable_items
		 (download_asset_id, sellable_item_id, sort_order)
		 VALUES (${q(fixture.id)}, ${q(sellableItemId)}, 100)
		 ON CONFLICT(download_asset_id, sellable_item_id) DO UPDATE SET
		  sort_order = excluded.sort_order`,
		);
	}

for (const [suffix, count] of [
	[1, 4],
	[51, 3],
	[61, 3],
	[62, 2],
	[82, 5],
	[83, 8],
] as const)
	for (let entry = 1; entry <= count; entry++) {
		const secret = `DEMO-STOCK-${suffix}-${entry}`;
		sql.push(
			`INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version,
			  content_fingerprint, content_mask, status, created_at, updated_at)
			 VALUES (${q(uuid(9, suffix * 100 + entry))}, ${q(uuid(2, suffix))},
			  ${q(await encryptSecret(secret, commerceSecret, "stock-entry"))}, 1,
			  ${q(await fingerprintInventorySecret(secret, commerceSecret))},
			  ${q(maskInventorySecret(secret))}, 'available', ${now}, ${now})
			 ON CONFLICT(id) DO NOTHING`,
		);
	}

for (const suffix of [3, 53, 58, 74, 75, 76, 77] as const)
	await addAutomationConfiguration(sql, suffix, 3, "none");
for (const suffix of [4, 54, 60, 78, 79, 80, 81] as const)
	await addAutomationConfiguration(
		sql,
		suffix,
		4,
		suffix === 60 || suffix === 79 || suffix === 80
			? "optional"
			: suffix === 78
				? "none"
				: "required",
	);

await addCustomerPurchaseFixtures(sql);
await addSupplierFixtures(sql);
sql.push(
	...(await createDhruAcceptanceStatements({
		now,
		customerUserId,
		customerEmail,
		commerceSecret,
	})),
);
await executeSql(sql.join(";\n"));
for (const catalog of supplierCatalogFixtures)
	await putKvValue(
		supplierCatalogCacheKey(catalog),
		JSON.stringify(catalog),
		86_400,
	);
const telegramUser = await seedTelegramMiniAppUser();
console.log(
	"Added a draft USD 1.00 Dhru demo service, a disabled demo account, and five service orders (GMDHRU000001–GMDHRU000005). No supplier work is queued.",
);
console.log(
	`Seeded ${paymentChannels.length} payment channels, ${products.length} example products, ${items.length} sellable items, ${customerPurchases.length} customer purchases, 3 disabled supplier accounts, 3 supplier bindings, 3 supplier orders, ${supplierCatalogFixtures.length} supplier catalog snapshots, and Telegram user ${String(telegramUser.name ?? telegramUserId)} for ${customerEmail}.${withR2 ? ` Added ${mediaFixtures.length} media objects, ${downloadFixtures.length} download objects, and one automation artifact.` : " Download products remain drafts; run with --with-r2 or upload their files in the admin UI before publishing."}\nLocal root login: ${customerEmail} / ${customerPassword}`,
);

async function seedTelegramMiniAppUser() {
	const telegramSettings = await queryRows(
		`SELECT key, value FROM system_settings WHERE key IN (
		 ${q("runtime.data_encryption_secret")},
		 ${q(authProviderSettingKeys.providers)},
		 ${q(authProviderSettingKeys.revision)},
		 ${q(authProviderSecretKey("telegram"))}
		)`,
	);
	const encryptionSecret = readSetting(
		telegramSettings,
		"runtime.data_encryption_secret",
	);
	const existingTelegramSecret = telegramSettings.find(
		(row) => row.key === authProviderSecretKey("telegram"),
	)?.value;
	if (existingTelegramSecret && !force) {
		const encrypted: unknown = JSON.parse(existingTelegramSecret);
		const existingToken =
			typeof encrypted === "string"
				? await decryptSecret(
						encrypted,
						encryptionSecret,
						authProviderSecretPurpose("telegram"),
					).catch(() => null)
				: null;
		if (existingToken !== telegramBotToken)
			throw new Error(
				"Local Telegram credentials already exist. Re-run with `bun run seed:local -- --force` only if replacing them is intentional.",
			);
	}

	const storedProviders = readJsonSetting(
		telegramSettings,
		authProviderSettingKeys.providers,
		initialStoredAuthProviders,
	);
	const providers = storedAuthProvidersSchema.parse([
		...storedProviders.filter((provider) => provider.providerId !== "telegram"),
		{
			id: telegramProviderId,
			providerId: "telegram",
			providerType: "social",
			displayName: "Telegram",
			icon: null,
			clientId: telegramBotUserId,
			scopes: ["openid", "profile"],
			allowSignup: true,
			enabled: true,
			sortOrder: 20,
		},
	]);
	const revision =
		readJsonSetting(telegramSettings, authProviderSettingKeys.revision, 1) + 1;
	const encryptedBotToken = await encryptSecret(
		telegramBotToken,
		encryptionSecret,
		authProviderSecretPurpose("telegram"),
	);

	await executeSql(
		`${upsertSetting(authProviderSettingKeys.providers, providers, false)}
${upsertSetting(authProviderSettingKeys.revision, revision, false)}
${upsertSetting(
	authProviderSettingKeys.telegramBotUserId,
	telegramBotUserId,
	false,
)}
${upsertSetting(
	authProviderSettingKeys.telegramUsername,
	telegramBotUsername,
	false,
)}
${upsertSetting(authProviderSettingKeys.telegramMiniAppEnabled, true, false)}
${upsertSetting(authProviderSecretKey("telegram"), encryptedBotToken, true)}
INSERT INTO users
 (id, name, email, email_verified, preferred_locale, image, telegram_id,
  telegram_username, enabled, role_ids, created_at, updated_at)
 VALUES (${q(uuid(22, 1))}, 'Telegram Local User', ${q(telegramEmail)}, 0,
  'zh-CN', 'https://telegram.org/img/t_logo.png', ${q(telegramUserId)},
  'local_tg_user', 1, (
   SELECT json_array(id) FROM roles
   WHERE name = ${q(storefrontCustomerRoleName)} AND built_in = 1 AND enabled = 1 LIMIT 1
  ), ${now}, ${now})
 ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  preferred_locale = excluded.preferred_locale,
  image = excluded.image,
  telegram_id = excluded.telegram_id,
  telegram_username = excluded.telegram_username,
  enabled = excluded.enabled,
  role_ids = excluded.role_ids,
  disabled_at = NULL,
  updated_at = excluded.updated_at;
INSERT INTO accounts
 (id, user_id, account_id, provider_id, telegram_id, telegram_username,
  created_at, updated_at)
 SELECT ${q(uuid(23, 1))}, id, ${q(telegramUserId)}, 'telegram',
  ${q(telegramUserId)}, 'local_tg_user', ${now}, ${now}
 FROM users WHERE email = ${q(telegramEmail)}
 ON CONFLICT(provider_id, account_id) DO UPDATE SET
  user_id = excluded.user_id,
  telegram_id = excluded.telegram_id,
  telegram_username = excluded.telegram_username,
  updated_at = excluded.updated_at;`,
	);

	const [user] = await queryRows(
		`SELECT u.id, u.name, u.email, u.telegram_id, u.telegram_username
		 FROM users u
		 JOIN accounts a ON a.user_id = u.id AND a.provider_id = 'telegram'
		 WHERE u.email = ${q(telegramEmail)}
		 LIMIT 1`,
	);
	if (!user)
		throw new Error("Telegram Mini App fixture has no canonical user.");
	return user;
}

function upsertSetting(key: string, value: unknown, isSecret: boolean) {
	return `INSERT INTO system_settings
	 (key, value, is_secret, created_at, updated_at)
	 VALUES (${q(key)}, ${q(JSON.stringify(value))}, ${isSecret ? 1 : 0}, ${now}, ${now})
	 ON CONFLICT(key) DO UPDATE SET
	  value = excluded.value,
	  is_secret = excluded.is_secret,
	  updated_at = excluded.updated_at;`;
}

function readJsonSetting<T>(rows: QueryRow[], key: string, fallback: T): T {
	const raw = rows.find((row) => row.key === key)?.value;
	if (!raw) return fallback;
	return JSON.parse(raw) as T;
}

function product(
	suffix: number,
	productType: "stock" | "download" | "automation",
	name: string,
	description: string,
	sortOrder: number,
	status: "active" | "draft" = "active",
) {
	return {
		id: uuid(1, suffix),
		productType,
		name,
		description,
		sortOrder,
		status,
	};
}

function sellableItem(
	suffix: number,
	productSuffix: number,
	componentSuffix: number,
	name: string,
	priceMinor: string,
	sortOrder: number,
	maximumQuantity: number,
	currency = "USD",
) {
	return {
		id: uuid(2, suffix),
		productId: uuid(1, productSuffix),
		componentId: uuid(3, componentSuffix),
		name,
		priceMinor,
		sortOrder,
		maximumQuantity,
		currency,
	};
}

function component(
	suffix: number,
	productSuffix: number,
	type: "stock" | "download" | "automation",
	policy: {
		durationMs?: number;
		usageLimit?: number;
		accessLimit?: number;
		lowStockThreshold?: number;
	},
) {
	return {
		id: uuid(3, suffix),
		productId: uuid(1, productSuffix),
		type,
		durationMs: policy.durationMs ?? null,
		usageLimit: policy.usageLimit ?? null,
		accessLimit: policy.accessLimit ?? null,
		lowStockThreshold: policy.lowStockThreshold ?? 5,
	};
}

function customerPurchase(
	suffix: number,
	productSuffix: number,
	itemSuffix: number,
	status: "active" | "exhausted" | "expired",
	ageDays: number,
	counts: { usageCount: number; accessCount: number },
) {
	const productRow = products.find((row) => row.id === uuid(1, productSuffix));
	const item = items.find((row) => row.id === uuid(2, itemSuffix));
	const delivery = componentsById.get(uuid(3, itemSuffix));
	if (
		!productRow ||
		!item ||
		!delivery ||
		item.productId !== productRow.id ||
		delivery.productId !== productRow.id
	)
		throw new Error(`Customer purchase fixture ${suffix} is inconsistent.`);
	const createdAt = now - ageDays * 86_400_000;
	const paidAt = createdAt + 60_000;
	const activatedAt = paidAt + 60_000;
	const completedAt = activatedAt + 60_000;
	const expiresAt =
		delivery.durationMs === null ? null : activatedAt + delivery.durationMs;
	if (
		counts.usageCount < 0 ||
		counts.accessCount < 0 ||
		(delivery.usageLimit !== null && counts.usageCount > delivery.usageLimit) ||
		(delivery.accessLimit !== null && counts.accessCount > delivery.accessLimit)
	)
		throw new Error(`Customer purchase fixture ${suffix} has invalid counts.`);
	if (
		status === "active" &&
		((expiresAt !== null && expiresAt <= now) ||
			(delivery.usageLimit !== null &&
				counts.usageCount >= delivery.usageLimit) ||
			(delivery.accessLimit !== null &&
				counts.accessCount >= delivery.accessLimit))
	)
		throw new Error(`Customer purchase fixture ${suffix} is not active.`);
	if (status === "expired" && (expiresAt === null || expiresAt > now))
		throw new Error(`Customer purchase fixture ${suffix} is not expired.`);
	if (
		status === "exhausted" &&
		!(
			(delivery.usageLimit !== null &&
				counts.usageCount >= delivery.usageLimit) ||
			(delivery.accessLimit !== null &&
				counts.accessCount >= delivery.accessLimit)
		)
	)
		throw new Error(`Customer purchase fixture ${suffix} is not exhausted.`);
	return {
		suffix,
		orderId: uuid(14, suffix),
		orderItemId: uuid(15, suffix),
		entitlementId: uuid(16, suffix),
		grantId: uuid(17, suffix),
		deliveryId: uuid(18, suffix),
		orderNumber: `GMDEMO${suffix.toString().padStart(8, "0")}`,
		productId: productRow.id,
		productName: productRow.name,
		productType: productRow.productType,
		sellableItemId: item.id,
		sellableItemName: item.name,
		priceMinor: item.priceMinor,
		durationMs: delivery.durationMs,
		usageLimit: delivery.usageLimit,
		usageCount: counts.usageCount,
		accessLimit: delivery.accessLimit,
		accessCount: counts.accessCount,
		definitionVersionId:
			productRow.productType === "automation" ? uuid(8, itemSuffix) : null,
		status,
		createdAt,
		paidAt,
		activatedAt,
		completedAt,
		expiresAt,
	};
}

function downloadFixture(
	productSuffix: number,
	componentSuffix: number,
	fileName: string,
) {
	const id = uuid(4, componentSuffix);
	const body = new TextEncoder().encode(
		`GMShop Edge example download\nProduct ${productSuffix}\n`,
	);
	return {
		id,
		productId: uuid(1, productSuffix),
		componentId: uuid(3, componentSuffix),
		objectKey: `downloads/${uuid(1, productSuffix)}/${id}`,
		fileName,
		body,
		checksum: createHash("sha256").update(body).digest("hex"),
	};
}

function mediaFixture(
	productSuffix: number,
	mediaSuffix: number,
	color: [number, number, number],
) {
	const id = uuid(5, mediaSuffix);
	const productId = uuid(1, productSuffix);
	return {
		id,
		productId,
		objectKey: `products/${productId}/media/${id}.png`,
		altText: `商品展示图 ${mediaSuffix}`,
		body: createPng(160, 90, color),
		sortOrder: mediaSuffix * 10,
	};
}

async function addAutomationConfiguration(
	sql: string[],
	componentSuffix: number,
	productSuffix: number,
	artifactPolicy: "none" | "optional" | "required",
) {
	const versionId = uuid(8, componentSuffix);
	const methodId = uuid(7, componentSuffix);
	const definitions = automationInputDefinitions();
	const credential = await encryptBuildConfigSecret(
		"demo-automation-token-not-real",
		commerceSecret,
	);
	sql.push(
		`INSERT INTO product_definition_versions
		 (id, product_id, sellable_item_id, version, schema_json, published_at,
		  created_at, updated_at)
		 VALUES (${q(versionId)}, ${q(uuid(1, productSuffix))},
		  ${q(uuid(2, componentSuffix))}, 1, ${q(JSON.stringify(definitions))},
		  ${now}, ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET schema_json = excluded.schema_json,
		  published_at = excluded.published_at,
		  updated_at = excluded.updated_at`,
		`UPDATE product_sellable_items SET
		  automation_provider = 'github_actions',
		  automation_base_url = 'https://api.github.com',
		  automation_repository_owner = 'gmshop-edge',
		  automation_repository_name = 'example-automation',
		  automation_default_branch = 'main',
		  automation_workflow_file = 'automation.yml',
		  automation_credential_encrypted = ${q(credential)},
		  automation_credential_key_version = 1,
		  version = 1,
		  active_definition_version_id = ${q(versionId)},
		  enabled = 1, updated_at = ${now}
		 WHERE id = ${q(uuid(2, componentSuffix))}`,
		`INSERT INTO product_automation_methods
		 (id, sellable_item_id, config_version, key, name, description, runtime,
		  branch, command, artifact_policy, output_pattern, sort_order, enabled,
		  created_at, updated_at)
		 VALUES (${q(methodId)}, ${q(uuid(2, componentSuffix))}, 1, 'run', '执行自动化',
		  '标准自动化任务', 'ubuntu-latest', 'main', 'bun run automate',
		  ${q(artifactPolicy)}, ${q(artifactPolicy === "none" ? "" : "dist/*.zip")},
		  100, 1, ${now}, ${now})
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
		  description = excluded.description, runtime = excluded.runtime,
		  branch = excluded.branch, command = excluded.command,
		  artifact_policy = excluded.artifact_policy,
		  output_pattern = excluded.output_pattern, enabled = excluded.enabled,
		  updated_at = excluded.updated_at`,
	);
}

async function addSupplierFixtures(sql: string[]) {
	const accounts = [
		{
			id: uuid(30, 1),
			provider: "acg" as const,
			baseUrl: "https://acg.example.invalid",
			protocolVersion: "3.5.5-v4",
			name: "异次元演示账号",
			credentials: {
				apiId: "demo-acg-api-id",
				appKey: "demo-acg-app-key-not-real",
			},
			balanceMinor: "128800",
			healthStatus: "healthy",
			failures: 0,
			lastErrorCode: null,
		},
		{
			id: uuid(30, 2),
			provider: "dujiao_next" as const,
			baseUrl: "https://dujiao.example.invalid",
			protocolVersion: "1.3.1-upstream-v1",
			name: "独角数卡演示账号 A",
			credentials: {
				apiKey: "demo-dujiao-api-key-a",
				apiSecret: "demo-dujiao-secret-a-not-real",
			},
			balanceMinor: "256000",
			healthStatus: "degraded",
			failures: 2,
			lastErrorCode: "supplier_demo_rate_limited",
		},
		{
			id: uuid(30, 3),
			provider: "dujiao_next" as const,
			baseUrl: "https://dujiao.example.invalid",
			protocolVersion: "1.3.1-upstream-v1",
			name: "独角数卡演示账号 B",
			credentials: {
				apiKey: "demo-dujiao-api-key-b",
				apiSecret: "demo-dujiao-secret-b-not-real",
			},
			balanceMinor: "64000",
			healthStatus: "unavailable",
			failures: 5,
			lastErrorCode: "supplier_demo_maintenance",
		},
	] as const;

	for (const account of accounts) {
		const encrypted = await createSupplierCredentialVault(
			account.provider,
			account.credentials,
			commerceSecret,
		);
		const fingerprint = await supplierCredentialFingerprint(
			account.provider,
			account.credentials,
			commerceSecret,
		);
		sql.push(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, balance_minor,
			  balance_synced_at, reserve_balance_minor, low_balance_minor,
			  max_order_cost_minor, health_status, consecutive_failures,
			  last_error_code, last_error_at, enabled, created_at, updated_at)
			 VALUES (${q(account.id)}, ${q(account.provider)}, ${q(account.baseUrl)},
			  ${q(account.baseUrl)}, ${q(account.protocolVersion)}, 'CNY', 2,
			  ${q(account.name)}, ${q(encrypted)}, 1, ${q(fingerprint)},
			  ${q(account.balanceMinor)}, ${now - 300_000}, '1000', '5000',
			  '100000', ${q(account.healthStatus)}, ${account.failures},
			  ${q(account.lastErrorCode)}, ${q(account.lastErrorCode ? now - 600_000 : null)},
			  0, ${now - 7 * 86_400_000}, ${now})
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
			  credentials_encrypted = excluded.credentials_encrypted,
			  credential_fingerprint = excluded.credential_fingerprint,
			  balance_minor = excluded.balance_minor,
			  balance_synced_at = excluded.balance_synced_at,
			  health_status = excluded.health_status,
			  consecutive_failures = excluded.consecutive_failures,
			  last_error_code = excluded.last_error_code,
			  last_error_at = excluded.last_error_at, enabled = 0,
			  updated_at = excluded.updated_at`,
		);
	}

	const bindings = [
		{
			id: uuid(31, 1),
			itemSuffix: 201,
			provider: "acg",
			origin: "https://acg.example.invalid",
			protocolVersion: "3.5.5-v4",
			productId: "demo-acg-product-1",
			skuId: "demo-acg-sku-standard",
			productName: "异次元演示卡密",
			skuName: "标准版",
			referenceCostMinor: "990",
			maxCostMinor: "1190",
			stockQuantity: 88,
			remoteStatus: "active",
			lastErrorCode: null,
		},
		{
			id: uuid(31, 2),
			itemSuffix: 202,
			provider: "dujiao_next",
			origin: "https://dujiao.example.invalid",
			protocolVersion: "1.3.1-upstream-v1",
			productId: "demo-dujiao-product-1",
			skuId: "demo-dujiao-sku-month",
			productName: "独角数卡演示会员",
			skuName: "月卡",
			referenceCostMinor: "1590",
			maxCostMinor: "1890",
			stockQuantity: 36,
			remoteStatus: "active",
			lastErrorCode: null,
		},
		{
			id: uuid(31, 3),
			itemSuffix: 203,
			provider: "dujiao_next",
			origin: "https://dujiao.example.invalid",
			protocolVersion: "1.3.1-upstream-v1",
			productId: "demo-dujiao-product-1",
			skuId: "demo-dujiao-sku-quarter",
			productName: "独角数卡演示会员",
			skuName: "季卡",
			referenceCostMinor: "3990",
			maxCostMinor: "3890",
			stockQuantity: 0,
			remoteStatus: "inactive",
			lastErrorCode: "supplier_cost_limit_exceeded",
		},
	] as const;

	for (const binding of bindings)
		sql.push(
			`UPDATE product_sellable_items SET fulfillment_source = 'supplier',
			  supplier_status = ${q(binding.remoteStatus === "active" ? "available" : "unavailable")},
			  cost_minor = ${q(binding.referenceCostMinor)}, updated_at = ${now}
			 WHERE id = ${q(uuid(2, binding.itemSuffix))}`,
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  last_error_code, enabled, created_at, updated_at)
			 VALUES (${q(binding.id)}, ${q(uuid(2, binding.itemSuffix))},
			  ${q(binding.provider)}, ${q(binding.origin)},
			  ${q(binding.protocolVersion)}, ${q(binding.productId)},
			  ${q(binding.skuId)}, ${q(binding.productName)}, ${q(binding.skuName)},
			  ${q(binding.referenceCostMinor)}, ${q(binding.maxCostMinor)},
			  ${binding.stockQuantity}, ${q(binding.remoteStatus)},
			  ${now - 600_000}, ${q(binding.lastErrorCode)}, 1,
			  ${now - 7 * 86_400_000}, ${now})
			 ON CONFLICT(id) DO UPDATE SET upstream_product_name = excluded.upstream_product_name,
			  upstream_sku_name = excluded.upstream_sku_name,
			  reference_cost_minor = excluded.reference_cost_minor,
			  max_cost_minor = excluded.max_cost_minor,
			  stock_quantity = excluded.stock_quantity,
			  remote_status = excluded.remote_status,
			  last_synced_at = excluded.last_synced_at,
			  last_error_code = excluded.last_error_code,
			  enabled = excluded.enabled, updated_at = excluded.updated_at`,
		);

	const supplierOrderFixtures = [
		{
			suffix: 1,
			itemSuffix: 201,
			bindingId: bindings[0].id,
			accountId: accounts[0].id,
			state: "supplied",
			orderStatus: "completed",
			deliveryStatus: "delivered",
			unitCostMinor: "990",
			upstreamOrderId: "ACG-DEMO-ORDER-1001",
			lastErrorCode: null,
		},
		{
			suffix: 2,
			itemSuffix: 202,
			bindingId: bindings[1].id,
			accountId: accounts[1].id,
			state: "uncertain",
			orderStatus: "fulfilling",
			deliveryStatus: "awaiting_supply",
			unitCostMinor: "1590",
			upstreamOrderId: "DUJIAO-DEMO-ORDER-2001",
			lastErrorCode: "supplier_result_uncertain",
		},
		{
			suffix: 3,
			itemSuffix: 203,
			bindingId: bindings[2].id,
			accountId: accounts[2].id,
			state: "failed",
			orderStatus: "failed",
			deliveryStatus: "failed",
			unitCostMinor: "3990",
			upstreamOrderId: null,
			lastErrorCode: "supplier_cost_limit_exceeded",
		},
	] as const;

	for (const fixture of supplierOrderFixtures) {
		const item = items.find(
			(candidate) => candidate.id === uuid(2, fixture.itemSuffix),
		);
		if (!item)
			throw new Error(`Supplier item ${fixture.itemSuffix} is missing.`);
		const productRow = products.find(
			(candidate) => candidate.id === item.productId,
		);
		if (!productRow)
			throw new Error(`Supplier product ${item.productId} is missing.`);
		const createdAt = now - fixture.suffix * 86_400_000;
		const orderId = uuid(32, fixture.suffix);
		const orderItemId = uuid(33, fixture.suffix);
		const deliveryId = uuid(34, fixture.suffix);
		const supplierOrderId = uuid(35, fixture.suffix);
		const requestNo = `GM-SUPPLIER-DEMO-${fixture.suffix}`;
		const suppliedAt =
			fixture.state === "supplied" ? createdAt + 180_000 : null;
		sql.push(
			`INSERT INTO shop_orders
			 (id, order_number, idempotency_key, user_id, contact_email,
			  normalized_contact_email, locale, status, currency,
			  currency_decimals, subtotal_minor, discount_minor, total_minor,
			  paid_minor, version, expires_at, paid_at, completed_at,
			  created_at, updated_at)
			 VALUES (${q(orderId)}, ${q(`GMSUPPLIER${fixture.suffix.toString().padStart(6, "0")}`)},
			  ${q(`seed:supplier-order:${fixture.suffix}`)}, ${q(customerUserId)},
			  ${q(customerEmail)}, ${q(customerEmail)}, 'zh-CN',
			  ${q(fixture.orderStatus)}, 'CNY', 2, ${q(item.priceMinor)}, '0',
			  ${q(item.priceMinor)}, ${q(item.priceMinor)}, 3,
			  ${createdAt + 1_800_000}, ${createdAt + 60_000}, ${q(suppliedAt)},
			  ${createdAt}, ${now})
			 ON CONFLICT(id) DO UPDATE SET status = excluded.status,
			  completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, input_values_json,
			  sensitive_input_values_json, quantity, unit_price_minor,
			  unit_cost_minor, discount_minor, subtotal_minor,
			  activation_trigger, exhaustion_rule, renewal_mode,
			  show_on_order_page, account_library_enabled, email_mode,
			  allow_resend, created_at, updated_at)
			 VALUES (${q(orderItemId)}, ${q(orderId)}, ${q(item.productId)},
			  ${q(item.id)}, ${q(productRow.name)}, ${q(item.id)}, 'stock', 1,
			  ${q(item.name)}, '{}', '{}', 1, ${q(item.priceMinor)},
			  ${q(fixture.unitCostMinor)}, '0', ${q(item.priceMinor)},
			  'delivery_completed', 'first_limit_reached', 'stack',
			  1, 1, 'none', 1, ${createdAt}, ${now})
			 ON CONFLICT(id) DO UPDATE SET product_name = excluded.product_name,
			  sellable_item_name = excluded.sellable_item_name,
			  unit_cost_minor = excluded.unit_cost_minor,
			  updated_at = excluded.updated_at`,
			`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, request_key, status,
			  attempt_count, delivered_at, error_code, created_at, updated_at)
			 VALUES (${q(deliveryId)}, ${q(orderItemId)}, 'stock',
			  ${q(`seed:supplier-delivery:${fixture.suffix}`)},
			  ${q(fixture.deliveryStatus)}, 1, ${q(suppliedAt)},
			  ${q(fixture.lastErrorCode)}, ${createdAt + 60_000}, ${now})
			 ON CONFLICT(id) DO UPDATE SET status = excluded.status,
			  delivered_at = excluded.delivered_at,
			  error_code = excluded.error_code, updated_at = excluded.updated_at`,
			`INSERT INTO supplier_orders
			 (id, order_id, order_item_id, delivery_record_id,
			  supplier_binding_id, selected_account_id,
			  selected_credentials_revision, provider_request_no,
			  upstream_order_id, quantity, quoted_unit_cost_minor,
			  total_cost_minor, currency, binding_snapshot_json, state,
			  attempt_count, selection_count, account_locked_at,
			  last_error_code, last_error_message_redacted, submitted_at,
			  supplied_at, created_at, updated_at)
			 VALUES (${q(supplierOrderId)}, ${q(orderId)}, ${q(orderItemId)},
			  ${q(deliveryId)}, ${q(fixture.bindingId)}, ${q(fixture.accountId)},
			  1, ${q(requestNo)}, ${q(fixture.upstreamOrderId)}, 1,
			  ${q(fixture.unitCostMinor)}, ${q(fixture.unitCostMinor)}, 'CNY',
			  ${q(JSON.stringify({ fixture: true, itemSuffix: fixture.itemSuffix }))},
			  ${q(fixture.state)}, ${fixture.suffix}, 1,
			  ${fixture.state === "uncertain" ? createdAt + 120_000 : "NULL"},
			  ${q(fixture.lastErrorCode)}, ${q(fixture.lastErrorCode)},
			  ${createdAt + 120_000}, ${q(suppliedAt)}, ${createdAt + 60_000}, ${now})
			 ON CONFLICT(id) DO UPDATE SET state = excluded.state,
			  upstream_order_id = excluded.upstream_order_id,
			  last_error_code = excluded.last_error_code,
			  last_error_message_redacted = excluded.last_error_message_redacted,
			  supplied_at = excluded.supplied_at, updated_at = excluded.updated_at`,
		);
	}

	sql.push(
		`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
		 VALUES ('suppliers.sync.config',
		  ${q(JSON.stringify({ enabled: false, intervalMs: 600_000 }))},
		  0, ${now}, ${now})
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
		  is_secret = 0, updated_at = excluded.updated_at`,
		`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
		 VALUES ('suppliers.sync.status',
		  ${q(JSON.stringify({ lastSyncedAt: now - 600_000, lastStatus: "succeeded", lastErrorCode: null }))},
		  0, ${now}, ${now})
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
		  is_secret = 0, updated_at = excluded.updated_at`,
	);
}

async function addCustomerPurchaseFixtures(sql: string[]) {
	const stockPurchase = customerPurchases.find(
		(purchase) => purchase.productType === "stock",
	);
	if (!stockPurchase) throw new Error("Stock customer fixture is required.");
	const stockSecret = "DEMO-LICENSE-2026-ALPHA";
	const stockEncrypted = await encryptSecret(
		stockSecret,
		commerceSecret,
		"stock-entry",
	);
	const deliveryEncrypted = await encryptDeliveryContent(
		stockSecret,
		commerceSecret,
	);

	for (const purchase of customerPurchases) {
		sql.push(
			`INSERT INTO shop_orders
			 (id, order_number, idempotency_key, user_id, contact_email,
			  normalized_contact_email, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor, version,
			  expires_at, paid_at, completed_at, created_at, updated_at)
			 VALUES (${q(purchase.orderId)}, ${q(purchase.orderNumber)},
			  ${q(`seed:customer-order:${purchase.suffix}`)}, ${q(customerUserId)},
			  ${q(customerEmail)}, ${q(customerEmail)}, 'completed', 'USD', 2,
			  ${q(purchase.priceMinor)}, '0', ${q(purchase.priceMinor)},
			  ${q(purchase.priceMinor)}, 3, ${purchase.createdAt + 1_800_000},
			  ${purchase.paidAt}, ${purchase.completedAt}, ${purchase.createdAt},
			  ${purchase.completedAt})
			 ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id,
			  contact_email = excluded.contact_email,
			  normalized_contact_email = excluded.normalized_contact_email,
			  status = excluded.status, subtotal_minor = excluded.subtotal_minor,
			  total_minor = excluded.total_minor, paid_minor = excluded.paid_minor,
			  version = excluded.version, expires_at = excluded.expires_at,
			  paid_at = excluded.paid_at, completed_at = excluded.completed_at,
			  updated_at = excluded.updated_at`,
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, definition_version_id,
			  input_values_json, sensitive_input_values_json, quantity,
			  unit_price_minor, discount_minor, subtotal_minor, duration_ms,
			  usage_limit, access_limit, activation_trigger, exhaustion_rule,
			  renewal_mode, show_on_order_page, account_library_enabled,
			  email_mode, allow_resend, created_at, updated_at)
			 VALUES (${q(purchase.orderItemId)}, ${q(purchase.orderId)},
			  ${q(purchase.productId)}, ${q(purchase.sellableItemId)},
			  ${q(purchase.productName)}, ${q(purchase.sellableItemId)},
			  ${q(purchase.productType)}, 1, ${q(purchase.sellableItemName)},
			  ${q(purchase.definitionVersionId)}, '{}', '{}', 1,
			  ${q(purchase.priceMinor)}, '0', ${q(purchase.priceMinor)},
			  ${q(purchase.durationMs)}, ${q(purchase.usageLimit)},
			  ${q(purchase.accessLimit)}, 'delivery_completed',
			  'first_limit_reached', 'stack', 1, 1, 'none', 1,
			  ${purchase.createdAt}, ${purchase.completedAt})
			 ON CONFLICT(id) DO UPDATE SET product_name = excluded.product_name,
			  sellable_item_name = excluded.sellable_item_name,
			  definition_version_id = excluded.definition_version_id,
			  duration_ms = excluded.duration_ms,
			  usage_limit = excluded.usage_limit,
			  access_limit = excluded.access_limit,
			  updated_at = excluded.updated_at`,
			`INSERT INTO customer_entitlements
			 (id, user_id, order_item_id, product_id, sellable_item_id,
			  delivery_component_id, entitlement_type, status,
			  definition_version_id, usage_limit, usage_count, access_limit,
			  access_count, activated_at, expires_at, created_at, updated_at)
			 VALUES (${q(purchase.entitlementId)}, ${q(customerUserId)},
			  ${q(purchase.orderItemId)}, ${q(purchase.productId)},
			  ${q(purchase.sellableItemId)}, ${q(purchase.sellableItemId)},
			  ${q(purchase.productType)}, ${q(purchase.status)},
			  ${q(purchase.definitionVersionId)}, ${q(purchase.usageLimit)},
			  ${purchase.usageCount}, ${q(purchase.accessLimit)},
			  ${purchase.accessCount}, ${purchase.activatedAt},
			  ${q(purchase.expiresAt)}, ${purchase.activatedAt}, ${now})
			 ON CONFLICT(id) DO UPDATE SET status = excluded.status,
			  definition_version_id = excluded.definition_version_id,
			  usage_limit = excluded.usage_limit,
			  usage_count = excluded.usage_count,
			  access_limit = excluded.access_limit,
			  access_count = excluded.access_count,
			  activated_at = excluded.activated_at,
			  expires_at = excluded.expires_at, revoked_at = NULL,
			  updated_at = excluded.updated_at`,
			`INSERT INTO entitlement_grants
			 (id, entitlement_id, source_order_item_id, status, duration_ms,
			  usage_granted, access_granted, activated_at, applied_at,
			  created_at, updated_at)
			 VALUES (${q(purchase.grantId)}, ${q(purchase.entitlementId)},
			  ${q(purchase.orderItemId)}, 'active', ${q(purchase.durationMs)},
			  ${q(purchase.usageLimit)}, ${q(purchase.accessLimit)},
			  ${purchase.activatedAt}, ${purchase.activatedAt},
			  ${purchase.activatedAt}, ${purchase.activatedAt})
			 ON CONFLICT(id) DO UPDATE SET status = excluded.status,
			  duration_ms = excluded.duration_ms,
			  usage_granted = excluded.usage_granted,
			  access_granted = excluded.access_granted,
			  activated_at = excluded.activated_at,
			  applied_at = excluded.applied_at, revoked_at = NULL,
			  revocation_reason = NULL, updated_at = excluded.updated_at`,
			`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, request_key, status,
			  content_encrypted, content_key_version, attempt_count,
			  delivered_at, created_at, updated_at)
			 VALUES (${q(purchase.deliveryId)}, ${q(purchase.orderItemId)},
			  ${q(purchase.productType)}, ${q(`seed:delivery:${purchase.suffix}`)},
			  'delivered',
			  ${q(purchase.productType === "stock" ? deliveryEncrypted : null)},
			  ${q(purchase.productType === "stock" ? 1 : null)}, 1,
			  ${purchase.activatedAt}, ${purchase.paidAt}, ${purchase.activatedAt})
			 ON CONFLICT(id) DO UPDATE SET status = excluded.status,
			  content_encrypted = excluded.content_encrypted,
			  content_key_version = excluded.content_key_version,
			  attempt_count = excluded.attempt_count,
			  delivered_at = excluded.delivered_at,
			  error_code = NULL, updated_at = excluded.updated_at`,
		);
		for (const [index, eventType] of [
			"order_created",
			"payment_succeeded",
			"fulfillment_completed",
		].entries())
			sql.push(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, actor_type, created_at)
				 VALUES (${q(uuid(19, purchase.suffix * 10 + index + 1))},
				  ${q(purchase.orderId)}, ${q(eventType)}, 'customer',
				  ${q(eventType === "payment_succeeded" ? "provider" : "system")},
				  ${purchase.createdAt + index * 60_000})
				 ON CONFLICT(id) DO NOTHING`,
			);
		if (purchase.productType === "download")
			addDownloadPurchaseFixture(sql, purchase);
	}

	sql.push(
		`INSERT INTO stock_entries
		 (id, sellable_item_id, content_encrypted, key_version,
		  content_fingerprint, content_mask, status, order_item_id,
		  reserved_at, delivered_at, created_at, updated_at)
		 VALUES (${q(uuid(24, 1))}, ${q(stockPurchase.sellableItemId)},
		  ${q(stockEncrypted)}, 1,
		  ${q(await fingerprintInventorySecret(stockSecret, commerceSecret))},
		  ${q(maskInventorySecret(stockSecret))}, 'delivered',
		  ${q(stockPurchase.orderItemId)}, ${stockPurchase.paidAt},
		  ${stockPurchase.activatedAt}, ${stockPurchase.createdAt},
		  ${stockPurchase.activatedAt})
		 ON CONFLICT(id) DO UPDATE SET content_encrypted = excluded.content_encrypted,
		  key_version = excluded.key_version,
		  content_fingerprint = excluded.content_fingerprint,
		  content_mask = excluded.content_mask, status = excluded.status,
		  order_item_id = excluded.order_item_id,
		  reserved_at = excluded.reserved_at,
		  delivered_at = excluded.delivered_at,
		  updated_at = excluded.updated_at`,
	);

	await addAutomationHistoryFixtures(sql);
}

function addDownloadPurchaseFixture(
	sql: string[],
	purchase: (typeof customerPurchases)[number],
) {
	const fixture = downloadFixtures.find(
		(download) =>
			sellableItemIdByComponent.get(download.componentId) ===
			purchase.sellableItemId,
	);
	if (!fixture)
		throw new Error(
			`Download fixture for ${purchase.sellableItemId} is missing.`,
		);
	sql.push(
		`INSERT INTO order_item_download_assets
		 (id, order_item_id, download_asset_id, asset_version, object_key,
		  file_name, content_type, size_bytes, checksum_sha256,
		  created_at, updated_at)
		 SELECT ${q(uuid(23, purchase.suffix))}, ${q(purchase.orderItemId)},
		  id, version, object_key, file_name, content_type, size_bytes,
		  checksum_sha256, ${purchase.activatedAt}, ${purchase.activatedAt}
		 FROM download_assets WHERE id = ${q(fixture.id)}
		 ON CONFLICT(id) DO UPDATE SET object_key = excluded.object_key,
		  file_name = excluded.file_name, content_type = excluded.content_type,
		  size_bytes = excluded.size_bytes,
		  checksum_sha256 = excluded.checksum_sha256,
		  updated_at = excluded.updated_at`,
	);
	for (let access = 1; access <= purchase.accessCount; access++)
		sql.push(
			`INSERT INTO entitlement_events
			 (id, kind, entitlement_id, event_type, asset_type, asset_id,
			  consumed, actor_type, created_at)
			 VALUES (${q(uuid(25, purchase.suffix * 100 + access))}, 'access',
			  ${q(purchase.entitlementId)}, 'downloaded', 'download_asset',
			  ${q(fixture.id)}, 1, 'customer',
			  ${purchase.activatedAt + access * 60_000})
			 ON CONFLICT(id) DO NOTHING`,
		);
}

async function addAutomationHistoryFixtures(sql: string[]) {
	const callbackEncrypted = await encryptAutomationCallbackSecret(
		"demo-automation-callback-secret",
		commerceSecret,
	);
	const regionEncrypted = await encryptBuildInput("ap-east-1", commerceSecret);
	const tokenEncrypted = await encryptBuildInput(
		"token_demo_automation",
		commerceSecret,
	);
	const histories = [
		{
			purchaseSuffix: 5,
			itemSuffix: 60,
			artifactPolicy: "optional",
			jobs: [
				{ suffix: 6_001, status: "succeeded", failureCode: null },
				{ suffix: 6_002, status: "failed", failureCode: "provider_failed" },
			],
		},
		{
			purchaseSuffix: 6,
			itemSuffix: 58,
			artifactPolicy: "none",
			jobs: [{ suffix: 5_801, status: "succeeded", failureCode: null }],
		},
		{
			purchaseSuffix: 7,
			itemSuffix: 77,
			artifactPolicy: "none",
			jobs: [{ suffix: 7_701, status: "succeeded", failureCode: null }],
		},
	] as const;
	for (const history of histories) {
		const purchase = customerPurchases.find(
			(candidate) => candidate.suffix === history.purchaseSuffix,
		);
		if (!purchase || purchase.productType !== "automation")
			throw new Error(
				`Automation purchase ${history.purchaseSuffix} is missing.`,
			);
		const regionValueId = uuid(22, purchase.suffix * 10 + 1);
		const tokenValueId = uuid(22, purchase.suffix * 10 + 2);
		for (const [id, definitionKey, encrypted, masked] of [
			[regionValueId, "region", regionEncrypted, "ap••••-1"],
			[tokenValueId, "access_token", tokenEncrypted, "to••••on"],
		] as const)
			sql.push(
				`INSERT INTO entitlement_authorization_values
				 (id, entitlement_id, definition_key, value_encrypted,
				  key_version, masked_value, created_at, updated_at)
				 VALUES (${q(id)}, ${q(purchase.entitlementId)},
				  ${q(definitionKey)}, ${q(encrypted)}, 1, ${q(masked)},
				  ${purchase.activatedAt}, ${now})
				 ON CONFLICT(entitlement_id, definition_key) DO UPDATE SET
				  value_encrypted = excluded.value_encrypted,
				  key_version = excluded.key_version,
				  masked_value = excluded.masked_value,
				  updated_at = excluded.updated_at`,
			);
		for (const [index, job] of history.jobs.entries()) {
			const jobId = uuid(20, job.suffix);
			const jobCreatedAt = purchase.activatedAt + (index + 1) * 86_400_000;
			const inputsJson = JSON.stringify({
				project_name: { value: `demo-project-${purchase.suffix}` },
				environment: { value: "staging" },
				region: {
					authorizationValueId: regionValueId,
					maskedValue: "ap••••-1",
				},
				access_token: {
					authorizationValueId: tokenValueId,
					maskedValue: "to••••on",
				},
				replicas: { value: "2" },
				features: { value: JSON.stringify(["cache", "monitoring"]) },
				dry_run: { value: "false" },
			});
			sql.push(
				`INSERT INTO automation_jobs
				 (id, entitlement_id, order_item_id, sellable_item_id,
				  automation_method_id, definition_version_id, provider,
				  provider_base_url, repository_owner, repository_name, branch,
				  workflow_file, method_key, runtime, command, artifact_policy,
				  output_pattern, callback_secret_encrypted,
				  callback_secret_key_version, idempotency_key,
				  notification_channel, status, provider_job_id, attempt_count,
				  timeout_at, started_at, completed_at, run_url, failure_code,
				  inputs_json, sensitive_inputs_json, created_at, updated_at)
				 VALUES (${q(jobId)}, ${q(purchase.entitlementId)},
				  ${q(purchase.orderItemId)}, ${q(purchase.sellableItemId)},
				  ${q(uuid(7, history.itemSuffix))},
				  ${q(uuid(8, history.itemSuffix))}, 'github_actions',
				  'https://api.github.com', 'gmshop-edge', 'example-automation',
				  'main', 'automation.yml', 'run', 'ubuntu-latest',
				  'bun run automate', ${q(history.artifactPolicy)},
				  ${q(history.artifactPolicy === "none" ? "" : "dist/*.zip")},
				  ${q(callbackEncrypted)}, 1, ${q(`seed:automation:${job.suffix}`)},
				  'none', ${q(job.status)}, ${q(`demo-${job.suffix}`)}, 1,
				  ${jobCreatedAt + 86_400_000}, ${jobCreatedAt + 30_000},
				  ${jobCreatedAt + 120_000},
				  ${q(`https://github.com/gmshop-edge/example-automation/actions/runs/${job.suffix}`)},
				  ${q(job.failureCode)}, ${q(inputsJson)}, '{}',
				  ${jobCreatedAt}, ${jobCreatedAt + 120_000})
				 ON CONFLICT(id) DO UPDATE SET status = excluded.status,
				  provider_job_id = excluded.provider_job_id,
				  attempt_count = excluded.attempt_count,
				  completed_at = excluded.completed_at,
				  run_url = excluded.run_url,
				  failure_code = excluded.failure_code,
				  inputs_json = excluded.inputs_json,
				  sensitive_inputs_json = excluded.sensitive_inputs_json,
				  updated_at = excluded.updated_at`,
				`INSERT INTO entitlement_events
				 (id, kind, entitlement_id, event_type, amount, source_type,
				  source_id, idempotency_key, created_at)
				 VALUES (${q(uuid(26, job.suffix))}, 'usage',
				  ${q(purchase.entitlementId)}, 'consumed', 1,
				  'automation_job', ${q(jobId)},
				  ${q(`seed:entitlement-usage:${job.suffix}`)}, ${jobCreatedAt})
				 ON CONFLICT(id) DO NOTHING`,
			);
		}
	}
	const automationPurchase = customerPurchases.find(
		(purchase) => purchase.suffix === 5,
	);
	if (!automationPurchase)
		throw new Error("Automation artifact purchase is missing.");
	sql.push(
		`INSERT INTO automation_artifacts
			 (id, automation_job_id, object_key, file_name, content_type,
			  size_bytes, checksum_sha256, upload_status, download_enabled,
			  download_count, delete_after, created_at, updated_at)
			 VALUES (${q(automationArtifactFixture.id)},
			  ${q(automationArtifactFixture.jobId)},
			  ${q(automationArtifactFixture.objectKey)},
			  ${q(automationArtifactFixture.fileName)},
			  ${q(automationArtifactFixture.contentType)},
			  ${automationArtifactFixture.body.byteLength},
			  ${q(automationArtifactFixture.checksum)}, 'ready', 1, 1,
			  ${now + 30 * 86_400_000}, ${automationPurchase.activatedAt}, ${now})
			 ON CONFLICT(id) DO UPDATE SET object_key = excluded.object_key,
			  file_name = excluded.file_name,
			  content_type = excluded.content_type,
			  size_bytes = excluded.size_bytes,
			  checksum_sha256 = excluded.checksum_sha256,
			  upload_status = excluded.upload_status,
			  download_enabled = excluded.download_enabled,
			  download_count = excluded.download_count,
			  delete_after = excluded.delete_after,
			  deleted_at = NULL, updated_at = excluded.updated_at`,
		`INSERT INTO entitlement_events
			 (id, kind, entitlement_id, event_type, asset_type, asset_id,
			  consumed, actor_type, created_at)
			 VALUES (${q(uuid(27, 1))}, 'access',
			  ${q(automationPurchase.entitlementId)}, 'downloaded',
			  'automation_artifact', ${q(automationArtifactFixture.id)},
			  1, 'customer', ${automationPurchase.activatedAt + 180_000})
			 ON CONFLICT(id) DO NOTHING`,
	);
}

function automationInputDefinitions() {
	return [
		{
			key: "project_name",
			name: "项目名称",
			description: "用于标识本次自动化任务和输出。",
			inputType: "text",
			scope: "automation",
			required: true,
			sensitive: false,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "demo-project",
			exampleValue: "my-store",
			sortOrder: 100,
			options: [],
		},
		{
			key: "environment",
			name: "运行环境",
			description: "选择本次任务使用的部署环境。",
			inputType: "select",
			scope: "automation",
			required: true,
			sensitive: false,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "staging",
			exampleValue: "staging",
			sortOrder: 200,
			options: [
				{ value: "development", label: "开发环境" },
				{ value: "staging", label: "预发布环境" },
				{ value: "production", label: "生产环境" },
			],
		},
		{
			key: "region",
			name: "部署区域",
			description: "该选择会保存到当前权益，后续任务可以继续使用。",
			inputType: "select",
			scope: "authorization",
			required: true,
			sensitive: false,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "ap-east-1",
			exampleValue: "ap-east-1",
			sortOrder: 300,
			options: [
				{ value: "ap-east-1", label: "亚太东部" },
				{ value: "eu-west-1", label: "欧洲西部" },
				{ value: "us-east-1", label: "美国东部" },
			],
		},
		{
			key: "access_token",
			name: "访问令牌",
			description: "敏感值会单独加密保存，页面只显示掩码。",
			inputType: "text",
			scope: "authorization",
			required: true,
			sensitive: true,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "",
			exampleValue: "token_xxxxxxxxxxxx",
			sortOrder: 400,
			options: [],
		},
		{
			key: "replicas",
			name: "实例数量",
			description: "本次任务需要创建的实例数量。",
			inputType: "number",
			scope: "automation",
			required: false,
			sensitive: false,
			validationPattern: "",
			minimumValue: 1,
			maximumValue: 10,
			defaultValue: "1",
			exampleValue: "2",
			sortOrder: 500,
			options: [],
		},
		{
			key: "features",
			name: "可选功能",
			description: "可以同时选择多个需要启用的能力。",
			inputType: "multiselect",
			scope: "automation",
			required: false,
			sensitive: false,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "",
			exampleValue: "",
			sortOrder: 600,
			options: [
				{ value: "cache", label: "缓存" },
				{ value: "monitoring", label: "监控" },
				{ value: "backups", label: "备份" },
			],
		},
		{
			key: "dry_run",
			name: "仅验证配置",
			description: "开启后只检查参数和环境，不执行实际变更。",
			inputType: "boolean",
			scope: "automation",
			required: false,
			sensitive: false,
			validationPattern: "",
			minimumValue: null,
			maximumValue: null,
			defaultValue: "",
			exampleValue: "true",
			sortOrder: 700,
			options: [],
		},
	] as const;
}

function alipayCredential(mode: "page" | "wap") {
	return {
		appId: mode === "page" ? "2026000000000001" : "2026000000000002",
		sellerId: "2088000000000001",
		privateKeyPem:
			"-----BEGIN PRIVATE KEY-----\nDEMO ALIPAY PRIVATE KEY NOT REAL\n-----END PRIVATE KEY-----",
		alipayPublicKeyPem:
			"-----BEGIN PUBLIC KEY-----\nDEMO ALIPAY PUBLIC KEY NOT REAL\n-----END PUBLIC KEY-----",
	};
}

function wechatCredential(mode: "native" | "h5") {
	return {
		appId: mode === "native" ? "wxdemonative" : "wxdemoh5",
		mchId: mode === "native" ? "1900000001" : "1900000002",
		merchantSerialNumber:
			mode === "native" ? "A11CE00000000001" : "A11CE00000000002",
		merchantPrivateKeyPem:
			"-----BEGIN PRIVATE KEY-----\nDEMO WECHAT PRIVATE KEY NOT REAL\n-----END PRIVATE KEY-----",
		apiV3Key: "demo-api-v3-key-0000000000000000",
		platformSerialNumber:
			mode === "native" ? "B11CE00000000001" : "B11CE00000000002",
		platformPublicKeyPem:
			"-----BEGIN PUBLIC KEY-----\nDEMO WECHAT PUBLIC KEY NOT REAL\n-----END PUBLIC KEY-----",
	};
}

function uuid(prefix: number, suffix: number) {
	return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

function q(value: string | number | null) {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replaceAll("'", "''")}'`;
}

function requireValue(value: string | undefined, message: string) {
	if (!value) throw new Error(message);
	return value;
}

type QueryRow = Record<string, unknown> & { key?: string; value?: string };

async function queryRows(command: string): Promise<QueryRow[]> {
	const output = await runWrangler([
		"d1",
		"execute",
		databaseName,
		"--local",
		"--json",
		"--command",
		command,
	]);
	const result = JSON.parse(output) as Array<{ results?: QueryRow[] }>;
	return result.flatMap((entry) => entry.results ?? []);
}

function readSetting(rows: QueryRow[], key: string) {
	const raw = rows.find((row) => row.key === key)?.value;
	if (!raw) throw new Error(`Install the local store before seeding (${key}).`);
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "string" || parsed.length < 16)
		throw new Error(`Local setting ${key} is unavailable.`);
	return parsed;
}

async function executeSql(command: string) {
	await runWrangler([
		"d1",
		"execute",
		databaseName,
		"--local",
		"--command",
		command,
	]);
}

async function putR2Object(key: string, body: Uint8Array, contentType: string) {
	const directory = await mkdtemp(join(tmpdir(), "gmshop-acceptance-"));
	const path = join(directory, "fixture");
	try {
		await writeFile(path, body);
		await runWrangler([
			"r2",
			"object",
			"put",
			`${bucketName}/${key}`,
			"--local",
			"--force",
			"--file",
			path,
			"--content-type",
			contentType,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function putKvValue(key: string, value: string, ttlSeconds: number) {
	const directory = await mkdtemp(join(tmpdir(), "gmshop-acceptance-kv-"));
	const path = join(directory, "fixture.json");
	try {
		await writeFile(path, value);
		await runWrangler([
			"kv",
			"key",
			"put",
			key,
			"--binding",
			"CACHE",
			"--local",
			"--ttl",
			String(ttlSeconds),
			"--path",
			path,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function supplierCatalogCacheKey(source: {
	provider: string;
	normalizedApiOrigin: string;
	protocolVersion: string;
}) {
	const digest = createHash("sha256")
		.update(
			`${source.provider}\0${source.normalizedApiOrigin}\0${source.protocolVersion}`,
		)
		.digest("hex")
		.slice(0, 32);
	return `supplier:catalog:v1:${digest}`;
}

async function runWrangler(args: string[]) {
	return new Promise<string>((resolve, reject) => {
		const persistedArgs = persistTo
			? ["wrangler", ...args, "--persist-to", persistTo]
			: ["wrangler", ...args];
		const child = spawn("bunx", persistedArgs, {
			cwd: projectDirectory,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		child.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			const output = Buffer.concat(stdout).toString("utf8");
			const error = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				resolve(output);
				return;
			}
			reject(new Error(error.trim() || output.trim() || "Wrangler failed"));
		});
	});
}

function createPng(
	width: number,
	height: number,
	color: [number, number, number],
) {
	const stride = width * 4 + 1;
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * stride] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = y * stride + 1 + x * 4;
			const light = Math.round((x / Math.max(1, width - 1)) * 35);
			raw[offset] = Math.min(255, color[0] + light);
			raw[offset + 1] = Math.min(255, color[1] + light);
			raw[offset + 2] = Math.min(255, color[2] + light);
			raw[offset + 3] = 255;
		}
	}
	const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	return concatBytes(
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", new Uint8Array()),
	);
}

function pngChunk(type: string, data: Uint8Array) {
	const typeBytes = new TextEncoder().encode(type);
	const output = new Uint8Array(12 + data.byteLength);
	const view = new DataView(output.buffer);
	view.setUint32(0, data.byteLength);
	output.set(typeBytes, 4);
	output.set(data, 8);
	view.setUint32(8 + data.byteLength, crc32(concatBytes(typeBytes, data)));
	return output;
}

function concatBytes(...parts: Uint8Array[]) {
	const output = new Uint8Array(
		parts.reduce((total, part) => total + part.byteLength, 0),
	);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
