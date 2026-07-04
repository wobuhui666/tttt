## tmdb-proxy

这是一个利用Vercel代理tmdb接口的仓库。

完全免费，但是每月有100GB流量限制，自用的话是完全够用的。


## 部署
[![Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/imaliang/tmdb-proxy)


## 使用方法

1. 部署。部署有两种方法：
    + 一是直接点击上方按钮一键部署。
    + 二是先fork本项目，再登录 [Vercel](https://vercel.com/) 选择自己的仓库新建。


2. 绑定自己的域名(必须，因为自带的域名vercel.app在国内基本不可用) 
    + 如果你没有域名，可以去 [腾讯云活动域名](https://curl.qcloud.com/ScJY3Hev) 注册一个，新用户1元1年。

3. 你自己绑定的域名就是tmdb的代理域名，会代理 api.themoviedb.org 和 image.tmdb.org

## 环境变量

- `TMDB_API_KEY`：可选。配置后，请求没有携带 `Authorization` 时，代理会自动使用该 key 请求 TMDB，并覆盖 URL 中已有的 `api_key`。
- `CACHE_DURATION_MS`：可选。缓存有效时间，默认 10 分钟。
- `MAX_CACHE_SIZE`：可选。最大缓存条数，默认 1000。
