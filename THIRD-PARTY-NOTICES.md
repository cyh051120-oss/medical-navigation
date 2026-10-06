# 第三方组件与许可声明

本文件列出「就医准备助手」V1.0 使用的第三方资源及其许可。

软件本身**没有运行时第三方依赖**：`package.json` 不含 `dependencies`，仅含用于类型检查与测试的
`devDependencies`（不作为源码的一部分分发）。

---

## 1. Lucide（界面矢量图标）

- **用途**：小程序界面中的矢量图标。
- **来源与版本**：`lucide-static` v1.48.0，项目 <https://lucide.dev>，仓库 <https://github.com/lucide-icons/lucide>。
- **集成方式**：图标以 base64 SVG 掩码内联进 `hospital-ai-miniapp/styles/icons.wxss`，
  **运行时不发起任何网络请求**，也不新增任何依赖。
- **许可**：ISC License（其中由 Feather 项目派生的图标部分为 MIT License）。两种许可的全文见下。

### 1.1 ISC License（Lucide 主体）

> 以下文本取自上游仓库 LICENSE 文件：<https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE>
> （拉取日期：2026-09-28；上游随版本更新可能微调，以该 URL 为准）

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 1.2 MIT License（由 Feather 项目派生的图标部分）

> 上游 LICENSE 中列出的 Feather 派生图标共约 110 个（airplay、alert-circle、calendar、check、
> chevron-*、circle、clipboard、clock、code、download、external-link、info、link、lock、minus、
> more-horizontal、plus、power、radio、search、server、share、smartphone、trash-2、upload、x 等）。
> 本项目所用的图标如落在该清单内，则同时适用下述 MIT 许可。

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 开发期工具（不随源码分发）

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| `typescript` | 类型检查（`npm run typecheck`） | Apache-2.0 |
| `tsx` | 运行 Node 端检查脚本 | MIT |
| `miniprogram-automator` | 端到端测试驱动微信开发者工具 | MIT |
| `miniprogram-api-typings` | 微信小程序 API 类型声明 | MIT |
| `@types/node` | Node 类型声明 | MIT |

以上均为 `devDependencies`，不参与小程序代码包，也不随代理运行时分发。

---

## 3. 权威来源域名清单

`server/authorities.ts` 内置的默认权威域名清单（卫健委、疾控、药监局、中华医学会、三甲医院官网示例、
MSD 手册等）**仅作为配置示例与检索结果过滤白名单**，不引用任何第三方代码或内容。
清单可由使用者在 `server/config.json` 的 `authorityDomains` 中覆盖。

---

**文档版本**：V1.0　　**对应软件版本**：就医准备助手 V1.0
