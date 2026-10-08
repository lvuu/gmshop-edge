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

## Failed procurement and result recovery / 采购失败与结果恢复

Customer order queries present an awaiting service delivery as failed when its matching supplier order is terminally failed. The correlation uses the unique order-item index and also checks the delivery ID; it does not scan all procurement orders, expose the provider's error, or alter delivery/payment state. Manual reselection to pending automatically restores the progress display.

客户订单查询在对应采购任务终止失败时，将等待供应商的服务交付展示为失败。关联使用订单项唯一索引，并核对交付 ID；不扫描全部采购任务，不暴露上游错误，也不更改交付或支付状态。管理员重新选择采购账户、任务恢复待处理后，客户进度提示随之恢复。

Private result reads now clear displayed content whenever the order, delivery or guest proof changes, abort superseded requests and ignore late responses even when transport cancellation is ignored. React StrictMode effect replay still loads correctly. Network failures, denied reads and blank responses show an accessible retry action. Order queries also hide service-result availability after refund or grant revocation, allowing refreshed screens to unmount a previously displayed result. The retry uses the current proof and the same server authorization; it cannot resubmit a supplier purchase. Copy audit transport failures do not produce an unhandled rejection.

私有结果读取在订单、交付或访客凭据改变时立即隐藏原内容，取消已被替代的请求，即使传输层忽略取消也不会采纳迟到响应。React StrictMode 重放后仍可正常加载。网络失败、权限拒绝及空响应提供可访问的重试按钮；订单查询也在退款或权益撤销后隐藏服务结果入口，使刷新后的页面卸载先前已展示的结果。重试使用当前凭据及现有服务端校验，不会重新提交供应商采购。复制审计的网络失败不会产生未处理的异常。

Checks cover stale responses, changed proofs, retry, effect replay, blank responses, failed/reselected procurement, indexed correlation, and refusal to reveal service results after grant revocation or refund. Browser theme/mobile/keyboard checks remain pending; real supplier purchase and production deployment are outside this change.

检查覆盖迟到响应、凭据改变、重试、效果重放、空响应、采购失败及重新选择、索引关联，以及权益撤销或退款后拒绝读取服务结果。主题、手机和键盘浏览器验证仍待完成；本次修改不进行真实采购或生产部署。

Validation: 738 unit/security, 284 integration and 23 Bun runtime tests passed (1,045 total); two existing TODO tests were not executed. Typecheck and Biome passed, with existing unrelated Biome notices.

验证：738 项单元及安全测试、284 项集成测试、23 项 Bun 运行时测试通过，共 1,045 项；原有两项 TODO 未执行。类型检查和 Biome 通过，保留已有无关 Biome 提示。

## Administrative recovery / 后台恢复

Recovery requires the existing suppliers/test permission and a parent order that is paid or fulfilling. Reselection is available only for pending/selecting/failed procurement with no selected account, account lock or known upstream order. Reconciliation queues only submitting/uncertain procurement that already has a selected account; it keeps the original account, credentials revision and upstream identity. Supplied/refunded procurement and cancelled/refunded/completed customer orders cannot be reactivated through these actions. The order list returns parent status and lock time so its buttons follow the same eligibility policy as the server.

恢复操作继续要求 suppliers/test 权限，客户订单须为已付款或履约中。重新选择账户仅适用于待处理、选择中或失败的采购任务，并且不能存在已选账户、账户锁或已知上游订单。查询上游仅为已选账户且提交中或状态不确定的任务入队，保留原账户、凭据版本及上游订单身份。已供货或已退款采购任务，以及已取消、已退款或已完成的客户订单，不能由这些操作重新激活。后台列表返回客户订单状态和账户锁时间，按钮与服务端共用资格规则。

A single D1 transaction compares the read procurement state, update time, selected account, account lock and upstream ID, and rechecks the parent status. Only a matching row can create the uniquely identified outbox reference; the state update and a bounded audit record require that exact reference. A losing race reports a conflict without overwriting completion/locking, adding an outbox event or recording false audit success. Audit persistence failure rolls back all three writes. Queue payloads remain supplier-order references only.

同一个 D1 事务比较读取时的采购状态、更新时间、已选账户、账户锁和上游 ID，并再次检查客户订单状态。匹配时才创建带唯一标识的入队事件，状态更新和精简审计记录均依赖该事件。竞态失败返回冲突，不覆盖完成或锁定状态，不写入入队事件，也不记录虚假审计成功。审计持久化失败会回滚全部三项写入。队列消息仍只包含采购任务引用。

