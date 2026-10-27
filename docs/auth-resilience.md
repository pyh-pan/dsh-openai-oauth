# 授权故障诊断与整体修复：0.3.9

记录日期：2026-10-27。目标环境：macOS 26.5.2 / arm64，DSH Desktop 0.2.1-rc.3，Electron 44.7.0 / Node 24.21.0。

**状态：隔离开发候选，不是实机恢复声明。** 0.3.8 的真实切档验收失败；0.3.8-diagnostic.1 只收集证据。0.3.9 的合成、原生和无凭据网络检查与真实账号验收分开记录。未经新的空闲窗口确认，没有更新活跃 Desktop 链接；没有主动使用真实 grant 刷新、推理或撤销。

## 结论与证据强度

| 判断                                     | 证据与边界                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不是把旧 Codex 接口误当成 SIWC           | 已检查本机 pi 1.3.0 的新 `openai` 发布源码；它与本插件使用相同 SIWC authorize/token/resource/scopes。独立的 `openai-codex` 才是 legacy。                                                            |
| 用户遇到的真实失败发生在授权刷新连接链路 | 诊断截图可见 `AUTH_REQUEST_UNCONFIRMED`、`phase=refresh`、`UND_ERR_CONNECT_TIMEOUT`。不是服务端明确拒绝 grant 的证据。                                                                              |
| 系统解析路径是最强的网络根因证据         | 同机 Node/Electron 出现约 10.5 秒建连超时；`getaddrinfo` 各种地址族/绝对域名探针超过 3500 ms 截止，而 c-ares 查询和对已配置 DNS 的查询约 117–200 ms 返回，原域名/SNI/TLS 校验下的 IPv4 HTTPS 正常。 |
| 不能把 DNS 相关性夸成完整实机 trace      | 截图右侧裁切，完整 stage/elapsed/attempts 未取得；该记录还是 runtime 的首失败，不必对应最后一次点击。无法据此证明某次旧 grant 已轮换、失效或被撤销。                                                |
| 0.3.8 是相关修复，不是本次真实恢复       | 它避免“还剩 59 秒有效期却提前刷新”的一个触发点；目录冷缓存或真正过期时仍会刷新，用户确实再次报错。                                                                                                  |
| 不只需要调网络参数                       | 已复现跨等待者顺序重交旧刷新代际、200 后验证/存储失败仍可重用、响应体忽略 abort 后超时不退出，以及新本地目录设计引出的冷会话压缩前置依赖。                                                          |

因此修复原则是：**本地选择不写授权；真实调用独立验证；网络等待有界；不确定写结果必须跨进程隔离；会话保护不能靠假上下文或跳过压缩换可用性。**

## 为什么 pi 看起来正常，而 DSH 仍会失败

对比的是 `pi-coding-agent@1.3.0` / `pi-ai@1.3.0` 的新 `openai`，不是 legacy Codex。

| 项目                    | pi 新 `openai`                                                                                                            | 本插件原链路 / 0.3.9 处理                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 浏览器授权              | `https://auth.openai.com/api/accounts/authorize`                                                                          | 相同，不迁移协议                                                                                                 |
| code exchange / refresh | `https://auth.openai.com/api/accounts/oauth/token`                                                                        | 相同，刷新使用 callback-issued client ID                                                                         |
| resource / inference    | `https://api.openai.com/v1`、公开 Responses                                                                               | 相同，不借用 pi 凭据或 backend-api                                                                               |
| 初次注册与 scopes       | `dynamic_agent_client`；PKCE/state/nonce；`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` | 相同；本插件保留注册、host identity、RS256/JWKS/subject 校验                                                     |
| 模型目录                | 发布包内置 catalog，可叠加 pi.dev；该 provider 不实时 GET OpenAI `/models`                                                | 使用账号实际 `/v1/models`，只接收 `visibility=list`，不抄静态模型或权限                                          |
| CLI 传输                | external Undici 8.10.2；代理感知 dispatcher；替换 global fetch；H2 关闭，CONNECT tunnel，地址族尝试窗口 2000 ms           | 原先依赖 Host fetch；现在仅组件私有直连可使用受约束解析/HTTPS，代理、未知策略仍交回 Host，不改 global dispatcher |
| 刷新时机                | 存储到期时间减 3 分钟，resolver 默认余量 5 分钟，通常等效提前约 8 分钟                                                    | 实际准备保留 60 秒余量；本地目录选择从刷新可用性中解耦                                                           |
| 授权预算                | 统一 resolver 刷新 signal 15 秒；token helper 本身无重试                                                                  | 单次 token HTTP 共享 12 秒，包括 backoff、headers、body；逻辑网络维护预算 20 秒                                  |
| 重试责任                | 推理 SDK `maxRetries:0`；外层 Agent 另有重试                                                                              | 推理仍由 Host 负责；token POST 只在证实 pre-connect/未写出时有限重试                                             |

