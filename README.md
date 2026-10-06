# 个人就医准备助手

一个在你自己的手机上把健康信息理顺的小工具。它由两个组件组成，都只在本机运行：

| 组件 | 目录 | 说明 |
|---|---|---|
| 微信小程序 | `hospital-ai-miniapp/` | 记录、整理与展示界面，数据默认只存本机 |
| 本地 AI 代理 | `server/` | 可选。小程序需要 AI 能力时，经它转发到你配置的模型与检索服务 |

小程序的详细说明见 `hospital-ai-miniapp/README.md`；代理的配置细节见 `server/README.md`。

## 运行环境

- **Node ≥ 24**（必需）。代理直接用 `node server/index.ts` 运行 TypeScript，依赖 Node 24 的
  原生类型擦除，因此无需构建步骤；同时使用全局 `fetch`，没有运行时依赖。
- 项目命令统一走 npm scripts，TypeScript 检查脚本用 `tsx` 运行。

## 运行

### 1. 准备代理配置（只在用 AI 功能时需要）

```bash
cp server/config.example.json server/config.json
```

然后编辑 `server/config.json`，填入你自己的 LLM 与检索服务配置（`llm` / `search`），
以及可选的权威来源域名白名单（`authorityDomains`）。`config.json` 已被 `.gitignore` 忽略，
只有示例文件 `config.example.json` 入库；仓库里不含任何密钥。两项 `apiKey` 都可以留空，
留空时代理照常启动，`/api/health` 会报告 `providerReady=false` / `searchReady=false`。

### 2. 启动本地代理

```bash
npm run dev:api
```

启动后监听 `http://127.0.0.1:8787`，仅本机可访问，不记录请求内容。健康检查：

```bash
curl http://127.0.0.1:8787/api/health
```

### 3. 运行微信小程序

用微信开发者工具的「导入项目」打开 `hospital-ai-miniapp/`，AppID 选测试号。因为小程序要
访问本机代理，请在右上角「详情」→「本地设置」勾选「不校验合法域名」，让
`http://127.0.0.1:8787` 可以被请求。

## 测试与检查

```bash
npm run typecheck     # TypeScript 类型检查（小程序 + 代理）
npm run test:scan     # 静态扫描：能力禁令、密钥、权限、语法
npm run test:logic    # 本地整理与摘要逻辑检查
npm run test:server   # 代理端逻辑检查（配置、LLM、检索、编排与演示矩阵）
npm run test:e2e      # 端到端（需要微信开发者工具）
npm run screenshots   # 生成演示截图集（需要微信开发者工具）
```

## 软著演示

申请软件著作权需要可复现的演示材料。小程序在开发环境下提供「演示模式」：开启后 AI 输出
为本地固定内容，同一输入永远得到同一份结果，且全程不发任何网络请求。配合它运行：

```bash
npm run screenshots
```

会走演示模式生成一整套截图（8 个页面、大字对比等），内容确定、可重复，便于整理成演示
与登记材料。
