# 权威来源与来源展示说明（软件著作权登记用）

本文件说明「就医准备助手」问诊建议模式中「来源」的筛选范围、匹配规则与「未找到权威资料」时的
实际行为。内容对应当前代码实现。

## 一、默认权威域名白名单

默认清单定义在 `server/authorities.ts: DEFAULT_AUTHORITY_DOMAINS`，共 7 个域名：

| 域名 | 归属 |
| --- | --- |
| `nhc.gov.cn` | 国家卫生健康委员会 |
| `chinacdc.cn` | 中国疾病预防控制中心 |
| `nmpa.gov.cn` | 国家药品监督管理局 |
| `cma.org.cn` | 中华医学会 |
| `pumch.cn` | 北京协和医院官网（示例） |
| `wchscu.cn` | 四川大学华西医院官网（示例） |
| `msdmanuals.cn` | MSD 诊疗手册（中文版） |

清单为「示例，可扩展」，与 `server/config.example.json` 的 `authorityDomains` 保持一致。

## 二、白名单的覆盖与规整

`server/authorities.ts: resolveAuthorityDomains(configDomains)` 决定生效清单：

- `server/config.json` 的 `authorityDomains` 规整后仍有 ≥1 个有效域名时，**完全覆盖**默认清单，
  只用配置中的域名；
- 配置为空、未提供或全为无效项时，**回退**默认清单。

无论走哪条路径，返回值都经过小写化、去重、去首尾点、去 scheme/path/端口
（`server/authorities.ts: normalizeDomain`）。

## 三、严格子域匹配

`server/authorities.ts: isAuthorityUrl(urlOrHost, domains)` 采用严格子域匹配：仅当
`host === 域名` 或 `host` 以 `.域名` 结尾时命中。因此：

- `evil-nhc.gov.cn` 不命中 `nhc.gov.cn`；
- `nhcgov.cn` 不命中 `nhc.gov.cn`。

`server/providers/search.ts: search` 把检索结果逐条归一化后，只保留命中白名单的条目；
`url` 不可解析的条目直接丢弃。

## 四、检索为空时的原因码

`server/providers/search.ts: search` 在结果为空时返回稳定的 `reason`（有结果时恒为 `null`）：

| reason | 含义 |
| --- | --- |
| `no_results` | 上游成功但 0 条（含条目 url 均不可解析，或 query 为空未发请求） |
| `no_authority_match` | 上游返回 ≥1 条可解析条目，但无一命中权威域名 |
| `search_unavailable` | 网络 / 超时 / 限流 / 非 2xx / 响应非法等不可用情形（不抛异常） |
| `not_configured` | `search.baseUrl` 为空（不发起请求） |

## 五、「未找到权威资料」的实际行为

当检索结果无一命中白名单（`no_authority_match`）或检索不可用（`search_unavailable`）时，
本次请求的可用来来源为空，系统的实际行为是：

1. **不注入任何来源、不生成任何引用。** 系统提示明确规定：可用来来源为空时，
   `directions` 与 `suggestions` 必须为空数组，不得给出任何 `citation`
   （`server/prompts.ts: sourcesBlock`）。
2. **引用必须与本次已获取来源完全一致。** 校验器
   （`server/validate.ts: resolveCitation / validateConsultOutput`）要求每条方向与建议的引用
   去空白后与本次已获取的某个来源 URL 完全相等，且域名通过白名单；否则整个输出判为不合格。
3. **界面表现。** 小程序端在存在方向和来源条目时渲染对应小节
   （`hospital-ai-miniapp/shared/services/aiRender.ts: consultBlocks / citationParts`；来源前缀
   `config/texts.ts: AI.citationPrefix`）。当本次没有任何命中白名单的来源（`citations` 为空）时，
   界面在来源位置渲染一条 `notice` 提示，文案为「未找到权威资料，请向医生确认」
   （`config/texts.ts: AI.noAuthorityNotice`，经 `shared/services/aiRender.ts: consultBlocks` 渲染）。
   该提示是提示而非来源条目：界面不展示任何来源行，也不用普通网页凑数。该用户可见表述同时
   记录在 `hospital-ai-miniapp/README.md`（权威来源一节）。
4. **不合格输出降级。** 若模型仍给出无法核验的引用，编排器返回
   `unsafe_output`（带 `fallback: 'organize'`，不回显模型文本），小程序据此改用本地整理
   （`server/orchestrator.ts: unsafeResult`；`hospital-ai-miniapp/pages/ai/ai.ts: localFallbackForUnsafe`）。

## 六、来源展示格式

问诊建议结果中，每条健康方向与日常建议若带引用，界面显示
`来源：<标题> · <域名>` 并附 URL（`hospital-ai-miniapp/shared/services/aiRender.ts: citationParts`）。
`citations` 小节由解析成功的引用去重生成，`title/url/domain` 一律取自已获取来源，
不信任模型自带字段（`server/validate.ts: validateConsultOutput`）。

## 七、受控输出边界

问诊建议模式下，建议就诊科室只能取自受控科室名清单
（`server/prompts.ts: CONTROLLED_DEPARTMENTS`），且输出中不允许出现具体医生或医院名称
（`server/validate.ts: REFERRAL_TERMS` 作用于方向文本）。
