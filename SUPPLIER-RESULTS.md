# Supplier fulfillment results / 供应商交付结果

## Contract

Successful internal supplier results now use one fulfillment discriminator:

```ts
{ status: "supplied", upstreamOrderId: "123",
  fulfillment: { type: "stock", cards: ["CARD-1"] } }

{ status: "supplied", upstreamOrderId: "D1",
  fulfillment: { type: "service", resultText: "Status: Clean",
    resultData: { clean: true } } }
```

Processing, uncertain and definitive-failure results keep their existing shape.
Service text must be nonblank and at most 64,000 characters; optional structured
data must be JSON. The encoded service payload is bounded to 256 KiB. Existing
ACG, Dujiao Next and GMShop Edge adapters and the verified Dujiao callback map
their original wire formats into stock fulfillment. External supplier APIs are
unchanged. Internal adapters must migrate from top-level cards to fulfillment.

Stock keeps encrypted inventory reservation and delivery. Service completion
requires a matching service delivery record and a paid/fulfilling parent order.
It atomically stores encrypted JSON in delivery_records with the existing
delivery-content envelope and publishes a delivery.requested outbox reference.
It never writes stock_entries. Duplicate completion cannot overwrite the first
result. Normal fulfillment advances delivery/order status and notifications.

Customers reveal service text through the existing private delivery endpoint
after order ownership or guest email access validation. Text is returned as
content for the existing plain-text renderer; resultData is optional JSON.
Service access is audited without consuming stock-secret entitlements. Copying
is recorded without including secret result data in the audit event.

Migration 0007 extends only the delivery record type constraint. Its table
replacement preserves records, indexes and foreign keys and uses deferred
foreign keys for D1 compatibility. Earlier migration files are unchanged.

The original result-only boundary has been extended by the service product integration below. Production deployment and real paid acceptance remain separate.

## 简体中文

成功结果改为 fulfillment.type = stock 或 service：stock 携带 cards，
service 携带 resultText 和可选 resultData。处理中、不确定、明确失败的结果
保持原结构。服务文本必须非空白，最长 64,000 字符；结构化数据只能是
JSON，序列化后的服务结果最大 256 KiB。

现有卡密适配器与已验证的 Dujiao 回调统一映射到 stock，外部接口不变。
服务结果必须对应 service 交付记录和已付款/履约中的订单；原子保存到
delivery_records 的加密内容字段，通过既有 Outbox 触发后续交付，
不写卡密库存。重复完成不覆盖首次结果，取消订单和类型不匹配会阻止交付。

客户读取沿用订单归属或访客邮箱校验，响应禁止缓存；服务文本按纯文本
显示，可复制，结果内容不进入审计日志。服务访问不消耗卡密权益。
0007 迁移只扩展交付记录的类型约束，保留已有记录、索引和引用关系。

原先仅扩展结果的边界已由下文的正式服务产品接入取代。生产部署和真实付费验收尚未进行。


## Service products / 服务产品

`service` is now a product and immutable order/entitlement type. New service plans use supplier fulfillment and remain unavailable until bound. A service cannot be published or purchased without an enabled binding and an eligible account. Payment writes `awaiting_supply`, a supplier order, and `supplier.requested` atomically; it never allocates stock. Service results are one-time, without quota, expiry, renewal, or direct-content email; email uses the private order link. The result activates the service entitlement and can be revealed from the order or customer library with ownership and refund/revocation checks.

`service` 已成为正式产品类型，并保存到不可变订单和权益快照。新服务规格默认使用供应商履约，绑定前不可销售；发布与购买均检查绑定及可用采购账户。付款原子写入等待供应商的交付记录、采购任务和入队事件，不分配卡密库存。服务结果一次性交付，不设置次数、到期、续费或结果正文邮件；邮件仅发送私有订单链接。成功交付后激活服务权益，可在订单页及客户中心查看，且检查所有权、退款和撤销状态。

POST `/api/admin/suppliers/service-binding` (same-origin authenticated admin, both supplier and product update permissions) or use `bindServiceSupplierFn` with a service plan UUID, configured Dhru account UUID, product ID, product revision, and explicit maximum unit cost in minor units. It fetches only that product and account, stores a single binding, and returns the new draft revision. No bulk catalog synchronization or paid request occurs. Required service fields use existing order-input definitions with the exact upstream field keys; sensitive values are encrypted at checkout and decrypted only by the supplier worker. The service product editor now includes a single-service binding form. Save product edits first, select a matching Dhru account, enter the upstream ID and unit cost cap, read the service preview, review its name, unit cost and required fields, then bind/import. Preview is read-only and requires both update permissions. The UI invalidates a preview when its request changes. Binding refetches the service and compares its SHA-256 fingerprint with the reviewed name, price and field schema; a change returns `supplier_service_preview_changed` without catalog writes. The headless API can pass the optional `expectedServiceFingerprint` returned by `previewServiceSupplierFn` for the same guard. IMEI and text fields with only name/type/required metadata are imported as encrypted order inputs; IMEI stays text with 15-digit validation. Unknown types, constraints, duplicate or reserved keys fail before any write. Binding and a new immutable definition version share the revision-guarded transaction. Existing paid orders keep their old snapshots; pending-payment orders must be completed or canceled before rebinding. Review the draft and republish. Service checkout displays the latest imported definitions without automation key restrictions.