Integration checks cover failed-purchase recovery and authenticated reconciliation with a single Dhru POST, ineligible parent states, completion/account-lock/refund races, reference-only payloads and audit-failure rollback. Browser checks and a real paid supplier smoke remain pending; this change does not deploy production or place a live purchase.

集成检查覆盖失败采购恢复、仅一次 Dhru POST 后的认证查询、不符合条件的客户订单状态、完成/账户锁/退款竞态、仅引用的队列消息和审计失败回滚。浏览器及真实付费供应商验收仍待完成；本轮不部署生产环境或执行真实采购。

Recovery validation: 738 unit/security, 288 integration and 23 Bun runtime tests passed (1,049 total), with two existing TODO tests unexecuted. Typecheck, Biome and Workers/Bun builds passed.

恢复流程验证：738 项单元及安全测试、288 项集成测试、23 项 Bun 运行时测试通过，共 1,049 项；原有两项 TODO 未执行。类型检查、Biome 及 Workers/Bun 构建通过。

## Recovery dispatch feedback / 恢复投递反馈

The recovery action returns whether its committed outbox event was published immediately or remains pending. A queue transport or post-send registry failure does not misreport the already-committed recovery as a failed mutation. The scheduled supplier publisher retries pending events; duplicate queue delivery remains handled by the existing procurement idempotency. Immediate dispatch targets this recovery's exact outbox ID and leaves older pending events for the normal scheduler. It never starts a supplier purchase within the administrative request.

恢复操作返回已提交的入队事件是已立即投递，还是等待投递。队列传输或发送后登记失败，不再把已持久化的恢复操作误报为变更失败。定时供应商投递器重试待投递事件；重复队列交付仍由现有采购幂等逻辑处理。立即投递只针对本次恢复的确切事件 ID，旧待投递事件保留给正常调度器。后台请求不会直接执行供应商采购。

The UI distinguishes published from saved/pending feedback. It maps only reviewed conflict, unavailable, locked and missing-order codes to English/Chinese copy, using a generic fallback for all unreviewed errors. Both success and error invalidate the supplier-order query cache before refreshing the table, including caches with an infinite stale time. A failed action is never automatically submitted again.

界面区分已投递与已保存待投递。仅将经过检查的状态冲突、操作不可用、账户锁定和订单不存在代码映射为中英文文案，未知错误使用通用提示。成功和失败均在刷新表格前使采购订单查询缓存失效，即使缓存配置了无限有效期。失败操作不会自动重新提交。

Integration checks cover transport failure followed by scheduled publication and targeted publication that preserves an older pending event. Component checks cover pending-success feedback, localized stale-state feedback and query-cache invalidation; both-locale checks verify raw errors are hidden. Browser and real paid-provider smoke remain pending; no production deployment or live purchase is performed.

集成检查覆盖传输失败后由调度器投递，以及精确投递时保留旧待投递事件。组件检查覆盖待投递成功反馈、状态冲突的本地化提示和查询缓存失效；双语言检查确认隐藏原始错误。浏览器及真实付费供应商验收仍待完成，本轮不进行生产部署或真实采购。

The final run exposed an existing supplier-API authentication test dependency on the real minute window and on a preceding test's counters. The fixture now fixes Date.now without replacing timers, clears rate-limit/replay rows between cases, and gives its 60-request flood check a scoped 15-second budget. Production authentication limits are unchanged.

最终检查发现已有供应商 API 鉴权测试依赖真实分钟窗口和前一个用例的计数。测试现固定 Date.now，但不替换定时器；每项用例清理限流和重放记录；60 次请求的洪泛检查使用局部 15 秒时限。生产鉴权限额保持原值。

Final feedback validation: 742 unit/security, 290 integration and 23 Bun runtime tests passed (1,055 total); two existing TODO tests remain unexecuted. Typecheck, Biome and both Workers/Bun builds passed.

最终反馈验证：742 项单元及安全测试、290 项集成测试、23 项 Bun 运行时测试通过，共 1,055 项；原有两项 TODO 未执行。类型检查、Biome 及 Workers/Bun 构建通过。

## Upstream identity boundaries / 上游身份边界

Dhru product reads reject an explicitly mismatched echoed ID before binding or purchase preflight. Submitted order UUIDs must satisfy the same format accepted by single-order GET. Authenticated GET still accepts the documented response without identity fields, checks quantity as before, and refuses an explicitly different echoed order_uuid if present. Service-input snapshots are validated before both submit and reconcile. Read failures retain the original locked purchase instead of delivering or POSTing again; fixed provider error labels are localized through existing messages.

