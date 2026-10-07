# Dhru service integration / Dhru 服务订单接入

## Current implementation

`DhruAdapter.submitOrder()` and `reconcileOrder()` now accept an explicit
`service: { productId, inputData }` snapshot. Calls without it still fail
before any paid request. Catalog import and stock SKU lookup remain blocked.

The adapter preserves dynamic field names and values; it does not infer fields
from `imei/server/remote/file`. The shared snapshot contract supports strings,
finite numbers, booleans and string arrays, with 100 fields and a 64 KiB encoded
limit. Routing and prototype keys are rejected before Zod constructs output.
Product-specific required fields, options and constraints must be validated
against the immutable published input-definition version before creating a job.
This adapter boundary validates payload shape, not a product's field schema.

The worker's `traceId` must be the supplier job ID. The adapter uses it directly
as Dhru `reference_id`; `providerRequestNumber("dhru", jobId, accountId)` also
returns that ID. UUID job IDs satisfy Dhru's reference format. A reference does
not guarantee upstream idempotency.

A successful POST receipt becomes processing and retains its `order_uuid`.
A currency mismatch retains that ID as uncertain. A rejected POST becomes a
definitive failure; a timeout/5xx/malformed response becomes uncertain. The adapter
does not retry POST. Missing UUIDs remain uncertain without any network request.
Authenticated reads preserve all six nonterminal Dhru states as processing.
Authenticated success with matching quantity produces encrypted-delivery-compatible
`{ type: "service", resultText }`; invalid/blank/oversized results remain uncertain.
GET replay is plain text and is never base64-decoded. Read failures retain the UUID.
Rejection emits a fixed error code and does not expose supplier/customer text.

No service product or paid queue is enabled by this change. In particular the
existing stock worker cannot purchase Dhru products: its SKU preflight remains
blocked. Do not enable Dhru routing by bypassing that preflight.

## Accepted target and remaining wiring

Keep existing GMShop product capabilities and add service; do not remove download
or automation. Internal service classification is `imei | server | remote | file |
generic`. Preserve unknown upstream types as opaque strings on bindings. Monetary
values remain integer strings in minor units.

Reuse the existing tables instead of creating a competing order state machine:

| Target concept | Existing GMShop location | Required follow-up |
| --- | --- | --- |
| Product/input schema | products + immutable input-definition versions | Add service type/classification and published dynamic fields |
| Supplier product binding | supplier_bindings | Store external type/schema and manually bind one selected account/product |
| Order input data | shop_order_items + encrypted input snapshots | Validate against the published version; decrypt only during execution |
| Supplier job | supplier_orders | Persist binding/input snapshot; paid-only atomic claim and Outbox |
| Supplier result | encrypted delivery_records | Extend structured service output as needed; retain authorized reveal |
| Callback and polling | supplier processing and maintenance | Add Dhru notification endpoint; authenticate GET before applying results |

A known submitted order must stay locked to its selected account and credential
revision. An uncertain submission must never enter automatic reselect/resubmit.
Final supplier rejection requires an explicit service failure/refund path rather
than automatically trying a second supplier. Delivery must remain atomic with the
result and its Outbox event; duplicates must not overwrite the first result.

Next implementation: one manually bound service product, customer dynamic input,
Paid → Queue → authenticated Dhru submit/query → customer result. Full catalog and
price sync remain deferred. File upload/download and remote-specific rendering
must be implemented explicitly before offering those services.

## Validation

Added 24 adapter/snapshot tests covering job correlation, exact dynamic fields,
reserved/prototype fields, limits, uncertainty, rejection, quantity mismatch,
currency mismatch and authenticated result handling. Fixed the installation
migration inventory to include 0006 and 0007, retaining foreign-key and baseline
checks. CI steps now expose type, formatting, focused tests, full tests and both
builds separately.

Only mocked upstream calls are used. No production migration, deployment or live
paid order is performed by this change.

## 简体中文

本轮实现适配器层的显式服务输入快照、任务 ID 关联、提交回执保存、认证
状态查询与文本结果归一化。动态字段保留原名与原值，保留字段和原型字段
在校验原始输入时拒绝；输入限制 100 个字段、64 KiB。商品必填字段、选项
及约束仍需在订单创建时根据不可变字段定义验证，不能仅靠适配器校验。

reference_id 使用 supplier_orders 的任务 ID。提交结果不确定时不重下单；
已知上游订单号和读取失败时均保留订单号，未知订单号需人工核对。
查询接口的 replay 是纯文本，不能套用回调 Base64 解码。只有认证查询
返回成功、数量匹配且结果有效时，才生成 service 交付结果。

本轮尚未增加 service 商品、客户输入表单、数据库输入快照接线、Dhru 回调
路由和支付队列闭环。旧卡密 Worker 仍无法自动采购 Dhru。下一步复用既有
商品字段定义、supplier_bindings、supplier_orders、加密 delivery_records
接通一件手工绑定测试商品。下载与自动化商品保留；未知上游产品类型独立
保存，不与本地 service_type 共用枚举。全量目录同步继续延后。

新增 24 项测试并修复安装迁移清单；未部署、未迁移生产数据库、未真实付费。