pi 与 DSH 的 global fetch 不一定是同一实现，且 pi 离线目录不会因为改推理强度就访问授权域名。**pi 一次推理正常，不证明当次发生过刷新，更不证明 `auth.openai.com` 的所有路径正常。** 未读取 pi auth.json，也没有 pi 实际刷新成功的运行时证据。

曾在网络恢复窗口比较 250/2000 ms、H1/H2、external Undici 与 stock fetch；它们都约 0.7 秒成功。不能把这组同时恢复的结果当作“改 2000 ms/禁 H2 已定因”。没有写死 OpenAI IP，也没有更换公共 DNS。

pi 主源位置：`dist/core/http-dispatcher.js`、`pi-ai/dist/auth/oauth/openai-chatgpt.js`、`pi-ai/dist/auth/resolve.js`、`pi-ai/dist/providers/openai.js`、`pi-ai/dist/api/openai-responses.js`。这些是本机精确发布包的代码事实，不是 pi 所有运行方式的保证。

## 原故障链与已复现缺陷

原链路中，原生 `SessionController.selectModel` 检查模型可用性，目录缓存过期后进入 account access，可能触发刷新。授权连接故障被原生封装为 `session/model-unavailable`，所以用户只是改一个本地选项，也会遇到授权错误。

1. **锁只防并发，不防顺序重放。** 两个 manager、12 个等待者，首个未确认刷新失败后，旧实现实际调用 refresh 12 次，而不是 1 次。
2. **收到 token 响应不等于安全提交。** 新身份验证失败、JWKS 失败、replacement 写盘失败，都可能发生在上游已经轮换之后；不能让下一调用者继续交旧 token。
3. **有 signal 不等于等待一定有界。** token endpoint 已回 headers，但 body 不响应 abort 时，旧 15 ms 请求在 80 ms 后仍 pending。
4. **退出的本地存储失败也不能复活旧凭据。** 远端已确认撤销，而本地清除失败时，仅进程内的 blocked flag 不足以约束重建的 manager。
5. **持久模型目录不能成为上下文权威。** 原生 pressure compaction 在 `agent/pre-step`，早于 Agent 的实际 `Llm.prepareCall`。恢复已有 request/header 的会话时，若只读无 context 的 UI metadata，会在比较 threshold 之前触发 `TargetPressureConfigError`；不能以新建空会话正常替代这个回归。

这些是受控 fixture 或实际原生服务可复现的行为。它们不证明真实账号已经发生 token-family revocation。

## 0.3.9 的完整处理

### 1. 选择目录与真实调用分开

`ModelCache` 仅保留经过账号目录验证的 ID、名字、推理档位/默认值；不保留 token、权限、额度、contextWindow 或附件能力。使用 native cache path 下的独立命名空间，以 credential-store 的 host identity、account key、issuer、subject 派生文件名；不是把 `dshCachePath` 当成自动 profile 隔离。文件原子替换、权限受限，损坏/未知格式按 cache miss 处理。

- `listModels/resolveModel` 可使用上次验证的选择 metadata；不因 access token 过期而自动做 token POST。
- 没有已验证目录时，只允许用仍有效的 access 读目录；需要续期则提示显式操作，不编造模型。
- 真正 `prepareCall` 先检查授权，再取得 credential-generation-bound 的运行期能力（最多 60 秒缓存）；prepared snapshot 不依赖随后可被 invalidate 的可变缓存。
- 发送前再次检查选择/凭据代际、实际 reasoning choices、附件完整性与覆盖保护。代际改变、真实能力缺失会停止，而非偷偷改参数或丢历史。

设置里的三个操作语义不同：**刷新状态**只读；**更新模型目录**联网获取目录、必要时正常续期；**主动更新授权**是用户显式发起的续期检查，即使 access 尚有效也会请求维护，随后更新目录。最后一项不做推理、不撤销，也不能绕过未确认代际屏障；不能由无人值守安装自动点击。

### 2. 压缩先准备 live metadata，仍由原生算法决定

自有 `compactIfNeeded` 仅在真实 pressure trigger 且 durable conversation header 的 provider 为 SIWC 时，先调用公开 `Llm.prepareCall`，取得 live capabilities，再调用原始 `super.compactIfNeeded`。不 dispatch 这个 handle，不写 header、消息或 checkpoint，也不取代 Agent 后续的 `agent/request` 与正式 prepare。