Dhru 商品读取在绑定或采购预检查前拒绝明确不匹配的回传 ID。提交得到的订单号须符合单订单 GET 的相同格式。认证 GET 仍接受官方不含身份字段的响应，保留数量检查；若明确回传不同 order_uuid，则拒绝该结果。提交和状态查询前都校验服务输入快照。读取失败保留原锁定采购，不交付也不再次 POST；固定供应商错误代码沿用现有本地化消息。

Checks cover numeric/UUID identifier styles, malformed receipts, optional echoed order IDs and invalid snapshots. D1 integration checks show wrong product reads cannot bind or purchase, wrong-order results create no delivery content/outbox, and a later correct query delivers with one POST. Invalid receipt IDs remain uncertain with no GET or resubmission. No schema migration, production deployment or real purchase is part of this change. Browser checks remain pending.

检查覆盖数字与 UUID 两种标识、无效回执、可选回传订单号和无效输入快照。D1 集成检查验证错误商品不能绑定或采购，错误订单结果不生成交付内容或事件，后续正确查询仍仅使用一次 POST 即可交付。无效回执订单号保持结果不确定，不执行 GET 或重下单。本轮不增加数据库迁移、不部署生产环境或执行真实采购。浏览器检查仍待完成。

Identity validation: 753 unit/security, 293 integration and 23 Bun runtime tests passed (1,069 total); two existing TODO tests remain unexecuted and the manual provider smoke file is skipped. Typecheck, Biome and Workers/Bun builds passed.

身份校验验证：753 项单元及安全测试、293 项集成测试、23 项 Bun 运行时测试通过，共 1,069 项；原有两项 TODO 未执行，真实供应商手工测试文件跳过。类型检查、Biome 及 Workers/Bun 构建通过。

## Purchase receipt persistence / 采购回执持久化

Once submitOrder starts, an unexpected adapter, fulfillment or receipt-persistence error cannot authorize account reselection. Only a definitive rejection whose release was persisted can continue to another candidate. The worker retains the selected account, credential revision and request reference, records any already received upstream order ID, and reports a fixed uncertainty error. The fallback update cannot overwrite supplied/refunded state or another selected account, and preserves an existing upstream ID.

submitOrder 开始后，适配器、交付或回执持久化的意外错误不能作为重新选购的依据。仅在明确拒单且已保存账号释放结果后，才可继续选择另一个账号。任务保留已选账号、凭据版本和请求引用，尽可能保存已收到的上游订单号，并返回固定的结果不确定错误。补偿更新不能覆盖已供应、已退款状态或另一个已选账号，也不会替换已有上游订单号。

D1 fault-injection checks cover a rejected first receipt write followed by authenticated GET recovery and private delivery with exactly one POST. When both the receipt write and fallback write fail, the original submitting claim remains; after storage recovers, the missing-ID path performs neither GET nor a second POST. Truly lost order IDs still require operator investigation; arbitrary manual order-ID attachment is not implemented. No migration or live purchase is required. Browser checks remain pending.

D1 故障注入检查覆盖首次回执写入失败后，通过认证 GET 恢复并私密交付，整个过程仅一次 POST。回执和补偿写入均失败时，原提交占用保持；存储恢复后，缺失订单号的路径既不执行 GET，也不再次 POST。真正丢失订单号仍需运营核查，尚未实现任意手动绑定订单号。本轮无需迁移或真实采购，浏览器检查仍待完成。

Receipt-persistence validation: 753 unit/security, 295 integration and 23 Bun runtime tests passed (1,071 total). Two existing TODO tests remain unexecuted and the manual provider smoke file is skipped. Typecheck, Biome and both Workers/Bun builds passed, retaining existing unrelated Biome notices.

回执持久化验证：753 项单元及安全测试、295 项集成测试、23 项 Bun 运行时测试通过，共 1,071 项。原有两项 TODO 未执行，真实供应商手工测试文件跳过。类型检查、Biome 和 Workers/Bun 构建通过，保留已有无关 Biome 提示。

## Durable reconciliation polling / 持久化核验轮询

The shared Workers/Bun scheduler now queues due uncertain purchases before publishing supplier events. Eligible rows require a selected account, a due next_retry_at and a paid/fulfilling customer order. Dhru additionally requires a known upstream order ID; established stock providers retain their request-reference reconciliation path. The scheduler uses the existing retry and aggregate indexes and bounded batches. A pending supplier event suppresses another poll for the same purchase.

