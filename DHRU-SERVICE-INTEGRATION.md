# Dhru service integration / Dhru 服务订单接入

## Implemented flow

The server-only Dhru client supports `getAccount`, `listProducts`, `getProduct`,
`submitOrder` and `getOrder`. Accounts use encrypted, revisioned `apiToken`
credentials. A formal `service` product uses a manually reviewed binding to one
upstream service; it never allocates stock. Existing stock, download and automation
products keep their delivery paths. Full Dhru catalog synchronization is deferred.

The product editor previews one service, its exact price and supported input
fields. Binding refetches the service and checks the reviewed fingerprint before
saving a new immutable input-definition version. Checkout validates those fields
and encrypts sensitive values. Only payment confirmation atomically creates the
supplier task and its Outbox event. Before the single POST, the worker refreshes
the account balance and quote and checks the snapshotted cost cap.

A receipt fixes the selected account, credential revision and upstream UUID.
Processing completes only after an authenticated order query reports a matching,
valid result. The delivery and its event commit atomically; the encrypted result
is available through the existing customer ownership and refund/revocation checks.
Unsigned feedback at `/api/suppliers/dhru/callback/$accountId` only accelerates
queries for a known order; it cannot deliver result text or replace the UUID.

An uncertain POST is never automatically resubmitted. Unknown-UUID recovery needs
manual supplier reconciliation. The admin recovery action can queue a query for
an eligible known order; it cannot unlock a submitted account or reactivate a
completed/refunded customer order. File uploads and remote-specific interaction
need additional implementation before those services can be offered.

## Upgrade and deployment

1. Merge the reviewed `feature/dhru-supplier` PR into `main` after CI passes.
   The branch includes the main storefront CSP/nonce fix and locked router patch.
   Use `.bun-version` and `bun install --frozen-lockfile` to retain that patch.
2. Before upgrading an existing store, retain a recoverable D1 backup and the
   previous Worker version. New migrations are `0006_dhru_provider.sql`,
   `0007_supplier_service_result.sql` and `0008_service_products.sql`. They rebuild
   constrained parent tables and preserve dependent rows; never replace the
   installed database with the clean-install baseline or run local fixtures remotely.
3. The `main` Release workflow calls `Deploy Cloudflare Workers`. A manual run of
   that deployment workflow on `main` follows the same path. Both run translations,
   types, lint, tests and Workers/Bun builds before remote resource preparation or
   migrations. Existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository
   secrets are reused. Remote preparation resolves D1/KV IDs, checks R2 and both
   Queues, applies pending migrations, then builds and publishes the Worker.
4. After deployment, check the existing storefront and customer/admin pages on
   the configured origin, and inspect the deployment log and Queue/Cron health.
   Repeat service screens in both locales/themes, at mobile width and by keyboard.
   For local nonpaid acceptance, `bun run seed:local` creates a disabled `.invalid`
   demo account, a draft $1 service and five order states; it cannot purchase Dhru.
5. In admin, configure the real Dhru workspace HTTPS origin, API token and wallet
   currency. Test the connection, create a `service` product, preview and bind only
   the chosen roughly $1 upstream service with an explicit minor-unit cost cap,
   then review and publish the draft. A live paid smoke is a separate manual action.
   Verify Paid → Queue → Dhru → Processing → Success and the private result;
   confirm the upstream account contains exactly one matching submission.

Empty-D1 installation tests and a populated pre-Dhru D1 upgrade test cover the
migration path. The upgrade test compares all rows in 13 affected/history tables,
checks foreign keys and confirms migration staging tables are removed. Router
regression tests cover early request nonces and hydration with Chromium-style
hidden nonce attributes. These are automated checks; full browser acceptance of
the newly deployed branch and a real paid Dhru order still require live evidence.

Implementation details and recovery contracts: [SUPPLIER-RESULTS.md](SUPPLIER-RESULTS.md).
Client contract: [DHRU-CLIENT.md](DHRU-CLIENT.md).

## 简体中文

五个 Dhru Client 方法、加密版本化账户凭据、正式 `service` 商品、单服务手工
绑定、动态输入验证与加密快照、付款后采购队列及客户私有结果均已接通。
卡密、下载和自动化保留原履约流程，全量目录同步继续延后。

后台先预览一个服务的名称、价格和支持的字段；绑定时重新读取并比较指纹，
成功后保存新的不可变字段版本。付款确认原子写入采购任务和入队事件。
采购前读取实时余额和报价，按订单快照的成本上限检查，然后只提交一次。
回执锁定采购账户、凭据版本和上游订单号。只有认证查询返回有效成功结果才
原子加密交付，客户查看仍检查归属、退款和撤销状态。

未签名回调只提前查询已知上游订单，不能直接交付。提交不确定时绝不自动
重下单；没有上游订单号须人工核对。后台恢复可以对符合条件的已知订单入队
查询，不能解锁已提交账户或重启完成/退款订单。文件上传及远程专用交互仍需
额外实现后才能出售对应服务。

部署步骤：

1. CI 通过后将审核过的 Dhru PR 合入 `main`。分支已包含 Chrome 空白页的
   CSP/nonce 修复和锁定依赖补丁；按 `.bun-version` 安装，使用冻结锁文件。
2. 升级已有商店前保留可恢复的 D1 备份及旧 Worker 版本。新增迁移为
   0006、0007、0008，扩展 Provider、交付和产品类型并保留历史数据。
   不覆盖现有数据库基线，不向远程库导入本地验收数据。
3. `main` 的 Release 自动调用 Cloudflare 部署工作流；也可在 `main` 手动运行。
   两种入口均先执行翻译、类型、lint、测试与 Workers/Bun 构建，再准备资源和
   迁移数据库，沿用已配置的两个 Cloudflare Secrets。资源检查覆盖 D1、KV、
   私有 R2、commerce Queue 和死信 Queue，然后执行待应用迁移并发布 Worker。
4. 部署后检查配置域名上的商店、客户及后台页面，以及部署日志和 Queue/Cron。
   服务页面验收覆盖中英文、双主题、手机宽度及键盘。非付费本地验收可运行
   `bun run seed:local`：生成禁用的 `.invalid` 账户、草稿 $1 服务和五种订单状态，
   不会采购真实 Dhru 服务。
5. 后台配置真实 Dhru 工作区 HTTPS 原点、Token 和钱包币种，测试连接。
   创建 `service` 商品，只预览并绑定选定的约 $1 服务，明确填写最小货币单位
   成本上限，审核草稿再发布。真实付费测试单独手工执行，验证
   Paid → Queue → Dhru → Processing → Success、客户私有结果及上游仅一次提交。

空 D1 安装与已有数据按顺序升级均有自动化测试；升级检查 13 张历史/关联表
全部行保留、外键完整和临时表清理。nonce 测试覆盖早期流初始化及 Chrome
隐藏 nonce 属性时的页面接管。新分支部署后的完整浏览器验收和真实付费
Dhru 订单仍需现场证据，自动化测试不替代这两项验收。
