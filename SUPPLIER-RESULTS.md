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

This step enables consuming verified service results. It does not create a
service product type or inputs, implement Dhru submit/reconcile callbacks,
enable automatic Dhru purchasing, or deploy to production. The Dhru adapter
continues to block stock purchasing until service-order plumbing is implemented.
Integration tests provision a service delivery record explicitly.

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

本阶段未新增 service 商品、动态输入或 Dhru 自动下单；测试显式构造
service 交付记录。生产部署和真实付费验收尚未进行。
