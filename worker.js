import { createProxy } from "./lib/proxy.mjs";

const proxy = createProxy({ platform: "cloudflare" });

export default {
    fetch(request, env, ctx) {
        return proxy(request, env, ctx);
    },
};
