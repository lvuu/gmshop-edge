DROP TRIGGER IF EXISTS `product_sellable_items_supplier_stock_insert_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_sellable_items_supplier_stock_update_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_supplier_stock_type_trigger`;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__service_backup_entitlement_authorization_values` AS SELECT * FROM `entitlement_authorization_values`;--> statement-breakpoint
CREATE TABLE `__service_backup_product_media` AS SELECT * FROM `product_media`;--> statement-breakpoint
CREATE TABLE `__service_backup_order_item_download_assets` AS SELECT * FROM `order_item_download_assets`;--> statement-breakpoint
CREATE TABLE `__new_customer_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`order_item_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sellable_item_id` text NOT NULL,
	`delivery_component_id` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`definition_version_id` text,
	`usage_limit` integer,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`access_limit` integer,
	`access_count` integer DEFAULT 0 NOT NULL,
	`activated_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `shop_order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "customer_entitlements_type_check" CHECK("__new_customer_entitlements"."entitlement_type" IN ('stock', 'download', 'automation', 'service')),
	CONSTRAINT "customer_entitlements_usage_count_check" CHECK("__new_customer_entitlements"."usage_count" >= 0),
	CONSTRAINT "customer_entitlements_access_count_check" CHECK("__new_customer_entitlements"."access_count" >= 0),
	CONSTRAINT "customer_entitlements_usage_limit_check" CHECK("__new_customer_entitlements"."usage_limit" IS NULL OR "__new_customer_entitlements"."usage_limit" > 0),
	CONSTRAINT "customer_entitlements_access_limit_check" CHECK("__new_customer_entitlements"."access_limit" IS NULL OR "__new_customer_entitlements"."access_limit" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_customer_entitlements`("id", "user_id", "order_item_id", "product_id", "sellable_item_id", "delivery_component_id", "entitlement_type", "status", "definition_version_id", "usage_limit", "usage_count", "access_limit", "access_count", "activated_at", "expires_at", "revoked_at", "created_at", "updated_at") SELECT "id", "user_id", "order_item_id", "product_id", "sellable_item_id", "delivery_component_id", "entitlement_type", "status", "definition_version_id", "usage_limit", "usage_count", "access_limit", "access_count", "activated_at", "expires_at", "revoked_at", "created_at", "updated_at" FROM `customer_entitlements`;--> statement-breakpoint
DROP TABLE `customer_entitlements`;--> statement-breakpoint
ALTER TABLE `__new_customer_entitlements` RENAME TO `customer_entitlements`;--> statement-breakpoint
CREATE UNIQUE INDEX `customer_entitlements_order_item_uidx` ON `customer_entitlements` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `customer_entitlements_user_status_idx` ON `customer_entitlements` (`user_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `customer_entitlements_status_expiry_idx` ON `customer_entitlements` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tag_names` text DEFAULT '[]' NOT NULL,
	`product_type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`trashed_at` integer,
	`cover_object_key` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`revision_token` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "products_revision_check" CHECK("__new_products"."revision" > 0),
	CONSTRAINT "products_status_check" CHECK("__new_products"."status" IN ('draft', 'active', 'trashed')),
	CONSTRAINT "products_trash_shape_check" CHECK(("__new_products"."status" = 'trashed' AND "__new_products"."trashed_at" IS NOT NULL) OR
				("__new_products"."status" <> 'trashed' AND "__new_products"."trashed_at" IS NULL)),
	CONSTRAINT "products_product_type_check" CHECK("__new_products"."product_type" IN ('stock', 'download', 'automation', 'service'))
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "name", "description", "tag_names", "product_type", "status", "trashed_at", "cover_object_key", "revision", "revision_token", "sort_order", "created_at", "updated_at") SELECT "id", "name", "description", "tag_names", "product_type", "status", "trashed_at", "cover_object_key", "revision", "revision_token", "sort_order", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
CREATE INDEX `products_status_sort_idx` ON `products` (`status`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `__new_shop_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sellable_item_id` text NOT NULL,
	`product_name` text NOT NULL,
	`delivery_component_id` text NOT NULL,
	`delivery_component_type` text NOT NULL,
	`delivery_component_version` integer NOT NULL,
	`sellable_item_name` text NOT NULL,
	`definition_version_id` text,
	`input_values_json` text DEFAULT '{}' NOT NULL,
	`sensitive_input_values_json` text DEFAULT '{}' NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_minor` text NOT NULL,
	`unit_cost_minor` text,
	`discount_minor` text DEFAULT '0' NOT NULL,
	`subtotal_minor` text NOT NULL,
	`renewed_from_entitlement_id` text,
	`duration_ms` integer,
	`usage_limit` integer,
	`access_limit` integer,
	`activation_trigger` text DEFAULT 'delivery_completed' NOT NULL,
	`exhaustion_rule` text DEFAULT 'first_limit_reached' NOT NULL,
	`renewal_mode` text DEFAULT 'stack' NOT NULL,
	`show_on_order_page` integer DEFAULT true NOT NULL,
	`account_library_enabled` integer DEFAULT true NOT NULL,
	`email_mode` text DEFAULT 'none' NOT NULL,
	`allow_resend` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "shop_order_items_delivery_component_type_check" CHECK("__new_shop_order_items"."delivery_component_type" IN ('stock', 'download', 'automation', 'service')),
	CONSTRAINT "shop_order_items_service_policy_check" CHECK("__new_shop_order_items"."delivery_component_type" <> 'service' OR
			("__new_shop_order_items"."duration_ms" IS NULL AND "__new_shop_order_items"."usage_limit" IS NULL AND "__new_shop_order_items"."access_limit" IS NULL
			 AND "__new_shop_order_items"."renewal_mode" = 'disabled' AND "__new_shop_order_items"."renewed_from_entitlement_id" IS NULL AND "__new_shop_order_items"."email_mode" <> 'content')),
	CONSTRAINT "shop_order_items_quantity_check" CHECK("__new_shop_order_items"."quantity" > 0),
	CONSTRAINT "shop_order_items_unit_price_check" CHECK("unit_price_minor" <> '' AND "unit_price_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "shop_order_items_unit_cost_check" CHECK("__new_shop_order_items"."unit_cost_minor" IS NULL OR ("unit_cost_minor" <> '' AND "unit_cost_minor" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "shop_order_items_discount_check" CHECK("discount_minor" <> '' AND "discount_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "shop_order_items_subtotal_check" CHECK("subtotal_minor" <> '' AND "subtotal_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "shop_order_items_duration_check" CHECK("__new_shop_order_items"."duration_ms" IS NULL OR "__new_shop_order_items"."duration_ms" > 0),
	CONSTRAINT "shop_order_items_usage_limit_check" CHECK("__new_shop_order_items"."usage_limit" IS NULL OR "__new_shop_order_items"."usage_limit" > 0),
	CONSTRAINT "shop_order_items_access_limit_check" CHECK("__new_shop_order_items"."access_limit" IS NULL OR "__new_shop_order_items"."access_limit" > 0),
	CONSTRAINT "shop_order_items_email_content_check" CHECK("__new_shop_order_items"."email_mode" <> 'content' OR
				("__new_shop_order_items"."delivery_component_type" = 'stock' AND
				 "__new_shop_order_items"."duration_ms" IS NULL AND "__new_shop_order_items"."usage_limit" IS NULL AND
				 "__new_shop_order_items"."access_limit" IS NULL)),
	CONSTRAINT "shop_order_items_account_library_check" CHECK("__new_shop_order_items"."account_library_enabled" = true),
	CONSTRAINT "shop_order_items_input_json_check" CHECK(json_valid("__new_shop_order_items"."input_values_json") AND json_type("__new_shop_order_items"."input_values_json") = 'object'
				AND json_valid("__new_shop_order_items"."sensitive_input_values_json")
				AND json_type("__new_shop_order_items"."sensitive_input_values_json") = 'object')
);
--> statement-breakpoint
INSERT INTO `__new_shop_order_items`("id", "order_id", "product_id", "sellable_item_id", "product_name", "delivery_component_id", "delivery_component_type", "delivery_component_version", "sellable_item_name", "definition_version_id", "input_values_json", "sensitive_input_values_json", "quantity", "unit_price_minor", "unit_cost_minor", "discount_minor", "subtotal_minor", "renewed_from_entitlement_id", "duration_ms", "usage_limit", "access_limit", "activation_trigger", "exhaustion_rule", "renewal_mode", "show_on_order_page", "account_library_enabled", "email_mode", "allow_resend", "created_at", "updated_at") SELECT "id", "order_id", "product_id", "sellable_item_id", "product_name", "delivery_component_id", "delivery_component_type", "delivery_component_version", "sellable_item_name", "definition_version_id", "input_values_json", "sensitive_input_values_json", "quantity", "unit_price_minor", "unit_cost_minor", "discount_minor", "subtotal_minor", "renewed_from_entitlement_id", "duration_ms", "usage_limit", "access_limit", "activation_trigger", "exhaustion_rule", "renewal_mode", "show_on_order_page", "account_library_enabled", "email_mode", "allow_resend", "created_at", "updated_at" FROM `shop_order_items`;--> statement-breakpoint
DROP TABLE `shop_order_items`;--> statement-breakpoint
ALTER TABLE `__new_shop_order_items` RENAME TO `shop_order_items`;--> statement-breakpoint
CREATE INDEX `shop_order_items_order_idx` ON `shop_order_items` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `shop_order_items_sellable_item_idx` ON `shop_order_items` (`sellable_item_id`,`id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `entitlement_authorization_values` SELECT * FROM `__service_backup_entitlement_authorization_values`;--> statement-breakpoint
DROP TABLE `__service_backup_entitlement_authorization_values`;--> statement-breakpoint
INSERT OR IGNORE INTO `product_media` SELECT * FROM `__service_backup_product_media`;--> statement-breakpoint
DROP TABLE `__service_backup_product_media`;--> statement-breakpoint
INSERT OR IGNORE INTO `order_item_download_assets` SELECT * FROM `__service_backup_order_item_download_assets`;--> statement-breakpoint
DROP TABLE `__service_backup_order_item_download_assets`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;

--> statement-breakpoint
CREATE TRIGGER `product_sellable_items_supplier_stock_insert_trigger`
BEFORE INSERT ON `product_sellable_items`
WHEN NEW.`fulfillment_source` = 'supplier'
 AND NOT EXISTS (
	SELECT 1 FROM `products`
	WHERE `products`.`id` = NEW.`product_id` AND `products`.`product_type` IN ('stock', 'service')
 )
BEGIN
	SELECT RAISE(ABORT, 'supplier_fulfillment_requires_stock_product');
END;--> statement-breakpoint
CREATE TRIGGER `product_sellable_items_supplier_stock_update_trigger`
BEFORE UPDATE OF `fulfillment_source`, `product_id` ON `product_sellable_items`
WHEN NEW.`fulfillment_source` = 'supplier'
 AND NOT EXISTS (
	SELECT 1 FROM `products`
	WHERE `products`.`id` = NEW.`product_id` AND `products`.`product_type` IN ('stock', 'service')
 )
BEGIN
	SELECT RAISE(ABORT, 'supplier_fulfillment_requires_stock_product');
END;--> statement-breakpoint
CREATE TRIGGER `products_supplier_stock_type_trigger`
BEFORE UPDATE OF `product_type` ON `products`
WHEN NEW.`product_type` NOT IN ('stock', 'service')
 AND EXISTS (
	SELECT 1 FROM `product_sellable_items`
	WHERE `product_sellable_items`.`product_id` = NEW.`id`
	 AND `product_sellable_items`.`fulfillment_source` = 'supplier'
 )
BEGIN
	SELECT RAISE(ABORT, 'supplier_fulfillment_requires_stock_product');
END;--> statement-breakpoint