Workers/Bun 共用调度器现在会先为到期、结果待核验的采购安排队列事件，再投递供应商事件。任务须已选账号、next_retry_at 到期且客户订单已支付或正在交付；Dhru 还须有已知上游订单号，原有卡密供应商保留按请求引用核验的路径。调度器使用现有重试和事件聚合索引，限制批量大小；已有待投递供应商事件时，不为同一采购重复安排轮询。

Each poll atomically inserts a reference-only outbox event and moves next_retry_at at least one minute forward, with state/version/due-time and parent-status checks repeated at write time. Concurrent schedulers cannot both claim the same due revision. Failed transport leaves the event pending; even an abandoned published message is eligible for a later poll. Once a worker persists normal processing/uncertainty, its queue message is acknowledged rather than exhausting transport retries. Outages and unexpected errors retain the existing retry policy.

每次轮询原子写入仅含采购 ID 的事件，并将 next_retry_at 推进至少一分钟；写入时再次检查状态、版本、到期时间和客户订单状态。并发调度器不能同时占用同一到期版本。投递失败会保留待投递事件；已投递但未被处理的消息也可由后续轮询恢复。任务保存正常处理中或待核验状态后，队列确认当前消息，避免耗尽传输重试次数；停机及意外错误沿用原重试策略。

Dhru purchases without an upstream ID keep the original account claim and enter a manual hold with next_retry_at NULL. Duplicate messages do not read credentials, decrypt customer inputs, claim API budget or make an upstream request. Unknown IDs are not automatically replaced or resubmitted. Tests cover nine processing cycles through the real queue handler followed by private delivery with one POST; concurrent scheduling, transport/abandoned-message recovery, eligibility and write races, rollback and query plans. No migration, production deployment or live purchase is performed; browser acceptance remains pending.

缺少上游订单号的 Dhru 采购保留原账号占用，并以 next_retry_at 为空进入人工核查状态。重复消息不会读取凭据、解密客户输入、占用 API 限额或请求上游；也不会自动替换订单号或重新下单。测试覆盖真实队列处理器连续九轮处理后完成私密交付，整个过程仅一次 POST；同时覆盖并发调度、投递及消息丢失恢复、资格与写入竞争、回滚和查询计划。本轮不增加迁移、不部署生产环境或执行真实采购，浏览器验收仍待完成。

Polling validation: 753 unit/security, 301 integration and 23 Bun runtime tests passed (1,077 total). Two existing TODO tests remain unexecuted and the manual provider smoke file is skipped. Typecheck, Biome and Workers/Bun builds passed, retaining existing unrelated Biome notices.

轮询验证：753 项单元及安全测试、301 项集成测试、23 项 Bun 运行时测试通过，共 1,077 项。原有两项 TODO 未执行，真实供应商手工测试文件跳过。类型检查、Biome 及 Workers/Bun 构建通过，保留已有无关 Biome 提示。

## Final upstream rejection / 上游最终拒绝

A definitive rejection after account locking or a known upstream order now ends procurement in failed state and clears next_retry_at. It retains the original account, credentials revision, request reference, upstream order ID and pricing history. It cannot enter automatic or administrative reselection. A definitive rejection before acceptance keeps the existing account-release/failover behavior. A normal service rejection does not degrade the supplier connection's health.

账号已锁定或已有上游订单号后收到明确拒绝，采购现在会转为失败并清空 next_retry_at，同时保留原账号、凭据版本、请求引用、上游订单号及价格记录。该采购不能自动或通过后台重新选购。接单前的明确拒绝仍沿用原账号释放及切换逻辑；正常服务拒绝不会降低供应商连接健康状态。

The terminal update rechecks state, version, account, credential revision, lock, request reference, upstream identity and paid/fulfilling parent status. A conflicting completion, refund or changed identity is preserved and returns a retryable fixed conflict code. Failed persistence leaves the accepted purchase available for authenticated reconciliation; it does not authorize another POST. Customer order reads show the existing localized service failure without upstream replay text or result access. The customer payment and refund policy are unchanged; an upstream rejection does not automatically refund a customer payment.

终态更新再次核对状态、版本、账号、凭据版本、锁定、请求引用、上游身份以及客户订单已支付或正在交付状态。竞争中先完成的交付、退款或身份变更会被保留，并返回可重试的固定冲突代码。写入失败时保留已接单采购，可再次认证查询，但不能重新 POST。客户订单使用现有本地化服务失败状态，不公开上游回复或开放结果访问。客户支付及退款策略保持原有行为，上游拒绝不会自动退回客户付款。

