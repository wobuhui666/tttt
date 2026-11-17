import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createProxy, normalizeTitleLocally as normalizeTitle, validateNormalizedTitle } from '../lib/proxy.mjs';

globalThis.crypto ??= webcrypto;

const CANONICAL = '黑色五叶草';
const UNCERTAIN = '[电影天堂] 黑色五叶草';
const RESULT = { page: 1, results: [{ id: 73223, name: CANONICAL }], total_results: 1 };
const PRIMARY_HOST = 'titles.example.org';

function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function search(title, { auth, key, path = '/3/search/tv', signal } = {}) {
    const url = new URL(path, 'https://t.coolmarket.eu.org');
    url.searchParams.set('query', title);
    url.searchParams.set('language', 'zh-CN');
    if (key) url.searchParams.set('api_key', key);
    return new Request(url, {
        headers: auth ? { Authorization: auth } : {},
        signal,
    });
}

function options(overrides = {}) {
    return {
        GROQ_API_KEY: 'fake-groq-key',
        GROQ_MODEL: 'qwen/qwen3.8-27b',
        GROQ_REASONING_EFFORT: 'none',
        TMDB_API_KEY: 'fake-tmdb-key',
        ...overrides,
    };
}

function primaryOptions(overrides = {}) {
    return options({
        PRIMARY_API_KEY: 'fake-primary-key',
        PRIMARY_API_BASE_URL: `https://${PRIMARY_HOST}/v1`,
        PRIMARY_MODEL: 'fast',
        ...overrides,
    });
}

function context() {
    const tasks = [];
    return {
        waitUntil(promise) { tasks.push(Promise.resolve(promise)); },
        async complete() { await Promise.all(tasks); },
    };
}

function requestData(input, init = {}) {
    return {
        url: new URL(input instanceof Request ? input.url : String(input)),
        headers: new Headers(init.headers || (input instanceof Request ? input.headers : {})),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init.signal || (input instanceof Request ? input.signal : undefined),
    };
}

function mockFetch(handler) {
    const calls = [];
    const fetchImpl = async (input, init) => {
        const call = requestData(input, init);
        calls.push(call);
        return handler(call);
    };
    return { fetchImpl, calls };
}

function groqAnswer(title) {
    return json({ choices: [{ message: { content: title }, finish_reason: 'stop' }] });
}

test('normalization removes release metadata while preserving actual numeric titles and sequel punctuation', () => {
    const cases = [
        ['黑色五叶草 (2017) 更新至171集 1080p 国语版', CANONICAL],
        ['庆余年 第二季 更新至10集 4K 国语版', '庆余年'],
        ['The Flash S01E05 1080p', 'The Flash'],
        ['1917 (2019) 高清', '1917'],
        ['终结者2：审判日 (1991)', '终结者2：审判日'],
        ['3月的狮子 第二季', '3月的狮子'],
        ['2001：太空漫游', '2001：太空漫游'],
        ['老九门', '老九门'],
        ['原声带', '原声带'],
        ['原声带 第二季 (2023)', '原声带'],
    ];
    for (const [input, expected] of cases) {
        assert.equal(normalizeTitle(input).title, expected, input);
    }
});

test('ordinary and explicitly decorated titles reach TMDB without any model request', async () => {
    for (const title of [CANONICAL, '黑色五叶草 (2017) 更新至171集 1080p 国语版']) {
        const { fetchImpl, calls } = mockFetch(call => {
            assert.equal(call.url.host, 'api.themoviedb.org');
            assert.equal(call.url.searchParams.get('query'), CANONICAL);
            return json(RESULT);
        });
        const handler = createProxy({ fetchImpl, platform: 'worker' });
        const response = await handler(search(title), options(), context());
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), RESULT);
        assert.equal(decodeURIComponent(response.headers.get('x-tmdb-query')), CANONICAL);
        assert.equal(response.headers.get('x-proxy-platform'), 'worker');
        assert.equal(calls.length, 1);
    }
});

