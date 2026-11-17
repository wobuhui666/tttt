import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto;

const require = createRequire(import.meta.url);
const { createHandler } = require('../api/tmdb.js');

class ResponseSink extends Writable {
    constructor() {
        super();
        this.headers = new Map();
        this.chunks = [];
        this.statusCode = 200;
    }

    setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); }
    getHeader(name) { return this.headers.get(name.toLowerCase()); }
    _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
    body() { return Buffer.concat(this.chunks); }
}

function incoming(url, { method = 'GET', headers = {}, body } = {}) {
    const req = Readable.from([]);
    req.url = url;
    req.method = method;
    req.headers = { host: 't.coolmarket.eu.org', ...headers };
    if (body !== undefined) req.body = body;
    return req;
}

test('Vercel adapter preserves proxy path, caller authorization, status, and JSON payload', async () => {
    const seen = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: 'server-key' },
        fetchImpl: async (input, init) => {
            const url = new URL(String(input));
            seen.push(url);
            assert.equal(url.pathname, '/3/search/tv');
            assert.equal(url.searchParams.get('query'), '黑色五叶草');
            assert.equal(new Headers(init.headers).get('authorization'), 'Bearer caller-key');
            return new Response(JSON.stringify({ results: [{ id: 73223 }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    const res = new ResponseSink();
    await handler(incoming('/3/search/tv?query=' + encodeURIComponent('黑色五叶草'), {
        headers: { authorization: 'Bearer caller-key' },
    }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body().toString()), { results: [{ id: 73223 }] });
    assert.equal(res.getHeader('x-proxy-platform'), 'vercel');
    assert.equal(seen.length, 1);
});

test('Vercel adapter serves primary fast normalization without invoking either fallback', async () => {
    const calls = [];
    const handler = createHandler({
        env: {
            PRIMARY_API_KEY: 'fake-primary-key', PRIMARY_MODEL: 'fast',
            PRIMARY_API_BASE_URL: 'https://titles.example.org/v1', GROQ_API_KEY: 'fake-groq-key',
            CF_AI_FALLBACK_URL: 'https://tapicf.coolmarket.eu.org/__normalize',
            CF_AI_FALLBACK_TOKEN: 'fake-normalizer-token',
        },
        fetchImpl: async (input, init) => {
            const url = new URL(String(input));
            calls.push({ url, body: init.body && JSON.parse(init.body) });
            return new Response(JSON.stringify(url.host === 'titles.example.org'
                ? { choices: [{ message: { content: '黑色五叶草' }, finish_reason: 'stop' }] }
                : { results: [{ id: 73223 }] }), { headers: { 'content-type': 'application/json' } });
        },
    });
    const res = new ResponseSink();
    await handler(incoming('/3/search/tv?query=' + encodeURIComponent('[电影天堂] 黑色五叶草')), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('x-title-normalizer'), 'primary');
    assert.equal(res.getHeader('x-proxy-platform'), 'vercel');
    assert.equal(decodeURIComponent(res.getHeader('x-tmdb-query')), '黑色五叶草');
    assert.deepEqual(calls.map(call => call.url.host), ['titles.example.org', 'api.themoviedb.org']);
    assert.equal(calls[0].body.model, 'fast');
    assert.equal(calls[0].body.reasoning_effort, 'low');
    assert.ok(calls[0].body.max_completion_tokens > 0 && calls[0].body.max_completion_tokens <= 128);
    assert.equal(calls[1].url.searchParams.get('query'), '黑色五叶草');
    assert.deepEqual(JSON.parse(res.body().toString()), { results: [{ id: 73223 }] });
});

test('Vercel adapter reaches the scoped Worker fallback after both API providers fail', async () => {
    const calls = [];
    const handler = createHandler({
        env: {
            PRIMARY_API_KEY: 'fake-primary-key', PRIMARY_API_BASE_URL: 'https://titles.example.org/v1',
            GROQ_API_KEY: 'fake-groq-key',
            CF_AI_FALLBACK_URL: 'https://tapicf.coolmarket.eu.org/__normalize',
            CF_AI_FALLBACK_TOKEN: 'fake-normalizer-token',
        },
        fetchImpl: async (input, init) => {
            const url = new URL(String(input));
            calls.push({ url, headers: new Headers(init.headers), body: init.body && JSON.parse(init.body) });
            const failed = url.host === 'titles.example.org' || url.host === 'api.groq.com';
            return new Response(JSON.stringify(failed ? { error: 'busy' }
                : url.host === 'tapicf.coolmarket.eu.org' ? { title: '黑色五叶草', source: 'workers-ai' }
                    : { results: [{ id: 73223 }] }), {
                status: failed ? 503 : 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    const res = new ResponseSink();
    await handler(incoming('/3/search/tv?query=' + encodeURIComponent('[电影天堂] 黑色五叶草')), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('x-title-normalizer'), 'workers-ai');
    assert.deepEqual(calls.map(call => call.url.host), [
        'titles.example.org', 'api.groq.com', 'tapicf.coolmarket.eu.org', 'api.themoviedb.org',
    ]);
    assert.equal(calls[2].url.pathname, '/__normalize');
    assert.equal(calls[2].headers.get('authorization'), 'Bearer fake-normalizer-token');
    assert.equal(calls[2].body.title, '[电影天堂] 黑色五叶草');
    assert.equal(calls[3].url.searchParams.get('query'), '黑色五叶草');
});

test('Vercel streams binary image contents without forwarding stale decompression headers', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    const handler = createHandler({
        env: {},
        fetchImpl: async input => {
            assert.equal(String(input), 'https://image.tmdb.org/t/p/w500/cover.png?quality=80');
            return new Response(bytes, { headers: {
                'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': '999',
            } });
        },
    });
    const res = new ResponseSink();
    await handler(incoming('/t/p/w500/cover.png?quality=80'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body(), bytes);
    assert.equal(res.getHeader('content-type'), 'image/png');
    assert.equal(res.getHeader('content-encoding'), undefined);
    assert.equal(res.getHeader('content-length'), undefined);
});

test('Vercel preflight returns an empty CORS response without network activity', async () => {
    let calls = 0;
    const handler = createHandler({ env: {}, fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); } });
    const res = new ResponseSink();
    await handler(incoming('/3/search/tv', { method: 'OPTIONS' }), res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.getHeader('access-control-allow-origin'), '*');
    assert.equal(res.body().length, 0);
    assert.equal(calls, 0);
});

test('Vercel cannot serve the Worker-only private normalizer route', async () => {
    let calls = 0;
    const handler = createHandler({
        env: { NORMALIZER_TOKEN: 'internal-token' },
        fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); },
    });
    const res = new ResponseSink();
    await handler(incoming('/__normalize', {
        method: 'POST', body: { title: '黑色五叶草' },
        headers: { authorization: 'Bearer internal-token', 'content-type': 'application/json' },
    }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(calls, 0);
});

test('oversized incoming normalizer bodies are rejected before model execution', async () => {
    let calls = 0;
    const handler = createHandler({ env: {}, fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); } });
    const res = new ResponseSink();
    await handler(incoming('/__normalize', { method: 'POST', body: 'x'.repeat(17 * 1024) }), res);
    assert.equal(res.statusCode, 413);
    assert.equal(calls, 0);
});

test('a disconnected Vercel response aborts its outstanding TMDB fetch', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    let aborted = false;
    const handler = createHandler({
        env: { TMDB_TIMEOUT_MS: '1000', PROXY_TIMEOUT_MS: '2000' },
        fetchImpl: async (input, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                aborted = true;
                reject(new DOMException('Client disconnected', 'AbortError'));
            }, { once: true });
            started();
        }),
    });
    const res = new ResponseSink();
    const done = handler(incoming('/3/tv/73223'), res);
    await ready;
    res.destroy();
    let timer;
    try {
        await Promise.race([done, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Disconnect did not abort the active fetch promptly')), 200);
        })]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(aborted, true);
});