Integration checks cover the real queue handler acknowledging a final rejection, blocked recovery actions and polling, private result exclusion, unrelated/mismatched-quantity rejections, failed terminal persistence and fulfillment/refund/identity races. No migration, deployment or live purchase is performed; browser acceptance remains pending.

集成检查覆盖真实队列处理器确认最终拒单、禁止恢复操作及轮询、私密结果排除、错误订单或数量的拒绝、终态写入失败，以及交付、退款和身份变更竞争。本轮不增加迁移、不部署或执行真实采购，浏览器验收仍待完成。

Final-rejection validation: 753 unit/security, 305 integration and 23 Bun runtime tests passed (1,081 total). Two existing TODO tests remain unexecuted and the manual provider smoke file is skipped. Typecheck, Biome and Workers/Bun builds passed, retaining existing unrelated Biome notices.

最终拒单验证：753 项单元及安全测试、305 项集成测试、23 项 Bun 运行时测试通过，共 1,081 项。原有两项 TODO 未执行，真实供应商手工测试文件跳过。类型检查、Biome 及 Workers/Bun 构建通过，保留已有无关 Biome 提示。

## Manual-hold operations / 人工核查操作

An uncertain Dhru purchase with a selected account and no upstream order ID now displays a localized manual-review badge and a readable explanation. Both reconciliation and reselection are disabled; a submitting purchase is not prematurely labeled as a manual hold. A known Dhru order can still reconcile. The shared action policy also prevents reselection of any known upstream order, including historical rows without a selected account.

已选账号但缺少上游订单号的 Dhru 待核验采购，现在会显示中英文人工核查标记及完整说明，禁止核验和重新选购；正常提交中的采购不会被提前标为人工核查。已有 Dhru 订单号时仍可核验。共用操作规则同时禁止对任何已有上游订单号的采购重新选购，包括未保留已选账号的历史记录。

The administrative server enforces the same rules before writing an outbox or audit record and rechecks eligibility during the atomic write. It returns a fixed missing-ID code for otherwise eligible Dhru reconciliation attempts; reviewed localized messages hide raw exception details. Supplier provider and origin in the list come from the immutable purchase snapshot, and action eligibility uses that same provider rather than the mutable product binding. Existing structured permission checks remain on the administrative server entries.

后台服务端在写入队列事件或审计前执行相同限制，并在原子写入时再次检查资格。原本可核验但缺少订单号的 Dhru 请求返回固定代码，由经过检查的本地化消息隐藏原始异常详情。列表中的供应商类型及来源地址读取采购快照，操作资格也使用该快照供应商，不依赖可变的商品绑定。后台入口继续执行原有结构化权限检查。

The list labels a separate purchase reference: Dhru uses the exact job UUID submitted as reference_id; other providers retain their stored request reference. Operators can search either reference, the customer order number or the upstream order ID. Component checks verify both languages, readable hold text, disabled buttons, hidden private errors and the exact Dhru reference. D1 checks cover missing-ID rejection without writes, changed bindings, lost-ID races, historical known orders and reference searches. No arbitrary order-ID attachment, migration, deployment or live purchase is introduced. Browser/theme/mobile/keyboard acceptance remains pending.

列表单独标注采购参考编号：Dhru 使用实际提交为 reference_id 的任务 UUID，其他供应商保留已存储的请求引用。可按这些编号、客户订单号或上游订单号搜索。组件检查覆盖双语言、可读核查说明、禁用按钮、隐藏私密错误和真实 Dhru 参考编号；D1 检查覆盖缺号时无写入拒绝、绑定变更、订单号丢失竞争、历史已知订单及编号搜索。本轮不引入任意订单号绑定、迁移、部署或真实采购，浏览器、主题、手机及键盘验收仍待完成。

Manual-hold validation: 760 unit/security, 309 integration and 23 Bun runtime tests passed (1,092 total). Two existing TODO tests remain unexecuted and the manual provider smoke file is skipped. Typecheck, Biome and Workers/Bun builds passed, retaining existing unrelated Biome notices.

人工核查验证：760 项单元及安全测试、309 项集成测试、23 项 Bun 运行时测试通过，共 1,092 项。原有两项 TODO 未执行，真实供应商手工测试文件跳过。类型检查、Biome 及 Workers/Bun 构建通过，保留已有无关 Biome 提示。