test('an uncertain source wrapper can use Groq with a small explicit nonthinking budget', async () => {
    let bindingCalls = 0;
    const { fetchImpl, calls } = mockFetch(call => {
        if (call.url.host === 'api.groq.com') {
            assert.equal(call.body.model, 'qwen/qwen3.8-27b');
            assert.equal(call.body.reasoning_effort, 'none');
            assert.ok(call.body.max_completion_tokens > 0 && call.body.max_completion_tokens <= 128);
            return groqAnswer(CANONICAL);
        }
        assert.equal(call.url.host, 'api.themoviedb.org');
        assert.equal(call.url.searchParams.get('query'), CANONICAL);
        return json(RESULT);
    });
    const env = options({ AI: { async run() { bindingCalls++; return { response: CANONICAL }; } } });
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), env, context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'groq');
    assert.equal(calls.length, 2);
    assert.equal(bindingCalls, 0);
});

test('primary normalization uses fast and stops before either fallback after a valid answer', async () => {
    let bindingCalls = 0;
    const { fetchImpl, calls } = mockFetch(call => call.url.host === PRIMARY_HOST
        ? groqAnswer(CANONICAL) : json(RESULT));
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions({
        AI: { async run() { bindingCalls++; return { response: CANONICAL }; } },
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'primary');
    assert.equal(decodeURIComponent(response.headers.get('x-tmdb-query')), CANONICAL);
    assert.deepEqual(calls.map(call => call.url.host), [PRIMARY_HOST, 'api.themoviedb.org']);
    assert.equal(calls[0].url.pathname, '/v1/chat/completions');
    assert.equal(calls[0].headers.get('authorization'), 'Bearer fake-primary-key');
    assert.equal(calls[0].body.model, 'fast');
    assert.ok(calls[0].body.max_completion_tokens > 0 && calls[0].body.max_completion_tokens <= 128);
    assert.equal(calls[0].body.reasoning_effort, 'low');
    assert.equal(calls[0].body.messages[0].role, 'system');
    assert.deepEqual(JSON.parse(calls[0].body.messages[1].content), { title: normalizeTitle(UNCERTAIN).title });
    assert.equal(bindingCalls, 0);
});

test('a valid unchanged primary answer also stops both fallback providers', async () => {
    let bindingCalls = 0;
    const unchanged = normalizeTitle(UNCERTAIN).title;
    const { fetchImpl, calls } = mockFetch(call => call.url.host === PRIMARY_HOST
        ? groqAnswer(unchanged) : json(RESULT));
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions({
        AI: { async run() { bindingCalls++; return { response: CANONICAL }; } },
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'primary');
    assert.equal(decodeURIComponent(response.headers.get('x-tmdb-query')), unchanged);
    assert.deepEqual(calls.map(call => call.url.host), [PRIMARY_HOST, 'api.themoviedb.org']);
    assert.equal(bindingCalls, 0);
});

test('primary reasoning configuration matches the request and public health without exposing keys', async () => {
    for (const effort of [undefined, 'high']) {
        const { fetchImpl, calls } = mockFetch(call => call.url.host === PRIMARY_HOST
            ? groqAnswer(CANONICAL) : json(RESULT));
        const handler = createProxy({ fetchImpl, platform: 'worker' });
        const env = primaryOptions({ PRIMARY_REASONING_EFFORT: effort });
        const response = await handler(search(UNCERTAIN), env, context());
        assert.equal(response.headers.get('x-title-normalizer'), 'primary');
        assert.equal(calls[0].body.reasoning_effort, effort || 'low');
        const health = await handler(new Request('https://t.coolmarket.eu.org/healthz'), env, context());
        assert.equal(health.status, 200);
        const body = await health.text();
        assert.equal(JSON.parse(body).primary_model, 'fast');
        assert.equal(JSON.parse(body).primary_reasoning_effort, effort || 'low');
        assert.equal(body.includes(env.PRIMARY_API_KEY), false);
        assert.equal(body.includes(env.GROQ_API_KEY), false);
    }
});

test('primary transport errors and busy responses fall back to Groq before Workers AI', async () => {
    for (const failure of [429, 503, 'transport']) {
        let bindingCalls = 0;
        const { fetchImpl, calls } = mockFetch(call => {
            if (call.url.host === PRIMARY_HOST) {
                if (failure === 'transport') throw new Error('Provider unavailable');
                return json({ error: 'busy' }, failure);
            }
            return call.url.host === 'api.groq.com' ? groqAnswer(CANONICAL) : json(RESULT);
        });
        const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions({
            AI: { async run() { bindingCalls++; return { response: CANONICAL }; } },
        }), context());
        assert.equal(response.status, 200, String(failure));
        assert.equal(response.headers.get('x-title-normalizer'), 'groq', String(failure));
        assert.deepEqual(calls.map(call => call.url.host), [PRIMARY_HOST, 'api.groq.com', 'api.themoviedb.org']);
        assert.equal(bindingCalls, 0);
    }
});

test('primary explanations, thinking, invented titles, and truncated answers trigger Groq fallback', async () => {
    for (const [content, finishReason] of [
        ['<think>reasoning</think>黑色五叶草', 'stop'],
        ['The title is: 黑色五叶草', 'stop'],
        ['黑色四叶草', 'stop'],
        ['', 'stop'],
        [CANONICAL, 'length'],
    ]) {
        const { fetchImpl, calls } = mockFetch(call => {
            if (call.url.host === PRIMARY_HOST) return json({ choices: [{ message: { content }, finish_reason: finishReason }] });
            return call.url.host === 'api.groq.com' ? groqAnswer(CANONICAL) : json(RESULT);
        });
        const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions(), context());
        assert.equal(response.status, 200, content);
        assert.equal(response.headers.get('x-title-normalizer'), 'groq', content);
        assert.deepEqual(calls.map(call => call.url.host), [PRIMARY_HOST, 'api.groq.com', 'api.themoviedb.org']);
    }
});