缺 context、授权失败、取消与覆盖异常仍失败关闭。保护判断同时考虑 conversation 与 summarizer；改成其他摘要源不会使 SIWC conversation 的 pressure 失败漏过保护。真正目录未声明 context 时仍报错，不填默认容量。

### 3. 网络只在有足够契约的范围内改进

`requestPolicy.transport` 默认 `auto`，可由原生插件配置选择 `host`：

- 先调用原生公开 `proxyRouteFor`；代理/未知路由交给 Host fetch，不在本地解析代理目标，不读取代理凭据。
- 显式 hosts override 或读取策略不明时仍用 Host。
- macOS 仅在 `scutil --dns` 的默认 resolver 优先级、地址族与无 interface binding 等策略可识别时，向该**已配置** resolver 发有界 c-ares 查询。domain-specific/interface-bound/custom-protocol/未知策略不自行模拟。Windows 不推断 NRPT 等价性，保留 Host 网络。
- 仅官方 auth/API HTTPS origin；API 仅 models/responses。私有 Agent 使用原域名 SNI、严格 TLS，验证整组返回地址为 public，固定这次连接的地址，不跟随重定向。
- **在 TLS 验证成功前不调用 request.end/write。** 在交出任何 token body 前先将该尝试标为不确定；“没有看到某个事件”不是未发送的证明。
- 不改全局 fetch/dispatcher、DNS、代理、证书或系统路由。私有 HTTPS 不宣称继承任意第三方 dispatcher 的非公开定制；这种配置可保留 `host` 模式。

OS read helper 只允许固定 `/usr/sbin/scutil --dns`，800 ms、256 KiB、`shell:false`；静态 import contract 与负向测试保留对其他进程/开发 runner 的禁令。它不是版本检测，也不是生产启动时跑 native suites。

### 4. 一份完整预算和持久代际屏障

token 请求的 12 秒覆盖最多两次尝试及 100 ms backoff、headers 和 body 消费。TLS/HTTP 拒绝不自动重试；未知写结果、已经收到成功响应后的验证失败不能因为之前某次 connect timeout 而重新变成“未发送”。忽略 abort 的 reader 与 cleanup promise 也不能无限拖住网络等待。原生 credential IO/锁仍由宿主管理，不把网络预算宣称成所有物理文件 IO 的硬截止。

刷新前通过 native `modifyRecord` 原子保存 claim/generation，释放全局 credential-file lock 后做网络；成功仅能 CAS 提交到相同 client/subject/generation/claim。等待者观察同一 claim，不顺序交旧 token。明确未发出/明确拒绝可进入有界冷却；未确认、后置验证失败、存储失败保留受保护记录但停止旧代际自动使用。只有确认的终结 grant 错误才清 token、保留注册。

退出也先落 durable deny-use fence，网络期间不占全局 credential-file lock；清除失败后，新进程仍不得使用已撤销旧凭据。远端未确认与本地清除分开报告，不伪报远端撤销。

### 5. 数据 v2 与降级边界

可以读取原 schema-v1 账号；保存已验证授权、刷新/撤销屏障使用 schema-v2。旧版本只读 v1，因此会拒绝不认识的安全记录，而不是忽略屏障继续提交旧 token。host/selection 的公开身份和账号注册保持不变，不迁移到 pi，也不自动改当前模型。

**不要手工把 schema 改回 1 或删除 marker 来“恢复”。** 写过 v2 后，不把退回 0.3.8 当作透明数据降级；需要原 Host 网络时可通过原生配置保留 0.3.9 的 `transport: host`，不丢掉生命周期保护。已在旧版遇到未确认更新的账号没有可追溯的 durable 结果，部署后应先由用户为该注册完成官方重新授权，不能猜测旧 token 是否仍可重交。

## 验证证据及不能替代的边界

工程命令在候选目录执行，最终结果需与交付 commit 一起记录：

```sh
npm ci
npm test
npm run format:check
npm run check
npm run test:package
npm run doctor
npm run test:native
npm run test:race
npm run test:compaction
npm run test:presets
```

0.3.9 候选的最终工程结果：`npm ci`、`npm test`（372/372）、`format:check`、`check`（88 个 JS 模块语法与公开文件检查）、`test:package`（110 个包文件，独立解包 372/372）、`doctor` 及全部四套 native 命令通过。doctor 的 core/session contract issues 均为空，但明确 `behaviorValidatedByDoctor=false`、`desktopGuiValidated=false`。独立复核发现的唯一 P1 已按红→绿回归修复，窄范围复核更新 verdict 为 **OK**；不是实机恢复背书。

关键已取得证据：

