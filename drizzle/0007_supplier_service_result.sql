PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_delivery_records` (
	`id` text PRIMARY KEY NOT NULL,
	`order_item_id` text NOT NULL,
	`delivery_type` text NOT NULL,
	`request_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`content_encrypted` text,
	`content_key_version` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`error_code` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_item_id`) REFERENCES `shop_order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_records_type_check" CHECK("__new_delivery_records"."delivery_type" IN ('stock', 'download', 'automation', 'service')),
	CONSTRAINT "delivery_records_attempt_count_check" CHECK("__new_delivery_records"."attempt_count" >= 0),
	CONSTRAINT "delivery_records_content_shape_check" CHECK(("__new_delivery_records"."content_encrypted" IS NULL AND "__new_delivery_records"."content_key_version" IS NULL) OR
				("__new_delivery_records"."content_encrypted" IS NOT NULL AND "__new_delivery_records"."content_key_version" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_delivery_records`("id", "order_item_id", "delivery_type", "request_key", "status", "content_encrypted", "content_key_version", "attempt_count", "next_attempt_at", "delivered_at", "error_code", "created_at", "updated_at") SELECT "id", "order_item_id", "delivery_type", "request_key", "status", "content_encrypted", "content_key_version", "attempt_count", "next_attempt_at", "delivered_at", "error_code", "created_at", "updated_at" FROM `delivery_records`;--> statement-breakpoint
DROP TABLE `delivery_records`;--> statement-breakpoint
ALTER TABLE `__new_delivery_records` RENAME TO `delivery_records`;--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_records_request_key_uidx` ON `delivery_records` (`request_key`);--> statement-breakpoint
CREATE INDEX `delivery_records_order_item_created_idx` ON `delivery_records` (`order_item_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `delivery_records_status_attempt_idx` ON `delivery_records` (`status`,`next_attempt_at`,`id`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
