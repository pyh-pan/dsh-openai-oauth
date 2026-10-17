# dsh-openai-oauth

**通过 OpenAI 官方 Sign in with ChatGPT（SIWC），在 DeepSeek Harness Desktop 中使用自己的 ChatGPT 订阅。**

[English](README.md) | 简体中文

[![Verify](https://github.com/pyh-pan/dsh-openai-oauth/actions/workflows/verify.yml/badge.svg)](https://github.com/pyh-pan/dsh-openai-oauth/actions/workflows/verify.yml)

本项目为独立社区插件，不是 OpenAI/DeepSeek 官方插件；不使用旧固定 Client ID 的 Codex OAuth 或 ChatGPT backend-api。

## 功能

- Continue with ChatGPT、动态 Agent 注册、持久化 host ID、完整 ID Token 校验。
- 在 **DSH 原有模型选择器** 中选择账号实际可用的模型和推理档位。
- 公开 Responses 流式输出、本地 function 工具、工具结果与兼容历史重放。
- 多账号/工作区注册隔离、显式选择账号、轮换刷新和限定退出。
- 不覆盖 DeepSeek 账号/API 余额通道、其他源或现有会话，不静默切换计费源。
- 透传按账号/持久会话派生的 Responses 缓存亲和标识，不明文发送原始会话身份。
- 不依赖 Codex CLI、API Key，不修改 ASAR 或整体升级内置 pi-ai。

## 支持范围

要求 **DSH Desktop 0.2.1-rc.1 或 0.2.0-rc.2**；开发/安装脚本要求 **Node.js 24+**。

- Windows：已完成原生 CLI 引用迁移；用户确认登录、模型/推理选择与其他源不变。0.2.1-rc.1 原生回归通过。
- macOS：0.2.0-rc.2 工程/原生合成测试已通过；应用已更新至 0.2.1-rc.1，新版回归及桌面实网验收待完成。
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

也可打包后安装：

```sh
npm run pack
npm run dsh -- plugin --profile desktop add ./artifacts/pyh-pan-dsh-openai-oauth-0.3.1.tgz
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
- 当前声明文本输入与客户端 function 工具；未实现直接图片/文件上传及托管 MCP/tool-search。
- SIWC 当前预览不接受部分普通 API 参数。显式 `maxTokens`/`temperature` 会明确报错，不假装生效；使用前需清空这些设置。
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
```

协议测试使用合成数据/受控上游；原生测试使用临时凭据文件，不访问真实授权或消耗推理额度。真实账号验收与之分开记录。

项目直接发布 ESM 源码，不需要提交构建目录、提取的 ASAR 或 vendor 快照。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

链接安装更新后先验证，再安全重启。压缩包安装则重新安装已检查的新包。卸载：

```sh
npm run dsh -- plugin --profile desktop remove @pyh-pan/dsh-openai-oauth
```

卸载保留凭据；如需断开 Agent，请先退出或通过 ChatGPT 设置管理访问，不要删除整个 DSH profile。

[MIT](LICENSE)
