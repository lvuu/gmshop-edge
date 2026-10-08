const SUPPLIER_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

export function storefrontStockExpression(
	productAlias: string,
	itemAlias: string,
) {
	return `CASE
		WHEN ${productAlias}.product_type NOT IN ('stock', 'service') THEN -1
		WHEN ${productAlias}.product_type = 'service' AND ${itemAlias}.fulfillment_source <> 'supplier' THEN 0
		WHEN ${itemAlias}.fulfillment_source = 'supplier' THEN COALESCE((
			SELECT CASE WHEN ${productAlias}.product_type = 'service' THEN -1 ELSE binding.stock_quantity END
			FROM supplier_bindings binding
			WHERE binding.sellable_item_id = ${itemAlias}.id
			 AND binding.enabled = 1
			 AND binding.remote_status = 'active'
			 AND (${productAlias}.product_type = 'service' OR binding.last_synced_at >= (unixepoch() * 1000 - ${SUPPLIER_SNAPSHOT_MAX_AGE_MS}))
			 AND (
			  length(binding.reference_cost_minor) < length(binding.max_cost_minor)
			  OR (
			   length(binding.reference_cost_minor) = length(binding.max_cost_minor)
			   AND binding.reference_cost_minor <= binding.max_cost_minor
			  )
			 )
			 AND EXISTS (
			  SELECT 1 FROM supplier_accounts account
			  WHERE account.provider = binding.provider
			   AND account.normalized_api_origin = binding.normalized_api_origin
			   AND account.protocol_version = binding.protocol_version
			   AND account.enabled = 1
			   AND (${productAlias}.product_type <> 'service' OR (account.currency = ${itemAlias}.currency AND account.currency_decimals = ${itemAlias}.currency_decimals))
			   AND account.health_status <> 'unavailable'
			   AND (account.cooldown_until IS NULL OR account.cooldown_until <= unixepoch() * 1000)
			   AND account.balance_minor IS NOT NULL
			 )
			LIMIT 1
		), 0)
		ELSE (
		 SELECT COUNT(*) FROM stock_entries secret
		 WHERE secret.sellable_item_id = ${itemAlias}.id
		  AND secret.status = 'available'
		)
	END`;
}

export { SUPPLIER_SNAPSHOT_MAX_AGE_MS };
