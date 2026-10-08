PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_supplier_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`normalized_api_origin` text NOT NULL,
	`protocol_version` text NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`currency_decimals` integer DEFAULT 2 NOT NULL,
	`name` text NOT NULL,
	`credentials_encrypted` text NOT NULL,
	`credentials_revision` integer DEFAULT 1 NOT NULL,
	`credential_fingerprint` text NOT NULL,
	`balance_minor` text,
	`balance_synced_at` integer,
	`reserve_balance_minor` text DEFAULT '0' NOT NULL,
	`low_balance_minor` text DEFAULT '0' NOT NULL,
	`max_order_cost_minor` text,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer,
	`last_selected_at` integer,
	`last_error_code` text,
	`last_error_at` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "supplier_accounts_provider_check" CHECK("__new_supplier_accounts"."provider" IN ('acg', 'dujiao_next', 'gmshop_edge', 'dhru')),
	CONSTRAINT "supplier_accounts_currency_decimals_check" CHECK("__new_supplier_accounts"."currency_decimals" BETWEEN 0 AND 8),
	CONSTRAINT "supplier_accounts_credentials_revision_check" CHECK("__new_supplier_accounts"."credentials_revision" > 0),
	CONSTRAINT "supplier_accounts_balance_check" CHECK("__new_supplier_accounts"."balance_minor" IS NULL OR ("balance_minor" <> '' AND "balance_minor" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "supplier_accounts_reserve_balance_check" CHECK("reserve_balance_minor" <> '' AND "reserve_balance_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "supplier_accounts_low_balance_check" CHECK("low_balance_minor" <> '' AND "low_balance_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "supplier_accounts_max_order_cost_check" CHECK("__new_supplier_accounts"."max_order_cost_minor" IS NULL OR ("max_order_cost_minor" <> '' AND "max_order_cost_minor" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "supplier_accounts_failures_check" CHECK("__new_supplier_accounts"."consecutive_failures" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_supplier_accounts`("id", "provider", "base_url", "normalized_api_origin", "protocol_version", "currency", "currency_decimals", "name", "credentials_encrypted", "credentials_revision", "credential_fingerprint", "balance_minor", "balance_synced_at", "reserve_balance_minor", "low_balance_minor", "max_order_cost_minor", "health_status", "consecutive_failures", "cooldown_until", "last_selected_at", "last_error_code", "last_error_at", "enabled", "created_at", "updated_at") SELECT "id", "provider", "base_url", "normalized_api_origin", "protocol_version", "currency", "currency_decimals", "name", "credentials_encrypted", "credentials_revision", "credential_fingerprint", "balance_minor", "balance_synced_at", "reserve_balance_minor", "low_balance_minor", "max_order_cost_minor", "health_status", "consecutive_failures", "cooldown_until", "last_selected_at", "last_error_code", "last_error_at", "enabled", "created_at", "updated_at" FROM `supplier_accounts`;--> statement-breakpoint
DROP TABLE `supplier_accounts`;--> statement-breakpoint
ALTER TABLE `__new_supplier_accounts` RENAME TO `supplier_accounts`;--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_accounts_source_name_uidx` ON `supplier_accounts` (`provider`,`normalized_api_origin`,`protocol_version`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_accounts_source_credential_uidx` ON `supplier_accounts` (`provider`,`normalized_api_origin`,`protocol_version`,`credential_fingerprint`);--> statement-breakpoint
CREATE INDEX `supplier_accounts_source_eligible_idx` ON `supplier_accounts` (`provider`,`normalized_api_origin`,`protocol_version`,`enabled`,`health_status`,`cooldown_until`,`last_selected_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_supplier_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`sellable_item_id` text NOT NULL,
	`provider` text NOT NULL,
	`normalized_api_origin` text NOT NULL,
	`protocol_version` text NOT NULL,
	`upstream_product_id` text NOT NULL,
	`upstream_sku_id` text NOT NULL,
	`upstream_product_name` text NOT NULL,
	`upstream_sku_name` text NOT NULL,
	`reference_cost_minor` text NOT NULL,
	`max_cost_minor` text NOT NULL,
	`stock_quantity` integer DEFAULT 0 NOT NULL,
	`remote_status` text DEFAULT 'unknown' NOT NULL,
	`last_synced_at` integer,
	`last_error_code` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sellable_item_id`) REFERENCES `product_sellable_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "supplier_bindings_provider_check" CHECK("__new_supplier_bindings"."provider" IN ('acg', 'dujiao_next', 'gmshop_edge', 'dhru')),
	CONSTRAINT "supplier_bindings_reference_cost_check" CHECK("reference_cost_minor" <> '' AND "reference_cost_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "supplier_bindings_max_cost_check" CHECK("max_cost_minor" <> '' AND "max_cost_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "supplier_bindings_stock_quantity_check" CHECK("__new_supplier_bindings"."stock_quantity" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_supplier_bindings`("id", "sellable_item_id", "provider", "normalized_api_origin", "protocol_version", "upstream_product_id", "upstream_sku_id", "upstream_product_name", "upstream_sku_name", "reference_cost_minor", "max_cost_minor", "stock_quantity", "remote_status", "last_synced_at", "last_error_code", "enabled", "created_at", "updated_at") SELECT "id", "sellable_item_id", "provider", "normalized_api_origin", "protocol_version", "upstream_product_id", "upstream_sku_id", "upstream_product_name", "upstream_sku_name", "reference_cost_minor", "max_cost_minor", "stock_quantity", "remote_status", "last_synced_at", "last_error_code", "enabled", "created_at", "updated_at" FROM `supplier_bindings`;--> statement-breakpoint
DROP TABLE `supplier_bindings`;--> statement-breakpoint
ALTER TABLE `__new_supplier_bindings` RENAME TO `supplier_bindings`;--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_bindings_enabled_item_uidx` ON `supplier_bindings` (`sellable_item_id`) WHERE "supplier_bindings"."enabled" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_bindings_enabled_source_sku_uidx` ON `supplier_bindings` (`provider`,`normalized_api_origin`,`protocol_version`,`upstream_product_id`,`upstream_sku_id`) WHERE "supplier_bindings"."enabled" = 1;--> statement-breakpoint
CREATE INDEX `supplier_bindings_source_status_sync_idx` ON `supplier_bindings` (`provider`,`normalized_api_origin`,`protocol_version`,`enabled`,`remote_status`,`last_synced_at`,`id`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
