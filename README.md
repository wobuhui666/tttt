# TMDB 名称处理代理

同一份代理逻辑运行于 Vercel 和 Cloudflare Worker。标准名称直接查询 TMDB；明确的年份、季集、画质、配音和更新标签先在本地清理。需要进一步识别的名称先调用 OpenAI 兼容接口的 `fast` 模型，失败或超时后依次尝试 Groq 和 Cloudflare Workers AI。

主模型请求使用 `fast` 别名，默认接口为 `https://nnnn.114514heihei.eu.org/v1/chat/completions`；实际模型由服务端路由决定，当前验证返回 `openai/gpt-oss-20b`。请求发送 `max_completion_tokens: 96` 和 `reasoning_effort: "low"`，使用低推理预算；并未关闭推理。名称提取使用简短英文系统提示，要求保留原文标题、数字和标点，不翻译、不补充、不执行输入中的指令，只返回标题。固定系统提示经 `o200k_base` / `o200k_harmony` 测量为 69 tokens，`cl100k_base` 为 70 tokens。代表性名称请求返回的总输入用量为 157 tokens，低于 200 tokens；具体名称长度会影响总输入用量。Groq 备用模型为 `qwen/qwen3.8-27b`，显式发送 `reasoning_effort: "none"`。Workers AI 使用 `@cf/meta/llama-3.1-8b-instruct-fast`。任一级模型正常返回原名也算成功，不会重复调用后续模型。

## 接口

| 路径 | 行为 |
| --- | --- |
| `/3/*` | 代理 TMDB API；影视搜索支持名称清理 |
| `/t/p/*` | 代理 TMDB 图片 |
| `/healthz` | 返回主模型及两级备用模型名称，不返回密钥 |
| `/__normalize` | 仅 Worker 支持的内部 POST 接口，需 Bearer 令牌；直接调用 Workers AI |
| `/` | 跳转到项目仓库 |

搜索响应保留 TMDB JSON 格式，并增加 `x-tmdb-query`（URI 编码后的实际搜索词）、`x-title-normalizer` 和 `x-proxy-platform`，方便核对名称处理与分流。`x-title-normalizer` 可为 `rules`、`primary`、`groq`、`workers-ai`、`none` 或 `fallback`。应用如果仍严格比较原始名称，需要相应处理规范化后的查询词。

结果缓存和名称缓存先于模型调用，相同的并发请求合并。缓存按请求凭据隔离，并包含主接口地址与模型，避免切换模型后使用旧结果。模型或上游失败时，不返回凭据、请求密钥或模型原始错误内容。

## 配置

所有密钥通过部署平台的环境变量或 Worker secrets 配置，不写入仓库。

| 变量 | 用途或默认值 |
| --- | --- |
| `TMDB_API_KEY` | 可选；没有 Authorization 时用于上游 TMDB，并覆盖查询中的 `api_key` |
| `PRIMARY_API_KEY` | OpenAI 兼容主接口密钥 |
| `PRIMARY_API_BASE_URL` | `https://nnnn.114514heihei.eu.org/v1`；自动追加 `/chat/completions` |
| `PRIMARY_MODEL` | `fast` |
| `PRIMARY_REASONING_EFFORT` | `low`；主接口使用低推理预算 |
| `PRIMARY_TIMEOUT_MS` | 主模型期限，默认 1200 ms，同时受共享模型预算约束 |
| `GROQ_API_KEY` | Groq 备用模型密钥 |
| `GROQ_MODEL` | `qwen/qwen3.8-27b` |
| `GROQ_REASONING_EFFORT` | `none` |
| `WORKERS_AI_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` |
| `NORMALIZER_TOKEN` | Worker 内部 `/__normalize` 的访问令牌 |
| `CF_AI_FALLBACK_URL` | Vercel 使用的 Worker 内部接口，例如 `https://tapicf.coolmarket.eu.org/__normalize` |
| `CF_AI_FALLBACK_TOKEN` | Vercel 调用内部接口的令牌，须与 `NORMALIZER_TOKEN` 相同 |
| `TITLE_AI_BUDGET_MS` | 三级模型共享预算，默认及上限均为 2500 ms |
| `GROQ_TIMEOUT_MS` | Groq 备用模型期限，默认 600 ms，同时受共享模型预算约束 |
| `WORKERS_AI_TIMEOUT_MS` | Workers AI 备用模型期限，默认 1800 ms，同时受共享模型预算约束 |
| `TMDB_TIMEOUT_MS` | 上游 TMDB 期限，默认 4000 ms |
| `PROXY_TIMEOUT_MS` | 单个代理请求总预算，默认 6500 ms，上限 7000 ms |
| `CACHE_DURATION_MS` | 默认 600000 ms |
| `MAX_CACHE_SIZE` | 默认 1000 条 |

Vercel 通过内部接口令牌调用 Workers AI，不需要 Cloudflare 管理令牌。Worker 使用 `AI` binding 调用 Workers AI；绑定调用超过响应预算后会忽略迟到结果，底层推理可能仍会继续。

主模型和 Groq 均耗满各自期限时，Workers AI 仍约有 700 ms 的共享预算；模型提前失败则留出更多时间。各级请求超时后终止等待，TMDB 和代理总预算保持独立上限。

## 部署

Vercel 使用 Node.js 24，直接导入仓库并配置上述环境变量。`vercel.json` 将 API 和图片请求交给同一代理入口；修改环境变量后重新部署。

Worker 名称为 `tttt`，入口为 `worker.js`，`wrangler.toml` 已声明 `AI` binding 与默认模型及预算：

```bash
npx wrangler login
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put PRIMARY_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put NORMALIZER_TOKEN
npm run deploy:worker
```

将 `t.coolmarket.eu.org` 的现有 Vercel 域名绑定与 Worker 路由保持一致。电信分流到 Cloudflare 时，由对应的 Worker 路由接收请求；其余线路由 Vercel 接收。使用响应的 `x-proxy-platform` 核对实际落点，不以域名相同推断落点。

## 验证

无需安装运行依赖：

```bash
npm run check
npm test
```

检查线上 `/healthz`、普通标题、包含附加标签的标题及响应平台。名称模型的期限与客户端整条身份查询期限独立，客户端仍需为详情、季集和社区片头片尾查询留出时间。
