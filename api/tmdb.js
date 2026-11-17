const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const BODY_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

function createHandler({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
    let proxyPromise;

    function getProxy() {
        if (!proxyPromise) {
            proxyPromise = import('../lib/proxy.mjs').then(({ createProxy }) => createProxy({
                fetchImpl,
                platform: 'vercel',
            }));
        }
        return proxyPromise;
    }

    return async (req, res) => {
        const controller = new AbortController();
        const onAborted = () => controller.abort();
        const onClosed = () => {
            if (!res.writableEnded) controller.abort();
        };
        req.once?.('aborted', onAborted);
        res.once?.('close', onClosed);

        try {
            const method = req.method || 'GET';
            const headers = new Headers();
            for (const [name, value] of Object.entries(req.headers || {})) {
                if (value === undefined || value === null) continue;
                for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
            }
            const host = headers.get('host') || 'localhost';
            const url = new URL(req.url || '/', `https://${host}`);
            const init = { method, headers, signal: controller.signal };
            if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') init.body = await readBody(req);
            const request = new Request(url, init);
            const proxy = await getProxy();
            const response = await proxy(request, env, { waitUntil: () => {} });

            res.statusCode = response.status;
            response.headers.forEach((value, name) => {
                // Native fetch decompresses response bodies before exposing their stream.
                if (!BODY_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
            });
            if (method === 'HEAD' || !response.body) {
                res.end();
            } else {
                await pipeline(Readable.fromWeb(response.body), res);
            }
        } catch (error) {
            if (controller.signal.aborted || res.destroyed) return;
            console.error('[Vercel] Proxy request failed:', error?.name || 'Error');
            if (res.headersSent) {
                res.destroy?.();
                return;
            }
            res.statusCode = error?.code === 'REQUEST_BODY_TOO_LARGE' ? 413 : 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(JSON.stringify({ error: res.statusCode === 413 ? 'Request body too large.' : 'Proxy request failed.' }));
        } finally {
            req.off?.('aborted', onAborted);
            res.off?.('close', onClosed);
        }
    };
}

async function readBody(req) {
    if (req.body !== undefined && req.body !== null) {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(
            typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        );
        if (body.length > MAX_REQUEST_BODY_BYTES) throw bodyTooLarge();
        return body;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_REQUEST_BODY_BYTES) throw bodyTooLarge();
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
}

function bodyTooLarge() {
    return Object.assign(new Error('Request body too large.'), { code: 'REQUEST_BODY_TOO_LARGE' });
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