使用同源登录管理员请求 `POST /api/admin/suppliers/service-binding`（同时要求供应商和产品修改权限），或通过 `bindServiceSupplierFn` 传入服务规格 UUID、已配置的 Dhru 账户 UUID、product_id、产品修订号及以最小货币单位表示的采购成本上限。该接口只读取一个产品和账户，保存单个绑定，并返回新的草稿修订号，不进行全量同步或付费下单。客户字段使用现有订单输入定义，键名与上游一致；敏感值在结算时加密，仅采购执行器读取明文。服务商品编辑器现已提供单服务绑定表单：先保存商品，选择同币种与精度的 Dhru 账户，填写上游 ID 和单位成本上限，先读取服务预览，检查名称、单位成本和必填字段，再绑定并导入。预览是只读操作，同时要求两项修改权限；表单参数改变后预览失效。绑定时会重新读取服务，对照已预览名称、价格和字段定义的 SHA-256 指纹；变化时返回 `supplier_service_preview_changed`，不写入商品。无界面调用也可将 `previewServiceSupplierFn` 返回的指纹作为可选 `expectedServiceFingerprint` 传入绑定接口获得相同保护。当前仅导入只有 name/type/required 元数据的 IMEI 与文本字段，全部作为加密订单输入；IMEI 保持文本并校验 15 位数字。未知类型、额外约束、重复键或保留键会在任何写入前拒绝。绑定和新的不可变字段版本共用修订号保护事务；已付款订单保留原快照，待付款订单必须完成或取消后才可重新绑定。检查草稿后重新发布。服务结算显示最新字段定义，不受自动化字段键名格式限制。

Dhru service availability does not infer inventory from `stock_quantity` or expire the manual binding after 30 minutes. Before POST, the worker fetches a fresh account balance and a product quote and enforces the snapshotted cost cap. A selected account only reconciles thereafter; uncertain submission is never automatically POSTed again. Unsigned Dhru feedback only accelerates an authenticated GET for an already-known order UUID; it cannot deliver, alter the UUID, or supply customer result text. Migration `0008_service_products.sql` preserves the three rebuilt parent tables and their cascading children under D1 foreign-key enforcement.

Dhru 服务可用性不依赖库存数，也不会让手工绑定在 30 分钟后自动失效。采购前实时读取账户余额和单个产品报价，并检查订单保存的成本上限。选定账户后仅查询订单；不确定的提交不会自动再次 POST。未签名回调只能提前查询已知上游订单，不能交付结果、更换订单 UUID 或直接写入结果文本。迁移 `0008_service_products.sql` 在 D1 外键约束下保留重建父表及其级联子表。

## Customer service progress / 客户服务进度

The service product page explains that processing begins after payment and results appear on the order. Paid/fulfilling orders show localized progress for service deliveries awaiting supply, pending, or processing, and a support message for failed delivery. Existing visible-page polling updates the result; completed deliveries retain the private reveal endpoint. Customer entitlements identify service results as one-time service instead of unlimited quota, and use a service-result dialog label. No supplier credentials or unverified callback content is rendered.

服务商品页说明付款后自动处理，完成后在订单中查看结果。已付款或履约中的订单显示服务等待供应商、待交付、处理中状态的提示；失败时提示凭订单号联系客服。沿用可见页面自动轮询，完成后通过现有私有接口读取结果。客户权益显示“一次性服务”，不再误示无限次数；结果弹窗使用“服务结果”标题。不展示供应商凭据或未验证的回调内容。

Rendered component checks cover both locales, mixed stock/service deliveries, completed-result exclusion, and HTML escaping. Final validation passed: 733 unit/security, 283 integration and 23 Bun runtime tests (1,039 total); two existing TODO tests remain unexecuted. Typecheck, Biome and both Workers/Bun builds passed. Browser checks for themes, mobile and keyboard remain pending; these checks do not place a real supplier order.

组件渲染检查覆盖两种语言、卡密与服务混合交付、已交付结果不再显示处理中，以及 HTML 转义。全量检查通过：733 项单元及安全测试、283 项集成测试、23 项 Bun 运行时测试，共 1,039 项；原有两项 TODO 未执行。类型检查、Biome 和 Workers/Bun 构建通过；主题、手机和键盘的浏览器验证尚待完成，不会由这些检查触发真实供应商订单。