test('both API providers failing reaches the Workers AI binding in order', async () => {
    const order = [];
    const { fetchImpl } = mockFetch(call => {
        order.push(call.url.host);
        return call.url.host === 'api.themoviedb.org' ? json(RESULT) : json({ error: 'busy' }, 503);
    });
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions({
        AI: { async run() { order.push('workers-ai'); return { response: CANONICAL }; } },
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'workers-ai');
    assert.deepEqual(order, [PRIMARY_HOST, 'api.groq.com', 'workers-ai', 'api.themoviedb.org']);
});

test('primary endpoint and model changes partition normalization and TMDB caches', async () => {
    const { fetchImpl, calls } = mockFetch(call => call.url.host === 'api.themoviedb.org'
        ? json(RESULT) : groqAnswer(CANONICAL));
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    for (const config of [
        {}, {},
        { PRIMARY_MODEL: 'fast-v2' },
        { PRIMARY_MODEL: 'fast-v2', PRIMARY_API_BASE_URL: 'https://other-titles.example.org/v1/' },
    ]) {
        const ctx = context();
        const response = await handler(search(UNCERTAIN), primaryOptions(config), ctx);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-title-normalizer'), 'primary');
        await ctx.complete();
    }
    const modelCalls = calls.filter(call => call.url.host !== 'api.themoviedb.org');
    assert.equal(modelCalls.length, 3);
    assert.deepEqual(modelCalls.map(call => [call.url.host, call.body.model]), [
        [PRIMARY_HOST, 'fast'], [PRIMARY_HOST, 'fast-v2'], ['other-titles.example.org', 'fast-v2'],
    ]);
    assert.equal(calls.filter(call => call.url.host === 'api.themoviedb.org').length, 3);
});

test('primary deadline aborts its fetch and permits Groq to finish', async () => {
    let aborted = false;
    const { fetchImpl, calls } = mockFetch(call => {
        if (call.url.host === PRIMARY_HOST) return new Promise((resolve, reject) => {
            call.signal.addEventListener('abort', () => {
                aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
        return call.url.host === 'api.groq.com' ? groqAnswer(CANONICAL) : json(RESULT);
    });
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions({
        PRIMARY_TIMEOUT_MS: '15', TITLE_AI_BUDGET_MS: '100', PROXY_TIMEOUT_MS: '300',
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'groq');
    assert.equal(aborted, true);
    assert.deepEqual(calls.map(call => call.url.host), [PRIMARY_HOST, 'api.groq.com', 'api.themoviedb.org']);
});

test('two timed out APIs leave the Workers AI binding within the shared budget', async () => {
    const aborted = [];
    let bindingCalls = 0;
    const { fetchImpl } = mockFetch(call => {
        if (call.url.host === 'api.themoviedb.org') return json(RESULT);
        return new Promise((resolve, reject) => {
            call.signal.addEventListener('abort', () => {
                aborted.push(call.url.host);
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    });
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), primaryOptions({
        PRIMARY_TIMEOUT_MS: '15', GROQ_TIMEOUT_MS: '15', TITLE_AI_BUDGET_MS: '150', PROXY_TIMEOUT_MS: '400',
        AI: { async run() { bindingCalls++; return { response: CANONICAL }; } },
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'workers-ai');
    assert.deepEqual(aborted, [PRIMARY_HOST, 'api.groq.com']);
    assert.equal(bindingCalls, 1);
});

test('exhausting the shared AI budget skips further providers and preserves the local title', async () => {
    let clock = 0;
    let bindingCalls = 0;
    const { fetchImpl, calls } = mockFetch(call => {
        if (call.url.host === PRIMARY_HOST) {
            clock = 60;
            throw new Error('Provider failed after spending the AI budget');
        }
        return json(RESULT);
    });
    const response = await createProxy({ fetchImpl, platform: 'worker', now: () => clock })(search(UNCERTAIN), primaryOptions({
        TITLE_AI_BUDGET_MS: '50', PROXY_TIMEOUT_MS: '200',
        AI: { async run() { bindingCalls++; return { response: CANONICAL }; } },
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'fallback');
    assert.equal(decodeURIComponent(response.headers.get('x-tmdb-query')), normalizeTitle(UNCERTAIN).title);
    assert.deepEqual(calls.map(call => call.url.host), [PRIMARY_HOST, 'api.themoviedb.org']);
    assert.equal(bindingCalls, 0);
});

test('a valid unchanged Groq answer does not invoke Workers AI', async () => {
    let bindingCalls = 0;
    const unchanged = normalizeTitle(UNCERTAIN).title;
    const { fetchImpl } = mockFetch(call => call.url.host === 'api.groq.com'
        ? groqAnswer(unchanged) : json(RESULT));
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN),
        options({ AI: { async run() { bindingCalls++; return { response: CANONICAL }; } } }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'groq');
    assert.equal(bindingCalls, 0);
});

test('the original uncertain query is cached before model calls on repeat requests', async () => {
    const { fetchImpl, calls } = mockFetch(call => call.url.host === 'api.groq.com'
        ? groqAnswer(CANONICAL) : json(RESULT));
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const ctx = context();
    const first = await handler(search(UNCERTAIN), options(), ctx);
    await ctx.complete();
    const second = await handler(search(UNCERTAIN), options(), context());
    assert.deepEqual(await first.json(), RESULT);
    assert.deepEqual(await second.json(), RESULT);
    assert.equal(calls.filter(call => call.url.host === 'api.groq.com').length, 1);
    assert.equal(calls.filter(call => call.url.host === 'api.themoviedb.org').length, 1);
});

test('simultaneous identical queries share one model request and one TMDB request', async () => {
    let release;
    const pendingModel = new Promise(resolve => { release = resolve; });
    const { fetchImpl, calls } = mockFetch(async call => {
        if (call.url.host === 'api.groq.com') {
            await pendingModel;
            return groqAnswer(CANONICAL);
        }
        return json(RESULT);
    });
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const first = handler(search(UNCERTAIN), options(), context());
    const second = handler(search(UNCERTAIN), options(), context());
    release();
    const responses = await Promise.all([first, second]);
    for (const response of responses) assert.deepEqual(await response.json(), RESULT);
    assert.equal(calls.filter(call => call.url.host === 'api.groq.com').length, 1);
    assert.equal(calls.filter(call => call.url.host === 'api.themoviedb.org').length, 1);
});

test('one cancelled caller does not abort shared TMDB work needed by another caller', async () => {
    let upstreamStarted;
    const ready = new Promise(resolve => { upstreamStarted = resolve; });
    let release;
    let transportAborted = false;
    const pending = new Promise(resolve => { release = resolve; });
    const { fetchImpl, calls } = mockFetch(async call => {
        call.signal.addEventListener('abort', () => { transportAborted = true; }, { once: true });
        upstreamStarted();
        await pending;
        return json(RESULT);
    });
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const cancelled = new AbortController();
    const first = handler(search(CANONICAL, { signal: cancelled.signal }), options(), context());
    await ready;
    const second = handler(search(CANONICAL), options(), context());
    await new Promise(resolve => setTimeout(resolve, 20));
    cancelled.abort();
    release();
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes[1].status, 'fulfilled');
    assert.equal(outcomes[1].value.status, 200);
    assert.deepEqual(await outcomes[1].value.json(), RESULT);
    assert.equal(calls.length, 1);
    assert.equal(transportAborted, false);
});

test('cancelling every shared caller aborts the outstanding TMDB HTTP request promptly', async () => {
    let upstreamStarted;
    const ready = new Promise(resolve => { upstreamStarted = resolve; });
    let transportAborted = false;
    const { fetchImpl, calls } = mockFetch(call => new Promise((resolve, reject) => {
        call.signal.addEventListener('abort', () => {
            transportAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
        upstreamStarted();
    }));
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const env = options({ TMDB_TIMEOUT_MS: '1000', PROXY_TIMEOUT_MS: '2000' });
    const first = handler(search(CANONICAL, { signal: firstController.signal }), env, context());
    await ready;
    const second = handler(search(CANONICAL, { signal: secondController.signal }), env, context());
    await new Promise(resolve => setTimeout(resolve, 20));
    firstController.abort();
    secondController.abort();
    let timer;
    try {
        await Promise.race([Promise.allSettled([first, second]), new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('All cancelled callers left the shared fetch running')), 200);
        })]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(calls.length, 1);
    assert.equal(transportAborted, true);
});

test('bearer credentials and URL API keys do not share TMDB result caches', async () => {
    const { fetchImpl, calls } = mockFetch(call => json({
        identity: call.headers.get('authorization') || call.url.searchParams.get('api_key'),
    }));
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    for (const credentials of [{ auth: 'Bearer alpha' }, { auth: 'Bearer beta' }, { key: 'alpha' }, { key: 'beta' }]) {
        const response = await handler(search(CANONICAL, credentials), options({ TMDB_API_KEY: '' }), context());
        assert.equal((await response.json()).identity, credentials.auth || credentials.key);
    }
    assert.equal(calls.length, 4);
});

test('a changed server TMDB key cannot reuse a response from an old key', async () => {
    const { fetchImpl, calls } = mockFetch(call => json({ identity: call.url.searchParams.get('api_key') }));
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    for (const key of ['server-alpha', 'server-beta']) {
        const response = await handler(search(CANONICAL), options({ TMDB_API_KEY: key }), context());
        assert.equal((await response.json()).identity, key);
    }
    assert.equal(calls.length, 2);
});

test('Groq request failure falls back to the Workers AI binding', async () => {
    const bindingCalls = [];
    const { fetchImpl } = mockFetch(call => {
        if (call.url.host === 'api.groq.com') throw new Error('Provider unavailable');
        assert.equal(call.url.searchParams.get('query'), CANONICAL);
        return json(RESULT);
    });
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN),
        options({ AI: { async run(model, body) { bindingCalls.push({ model, body }); return { response: CANONICAL }; } } }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'workers-ai');
    assert.equal(bindingCalls.length, 1);
    assert.equal(bindingCalls[0].model, '@cf/meta/llama-3.1-8b-instruct-fast');
});

test('invalid Groq explanations and thinking output are rejected before Workers AI fallback', async () => {
    for (const output of ['<think>reasoning</think>黑色五叶草', 'The core title is: 黑色五叶草', '', '```\n黑色五叶草\n```']) {
        let bindingCalls = 0;
        const { fetchImpl } = mockFetch(call => call.url.host === 'api.groq.com'
            ? groqAnswer(output) : json(RESULT));
        const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN),
            options({ AI: { async run() { bindingCalls++; return { response: CANONICAL }; } } }), context());
        assert.equal(response.status, 200, output);
        assert.equal(response.headers.get('x-title-normalizer'), 'workers-ai', output);
        assert.equal(bindingCalls, 1, output);
    }
});

test('model output cannot invent a different title or drop a real sequel number', () => {
    assert.equal(validateNormalizedTitle('黑色四叶草', CANONICAL), null);
    assert.equal(validateNormalizedTitle('终结者', '终结者2：审判日 (1991)'), null);
    assert.equal(validateNormalizedTitle('1917', '1917 (2019) 高清'), '1917');
    assert.equal(validateNormalizedTitle('终结者2：审判日', '终结者2：审判日 (1991)'), '终结者2：审判日');
});

test('Vercel fallback uses the scoped Worker normalizer endpoint without a management API token', async () => {
    const { fetchImpl, calls } = mockFetch(call => {
        if (call.url.host === 'api.groq.com') return json({ error: 'busy' }, 503);
        if (call.url.host === 'tapicf.coolmarket.eu.org') {
            assert.equal(call.url.pathname, '/__normalize');
            assert.equal(call.headers.get('authorization'), 'Bearer fake-normalizer-token');
            assert.equal(call.body.title, normalizeTitle(UNCERTAIN).title);
            return json({ title: CANONICAL, source: 'workers-ai' });
        }
        assert.equal(call.url.host, 'api.themoviedb.org');
        assert.equal(call.url.searchParams.get('query'), CANONICAL);
        return json(RESULT);
    });
    const response = await createProxy({ fetchImpl, platform: 'vercel' })(search(UNCERTAIN), options({
        CF_AI_FALLBACK_URL: 'https://tapicf.coolmarket.eu.org/__normalize',
        CF_AI_FALLBACK_TOKEN: 'fake-normalizer-token',
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'workers-ai');
    assert.equal(calls.length, 3);
    assert.equal(calls.some(call => call.url.host === 'api.cloudflare.com'), false);
});

test('Worker private normalizer requires its own token and never calls Groq', async () => {
    let bindingCalls = 0;
    const { fetchImpl, calls } = mockFetch(() => { throw new Error('Unexpected network call'); });
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const env = options({ NORMALIZER_TOKEN: 'internal-token', AI: { async run() { bindingCalls++; return { response: CANONICAL }; } } });
    for (const token of ['', 'wrong-token']) {
        const response = await handler(new Request('https://tapicf.coolmarket.eu.org/__normalize', {
            method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ title: UNCERTAIN }),
        }), env, context());
        assert.ok(response.status === 401 || response.status === 403);
    }
    assert.equal(bindingCalls, 0);
    const success = await handler(new Request('https://tapicf.coolmarket.eu.org/__normalize', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer internal-token' },
        body: JSON.stringify({ title: UNCERTAIN }),
    }), env, context());
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { title: CANONICAL, source: 'workers-ai' });
    assert.equal(bindingCalls, 1);
    assert.equal(calls.length, 0);
});

test('Worker private normalizer rejects malformed or oversized JSON before inference', async () => {
    let bindingCalls = 0;
    const handler = createProxy({ fetchImpl: async () => { throw new Error('Unexpected fetch'); }, platform: 'worker' });
    const env = options({ NORMALIZER_TOKEN: 'internal-token', AI: { async run() { bindingCalls++; return { response: CANONICAL }; } } });
    for (const [body, status] of [['not-json', 400], [JSON.stringify({ title: '' }), 400], ['x'.repeat(5000), 413]]) {
        const response = await handler(new Request('https://tapicf.coolmarket.eu.org/__normalize', {
            method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer internal-token' }, body,
        }), env, context());
        assert.equal(response.status, status);
    }
    assert.equal(bindingCalls, 0);
});

test('detail metadata preserves append fields and needs no title model', async () => {
    const { fetchImpl, calls } = mockFetch(call => {
        assert.equal(call.url.pathname, '/3/tv/73223');
        assert.equal(call.url.searchParams.get('append_to_response'), 'external_ids,episode_groups');
        assert.equal(call.url.searchParams.has('path'), false);
        return json({ id: 73223, external_ids: { imdb_id: 'tt7441658' } });
    });
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const response = await handler(new Request('https://t.coolmarket.eu.org/3/tv/73223?append_to_response=external_ids%2Cepisode_groups&path=unused'), options(), context());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 73223);
    assert.equal(calls.length, 1);
});

test('Groq deadline aborts its actual fetch then permits the bounded binding fallback', async () => {
    let aborted = false;
    const { fetchImpl } = mockFetch(call => {
        if (call.url.host !== 'api.groq.com') return json(RESULT);
        return new Promise((resolve, reject) => {
            assert.ok(call.signal);
            call.signal.addEventListener('abort', () => {
                aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    });
    const start = Date.now();
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), options({
        GROQ_TIMEOUT_MS: '15', TITLE_AI_BUDGET_MS: '50', TMDB_TIMEOUT_MS: '100', PROXY_TIMEOUT_MS: '200',
        AI: { async run() { return { response: CANONICAL }; } },
    }), context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-title-normalizer'), 'workers-ai');
    assert.equal(aborted, true);
    assert.ok(Date.now() - start < 400);
});

test('a hanging Workers AI binding does not hold the response past its budget', async () => {
    const { fetchImpl } = mockFetch(call => call.url.host === 'api.groq.com'
        ? json({ error: 'busy' }, 503) : json(RESULT));
    const start = Date.now();
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(UNCERTAIN), options({
        GROQ_TIMEOUT_MS: '10', TITLE_AI_BUDGET_MS: '35', TMDB_TIMEOUT_MS: '60', PROXY_TIMEOUT_MS: '100',
        AI: { run() { return new Promise(() => {}); } },
    }), context());
    assert.equal(response.status, 200);
    assert.ok(Date.now() - start < 300);
});

test('the upstream TMDB deadline cancels the HTTP request and returns a finite gateway response', async () => {
    let aborted = false;
    const { fetchImpl } = mockFetch(call => new Promise((resolve, reject) => {
        assert.equal(call.url.host, 'api.themoviedb.org');
        call.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    }));
    const start = Date.now();
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(CANONICAL), options({
        TMDB_TIMEOUT_MS: '20', PROXY_TIMEOUT_MS: '60',
    }), context());
    assert.ok(response.status === 502 || response.status === 504);
    assert.equal(aborted, true);
    assert.ok(Date.now() - start < 300);
});

test('upstream error details never expose the caller API key or bearer credential', async () => {
    const { fetchImpl } = mockFetch(() => json({
        status_message: 'Invalid credentials',
    }, 401));
    const response = await createProxy({ fetchImpl, platform: 'worker' })(search(CANONICAL, {
        auth: 'Bearer private-bearer-value', key: 'private-url-key',
    }), options(), context());
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.equal(text.includes('private-url-key'), false);
    assert.equal(text.includes('private-bearer-value'), false);
    for (const [, value] of response.headers) {
        assert.equal(value.includes('private-url-key'), false);
        assert.equal(value.includes('private-bearer-value'), false);
    }
});

test('CORS preflight and unsupported methods do not consume model or TMDB requests', async () => {
    const { fetchImpl, calls } = mockFetch(() => { throw new Error('Unexpected network call'); });
    const handler = createProxy({ fetchImpl, platform: 'worker' });
    const optionsResponse = await handler(new Request('https://t.coolmarket.eu.org/3/search/tv', { method: 'OPTIONS' }), options(), context());
    assert.equal(optionsResponse.status, 204);
    assert.equal(optionsResponse.headers.get('access-control-allow-origin'), '*');
    const postResponse = await handler(new Request('https://t.coolmarket.eu.org/3/search/tv', { method: 'POST' }), options(), context());
    assert.equal(postResponse.status, 405);
    assert.equal(calls.length, 0);
});

test('image proxy preserves binary contents, cache headers, and original query parameters', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const { fetchImpl, calls } = mockFetch(call => {
        assert.equal(call.url.toString(), 'https://image.tmdb.org/t/p/w500/poster.png?quality=80');
        return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    });
    const response = await createProxy({ fetchImpl, platform: 'worker' })(
        new Request('https://t.coolmarket.eu.org/t/p/w500/poster.png?quality=80'), options(), context());
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.match(response.headers.get('cache-control'), /max-age=/);
    assert.equal(calls.length, 1);
});
