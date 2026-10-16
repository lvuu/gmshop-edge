CREATE INDEX `shop_order_items_product_idx` ON `shop_order_items` (`product_id`,`id`);--> statement-breakpoint
CREATE INDEX `commerce_events_created_idx` ON `commerce_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `verifications_expiry_idx` ON `verifications` (`expires_at`,`id`);
