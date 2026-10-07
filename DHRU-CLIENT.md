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

This change adds no provider registration, UI, catalog sync, queue consumer,
database migration or live payment smoke test.

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

本次只实现 Client 和模拟测试，不接 UI、Supplier Factory、队列或数据库，
不调用真实付费接口。
