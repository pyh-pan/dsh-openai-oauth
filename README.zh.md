# dsh-openai-oauth

**通过 OpenAI 官方 Sign in with ChatGPT（SIWC），在 DeepSeek Harness Desktop 中使用自己的 ChatGPT 订阅。**

[English](README.md) | 简体中文

[![Verify](https://github.com/pyh-pan/dsh-openai-oauth/actions/workflows/verify.yml/badge.svg)](https://github.com/pyh-pan/dsh-openai-oauth/actions/workflows/verify.yml)

本项目为独立社区插件，不是 OpenAI/DeepSeek 官方插件；不使用旧固定 Client ID 的 Codex OAuth 或 ChatGPT backend-api。

## 功能

- Continue with ChatGPT、动态 Agent 注册、持久化 host ID、完整 ID Token 校验。
- 在 **DSH 原有模型选择器** 中选择账号实际可用的模型和推理档位。
- 公开 Responses 流式输出、校验后的图片/文档输入、本地 function 工具、工具结果与兼容历史重放。
- 多账号/工作区注册隔离、显式选择账号、轮换刷新和限定退出。
- 不覆盖 DeepSeek 账号/API 余额通道、其他源或现有会话，不静默切换计费源。
- 透传按账号/持久会话派生的 Responses 缓存亲和标识，不明文发送原始会话身份。
- 不依赖 Codex CLI、API Key，不修改 ASAR 或整体升级内置 pi-ai。

## 支持范围

Desktop 最低要求：`>=0.2.0-rc.2`；开发/安装脚本要求 **Node.js 24+**。历史原生基线为 **0.2.1-rc.2、0.2.1-rc.1 和 0.2.0-rc.2**，各平台的实际证据单独记录。

新版本不需要添加白名单，也不在生产启动时运行整套测试。加载只设置最低门槛，实际 Interface、owner 鉴权与会话保护决定可用能力；版本探测失败或组件版本字符串不同，本身不构成停用理由。宽加载范围不等于已验证所有未来发行版。详见[前向兼容策略](docs/forward-compatibility.md)。

- Windows：0.2.1-rc.2 原生回归通过，用户已确认初步修复后桌面入口恢复；后续启动防护加固的最终桌面复核待完成。保留 0.2.1-rc.1 / 0.2.0-rc.2 支持与此前验收记录。
- macOS：0.2.0-rc.2 工程/原生合成测试此前通过；0.2.1-rc.1 / 0.2.1-rc.2 的新版原生回归及桌面实网验收待完成，不以 Windows 或 Node 测试替代。
- macOS 0.2.1-rc.3：四项隔离原生检查通过；桌面验收待完成。
- Windows/macOS/Linux CI 只证明 Node 协议/工程测试，不等于桌面授权、推理实测。
- 暂不承诺旧 DSH、远程/headless Host 或 Linux Desktop。

详细状态与实测边界见 [兼容性](docs/compatibility.md)。

## 从源码安装

当前不要求、也未承诺 npm 发布。

```sh
git clone https://github.com/pyh-pan/dsh-openai-oauth.git
cd dsh-openai-oauth
npm ci
npm test
npm run check
npm run test:package
npm run doctor
npm run dsh -- plugin --profile desktop add -w .
```

辅助脚本发现本机桌面程序并调用它自带的 CLI，不安装另一套 Host。自定义路径使用 `DSH_APP`；Windows PowerShell/macOS 具体示例见 [安装文档](docs/install.md)。

任务结束后再通过 DSH 正常退出/重启。Windows 的关闭按钮可能仅隐藏到托盘。

全新安装或原本就是压缩包安装时，也可打包后安装。**已有源码链接时，请保持链接，从已审查的源码目录运行原生 `add -w`；不要先移除再用压缩包覆盖 Windows Junction。** 当前已安装版本的隔离复现显示，这条转换路径可能删除链接目标的源码和 Git 元数据。部署应由外部终端或独立助手完成，不要让正在使用该订阅源的 DSH 会话卸载自己。详见[安全链接更新](docs/install.md#updating-a-linked-checkout-safely)。

```sh
npm run pack
npm run dsh -- plugin --profile desktop add ./artifacts/pyh-pan-dsh-openai-oauth-0.3.8-diagnostic.1.tgz
```

不要同时启用原私有 bundle 和本项目：为保留既有授权，二者刻意使用同一 provider/凭据身份。切换步骤见 [迁移](docs/migration.md)。

## 登录与使用

1. 打开 **设置 → 模型 → ChatGPT 订阅**。
2. 点击 **Continue with ChatGPT**，在系统浏览器打开官方授权链接。
3. 在 OpenAI 页面命名/批准 Agent，并亲自完成登录；不要复制其他客户端 Token。
4. 阅读首次提示，然后选择 **使用此账号**。登录本身不会替你切换当前会话。
5. 在原有选择器中选择 **ChatGPT Subscription**；**推理等级** 只列该模型真实支持的档位。
6. 点击 **管理用量**，在 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) 查看本应用、额度、限制及访问管理。

未授予订阅推理权限的身份可保留，但不能推理。显式“启用订阅推理”才重新请求 consent；普通重授权复用注册，不重复创建 Agent。添加其他账号则新建独立注册。

## 限制与安全

- 模型/推理档位/额度取决于账号与服务端，不保证无限额度或任意模型。
- 支持所选模型可接受的文本、规范化图片与常见文档，通过 Responses 内联传入；不只是打开上传按钮。单次完整请求最多 20 张图片、10 个文件，每文件 20 MiB、文件合计 40 MiB。详见[附件类型、原生契约与验证边界](docs/attachments.md)。
- 不支持音视频、Files 上传 API 或托管 MCP/tool-search。未知二进制格式、超限附件历史会明确报错，不静默丢弃。
- 本适配器保留 SIWC 预览的保守参数契约：普通调用显式 `maxTokens`/`temperature` 仍明确报错，不假装生效。原插件统一集成[摘要兼容与逐会话覆盖保护](docs/compaction.md)，对形状兼容的 standard/cordis/ptc/minimal 在内存中适配，不写用户 preset，也不需要额外安装本地压缩 bundle。0.3.7 起按实际宿主能力启用，不再精确限定发行版本；保护缺失或尚未就绪时，阻止相关会话请求而保留账号设置。自定义或未覆盖组合不会被静默批准。
- 失败不会回退到 API Key 或其他余额源。
- Token 仅保存在宿主原生 credentials 服务，不进入浏览器存储或普通配置；不宣称本地文件等同系统钥匙串加密。
- 退出先尝试远端撤销，再清本账号本地 Token、保留注册；远端未确认会明确报告，应在 ChatGPT 设置检查访问。

参见 [安全政策](SECURITY.md)、[协议设计](docs/protocol.md) 和 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 开发、更新和卸载

```sh
npm ci
npm test
npm run check
npm run test:package
npm run test:native
npm run test:race
npm run test:compaction # 已安装宿主的原生压缩契约
npm run test:presets    # 真实主入口与全部受支持 preset 隔离组
```

这些检查在开发/发布时显式执行，不因宿主版本变化而由生产启动或安装器自动运行。协议测试使用合成数据/受控上游；原生测试使用临时凭据文件，不访问真实授权或消耗推理额度。真实账号验收与之分开记录。

项目直接发布 ESM 源码，不需要提交构建目录、提取的 ASAR 或 vendor 快照。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

若 DSH 升级后模型源和授权设置同时消失，先检查[版本兼容性](docs/install.md#missing-source-and-authorization-settings-after-a-dsh-upgrade)，不要先删除授权或重新登录：不兼容的 bundle 会在运行代码前被跳过。

链接安装更新后先验证，再安全重启。压缩包安装则重新安装已检查的新包。卸载：

```sh
npm run dsh -- plugin --profile desktop remove @pyh-pan/dsh-openai-oauth
```

卸载保留凭据；如需断开 Agent，请先退出或通过 ChatGPT 设置管理访问，不要删除整个 DSH profile。

[MIT](LICENSE)
