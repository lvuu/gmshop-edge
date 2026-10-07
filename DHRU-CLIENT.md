# Dhru Client / Dhru 客户端

Server-only implementation: `src/features/suppliers/providers/dhru-client.ts`.
Official contract: https://github.com/dhru-com/reseller-api

## English

Construct `DhruClient` with a workspace API base URL ending in
`/api/reseller/v1` and a decrypted reseller Bearer token inside server code.
Never import it into customer components or log the token or order inputs.
The client reuses the project's hardened HTTPS outbound transport: public
destination checks, no redirects, bounded responses (4 MiB), 30-second reads
and 300-second submissions. Optional injected transport is for tests.

- `getAccount()`: profile, currency and exact decimal balance string.
- `listProducts()`: categories, products and original dynamic field extensions.
- `getProduct(id)`: endpoint data for numeric ID or UUID, preserving vendor fields.
- `submitOrder({ productId, fields, referenceId, feedbackUrl, quantity? })`:
  one product/order only; returns its validated receipt. Reserved input fields
  are overwritten with the explicit reference, callback and quantity.
- `getOrder(uuid)`: a single known UUID; status and plain-text replay.

No automatic retries. HTTP and API envelope status/code are both checked.
Errors omit upstream bodies, secrets and inputs. `DhruClientError.outcome`
is `rejected`, `uncertain` or `read_failed`; HTTP status, API code and
Retry-After are available where received. All client errors disable automatic
DomainError retries. A rejected response does not establish wallet refund.

On submission timeout, redirect, 5xx, malformed/oversized response or receipt
reference mismatch, reconcile in Fusion Pro before resubmitting. A reference ID
does not guarantee idempotency. The documented query endpoint accepts UUID,
not reference ID; unknown-UUID recovery remains manual. Callback replay is
base64, while getOrder replay is plain text; this client does not process callbacks.
Single-product endpoint data is preserved as a record because its complete shape
is not specified in the official README; mapping is a later adapter task.

The Client itself does not perform catalog sync, queue consumption or live
payment smoke tests. See the Provider registration section for account support.

## 简体中文

在服务端用以 `/api/reseller/v1` 结尾的工作区 API 地址和已解密的
Reseller Bearer Token 创建客户端。不要在前端导入，不记录凭据或客户输入。
复用项目已有 HTTPS 出站保护，拒绝重定向，限制响应为 4 MiB；
查询超时 30 秒，下单超时 300 秒。

五个方法分别读取账号、商品目录、单个商品、提交单个订单、按已知 UUID
查询单个订单。保留动态字段扩展、原始价格字符串和查询结果文本。
下单必填 referenceId 和 HTTPS feedbackUrl，数量默认为 1。

同时检查 HTTP 状态和 JSON 的 status/code，包括 HTTP 201 的业务拒绝。
不自动重试任何请求。下单超时、5xx、无效响应、重定向或回执不匹配均为
uncertain，必须核对上游后再提交。reference_id 不保证幂等，
官方查询接口未提供按 reference_id 找回订单的方法；未知 UUID 暂需人工核对。
错误不包含上游原文、Token 或客户字段，保留收到的状态码和 Retry-After。
rejected 不等于已经退款。商品详情响应保留为原始对象，待 Adapter 阶段映射。

Client 本身只封装请求和响应，不处理队列或真实付费验收。
供应商账号、Factory 和数据库支持见后面的注册说明。

## Supplier Provider registration / 供应商注册

The dhru provider is registered in the enum, credential schema and factory.
The account form uses a masked apiToken field. Leave it empty when editing
an existing account to keep its encrypted credentials. The existing vault
purpose and revision history are reused; old tokens remain readable for
reconciliation. Runtime construction decrypts only the selected revision.

Configure the workspace HTTPS origin (for example https://supplier.example),
not its API path. The adapter appends /api/reseller/v1. Choose the token wallet
currency and decimals explicitly. Connection testing reads the account and
returns its exact minor-unit balance; insignificant trailing zeros are removed,
but significant extra decimal precision and currency mismatches are rejected.

Migration 0006_dhru_provider expands accounts/bindings CHECK constraints and
preserves rows and indexes. Existing baseline migrations are unchanged. It uses
SQLite deferred foreign keys during table replacement; test coverage includes a
populated database with referencing rows. Apply through the normal migration
runner after review, not by editing an existing production baseline.

This is account registration only. Catalog import, SKU lookup, stock purchasing
and stock reconciliation fail explicitly with supplier_service_not_ready before
making any Dhru call. Service fulfillment and field mapping remain later work.
The previous Client methods can still be called directly from server code.

新增 dhru Provider、apiToken 凭据校验和 Factory 分派；后台账号表单提供
密码形式的 Token 输入，编辑时留空保留原凭据。复用已有加密用途、指纹和
版本历史，运行时按指定版本解密。API 地址填写工作区 HTTPS 域名原点，
Adapter 自动追加 API 路径。测试连接核对币种并精确转换余额，拒绝有效位
超出币种小数位的值，不进行浮点计算。

新增 0006 迁移扩展数据库约束，已有迁移不修改。测试覆盖空库、已有账号、
绑定、引用行和索引。此阶段未开放服务商品导入或采购，卡密履约入口明确
报错并停止，不向 Dhru 发送订单。需后续服务结果模型和字段映射完成后开放。