| 层次                                        | 检查                                                                                               | 结论边界                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 原始红回归                                  | 12 等待者重放、重建后旧代际、200 后验证/写盘失败、忽略 abort 的 body                               | 证明缺陷存在，不是实机账号结果                   |
| 协议/生命周期 fixture                       | 失败合并、已知未发出后的恢复、schema-v2 旧 reader 拒绝、显式维护、旧结果不覆盖新授权、撤销清除失败 | 合成凭据，禁止真实网络                           |
| 实际 native credentials 多进程              | 等待者确实观察 pending；未确认仅提交一次；重建/claim 后进程退出仍停止旧代际                        | 临时文件/测试进程，不访问用户 grant              |
| 实际 native selection                       | 缓存过期、access 过期、失败屏障存在时仍可切已验证档位；未知 effort 拒绝；真实 prepare 保留授权门禁 | 临时 Session，未发推理                           |
| 实际 native pressure                        | 已存 header 的冷会话红→绿；其他摘要模型、失败、真实缺 context、取消都覆盖；不发送、不改历史        | 真正原生算法，合成模型/历史                      |
| 四套 native / main entry                    | 现有源、owner carrier、临时存储、附件/重放、四种 preset 和实际 retained composition、不同版本标签  | 当前 rc.3 二进制；标签不是未来/旧二进制          |
| 完整 production service factory，公开空请求 | Electron Node 24.21.0；HEAD 405 / 708 ms；空表单 POST 400 / 307 ms；`bounded-ready/direct`         | 无 grant/client/token/cookie，不证明真实刷新成功 |
| 真实 Desktop / 真实账号                     | 新版本部署、官方重新授权、切档与主动维护                                                           | 尚待新的具体批准和实测；不能被上面各行代替       |

独立复核另外发现了一个候选中的 P1：没有 refresh token 时未调用撤销却误报 remoteConfirmed=true。已取得“初始无续期凭据退出”和“远端失败后再次退出”两项红回归并修复；只有真实撤销确认后才能报告成功，无 token 保留 `NO_RENEWABLE_TOKEN` 和远端未确认提醒。验证未使用真实账号。

LSP 主动检查覆盖 30 个生产路径；push-only server 不能确认其中 26 个 clean，不把静默当完整类型检查。已修复新 resolver 属性提示；保留既有 client `require` hint，最终语法、打包与原生检查另行记录。

私有原始日志保留在开发工作区 `.pi/validation/full-auth-analysis/`，不进入包：`red-lifecycle-before.log`、`dns-*.log`、`scoped-*.log`、`runtime-network-probe.log`、`cold-compaction-red.log` 与对应 green/native 结果。发布文档只留不含身份、地址或凭据的聚合结论。

## 部署与实机验收

1. 先审查候选与检查结果。活跃链接源码在独立批准的空闲窗口前保持不动；不从使用被替换 provider 的 DSH 会话部署。
2. 全部相关会话/授权操作空闲后正常 Quit；通过原生 `add -w` 保持原链接和单 owner，重开后核实实际版本、canonical target、selected bundle、其他源与依赖引用。
3. 受本次旧版未确认刷新影响的账号先在官方页面重新授权，不提供/export token；由用户选择账号。不要为测试自动换当前模型。
4. 用户手动在原生选择器切换模型/推理档位，记录是否报错；再检查所有支持 preset 及目标 Agent 的实际 retained composition。元数据恢复不是会话安全恢复的替代证据。
5. 如另行批准，一次 **主动更新授权** 做真实续期与目录检查，不推理/不撤销；错误即停，不盲重试旧 token。实际推理需再有固定小输入、空会话和时间/次数范围，不使用用户完整会话历史。

未覆盖边界：Windows 的新 GUI/网络行为、旧或未来 Desktop 二进制、新版本的真实 grant 刷新/推理/撤销、任意第三方网络定制、所有外部网络故障。缺少完整旧 Host trace 的不确定性仍保留；不能把一次新链路成功反推为每个旧失败都已精确落在 DNS 阶段。

## 主源

- OpenAI [SIWC OSS overview](https://developers.openai.com/siwc/token-sharing-open-source/)、[sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)、[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。
- [RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14)、[RFC 6749 §5.2/§6](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2)、[RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)。
- 本机 pi 1.3.0 发布源码；当前 DSH `dsh-agent-loop`、`dsh-llm`、`dsh-compaction-basic`、`dsh-token-meter`、credentials/proxy/home-paths 的公开发布代码；macOS `resolver(5)` 与受限 `scutil --dns` 投影。未把第三方经验帖、自动 source-check 评分或一次无凭据响应当作真实授权恢复证据。
