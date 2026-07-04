## tmdb-proxy

这是一个代理 TMDB 接口的仓库，支持 Vercel Serverless 和 Cloudflare Worker 两种部署方式。

完全免费，但是每月有100GB流量限制，自用的话是完全够用的。


## Vercel 部署
[![Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/imaliang/tmdb-proxy)


## 使用方法

1. 部署。部署有两种方法：
    + 一是直接点击上方按钮一键部署。
    + 二是先fork本项目，再登录 [Vercel](https://vercel.com/) 选择自己的仓库新建。


2. 绑定自己的域名(必须，因为自带的域名vercel.app在国内基本不可用) 
    + 如果你没有域名，可以去 [腾讯云活动域名](https://curl.qcloud.com/ScJY3Hev) 注册一个，新用户1元1年。

3. 你自己绑定的域名就是tmdb的代理域名，会代理 api.themoviedb.org 和 image.tmdb.org

## Cloudflare Worker 部署

1. 安装依赖：

```bash
npm install
```

2. 登录 Cloudflare：

```bash
npx wrangler login
```

3. 配置密钥。`TMDB_API_KEY` 可选，但建议配置；AI 相关变量按需配置。

```bash
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

4. 本地调试：

```bash
npm run dev:worker
```

5. 部署：

```bash
npm run deploy:worker
```

Cloudflare Worker 入口文件是 `worker.js`，配置文件是 `wrangler.toml`。请求路径保持和 Vercel 版一致：

- `/3/*` 代理 `https://api.themoviedb.org/3/*`
- `/t/p/*` 代理 `https://image.tmdb.org/t/p/*`
- `/` 重定向到项目仓库

## 环境变量

- `TMDB_API_KEY`：可选。配置后，请求没有携带 `Authorization` 时，代理会自动使用该 key 请求 TMDB，并覆盖 URL 中已有的 `api_key`。
- `CACHE_DURATION_MS`：可选。缓存有效时间，默认 10 分钟。
- `MAX_CACHE_SIZE`：可选。最大缓存条数，默认 1000。
- `OPENAI_API_KEY`：可选。OpenAI 兼容接口密钥，用于搜索 query 标题清洗。
- `OPENAI_API_BASE_URL`：可选。OpenAI 兼容接口地址，例如 `https://api.openai.com/v1`。
- `OPENAI_MODEL_NAME`：可选。OpenAI 兼容模型名。
- `GEMINI_API_KEY`：可选。Gemini API 密钥，作为标题清洗的备用 AI。
- `GEMINI_MODEL_NAME`：可选。Gemini 模型名，默认 `gemini-2.0-flash`。
