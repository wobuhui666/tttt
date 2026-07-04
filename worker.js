const TMDB_BASE_URL = "https://api.themoviedb.org";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

const DEFAULT_CACHE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHE_SIZE = 1000;

const AI_FORMATTING_PATHS = [
    "/3/search/movie",
    "/3/search/tv",
    "/3/search/multi",
];

const memoryCache = new Map();

const CLEAN_TITLE_PROMPT = `请从以下影视搜索词中提取最核心的标题。务必移除所有与核心标题无关的附加信息，包括但不限于：
- 年份信息（如“(2023)”，“（1998）”）
- 季数信息（如“第一季”、“第二季”、“S01”、“Season 2”）
- 集数信息（如“第3集”、“更新至10集”、“E03”）
- 版本或配音（如“中文字幕”、“国语版”、“粤配”、“原声”）
- 清晰度（如“720p”、“1080p”、“4K”、“高清版”、“HD”）
- 更新状态（如“更新”、“连载中”、“已完结”、“大结局”、“最新”）
- 网站或来源标记（如“XX影视”、“在线观看”）
- 其他任何修饰性词语、标点符号或与核心标题无关的字符。
目标是得到一个最纯净的、仅包含作品名称的字符串。
如果原始标题本身包含数字且该数字不是季数或年份（例如 “老九门” 或 “1917”），则应保留。

例如：
输入：“间谍过家家 第二季 (2023) 更新至第5集 1080p 中配” 应输出：“间谍过家家”
输入：“庆余年 第一季 大结局 (2019)” 应输出：“庆余年”
输入：“苍兰诀 (2022) 全集 粤语版” 应输出：“苍兰诀”
输入：“莲花楼 720p” 应输出：“莲花楼”
输入：“无忧渡（2025）更新” 应输出：“无忧渡”
输入：“The Flash S01E05 1080p” 应输出：“The Flash”
输入：“老友记 第十季” 应输出：“老友记”
输入：“神秘博士 第九季 (2015)” 应输出：“神秘博士”
输入：“鱿鱼游戏 (2021) S01” 应输出：“鱿鱼游戏”
输入：“1917 (2019) 高清” 应输出：“1917”
输入：“终结者2：审判日 (1991)” 应输出：“终结者2：审判日”

请直接返回处理后的文本，不要添加任何解释或多余的文字。

需要处理的文本是：`;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method !== "GET") {
            return jsonResponse({ error: "Method not allowed." }, 405);
        }

        try {
            const url = new URL(request.url);

            if (url.pathname === "/") {
                return Response.redirect("https://github.com/imaliang/tmdb-proxy", 308);
            }

            if (url.pathname.startsWith("/t/p/")) {
                return handleImageRequest(url);
            }

            return handleApiRequest(request, env, ctx, url);
        } catch (error) {
            console.error("[Worker] Unhandled error:", error.message, error.stack);
            return jsonResponse({
                error: "An unexpected general error occurred in the proxy.",
                details: error.message,
            }, 500);
        }
    },
};

async function handleImageRequest(url) {
    const imageMatch = url.pathname.match(/^\/t\/p\/([^/]+)\/(.+)$/);
    if (!imageMatch) {
        return jsonResponse({ error: "Invalid TMDB image path." }, 400);
    }

    const [, size, filePath] = imageMatch;
    const tmdbImageUrl = `${TMDB_IMAGE_BASE_URL}/${size}/${filePath}${url.search}`;
    const response = await fetch(tmdbImageUrl);

    if (!response.ok) {
        return jsonResponse({ error: "Failed to fetch image from TMDB." }, response.status);
    }

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "public, max-age=31536000");
    appendCorsHeaders(headers);

    return new Response(response.body, {
        status: response.status,
        headers,
    });
}

async function handleApiRequest(request, env, ctx, url) {
    const authHeader = request.headers.get("Authorization");
    let currentUrl = new URL(url.toString());
    currentUrl.searchParams.delete("path");

    if (AI_FORMATTING_PATHS.includes(currentUrl.pathname)) {
        currentUrl = await applyAiQueryFormatting(currentUrl, env);
    }

    const cacheKey = currentUrl.pathname + currentUrl.search;
    const cachedResponse = getCachedResponse(cacheKey);
    if (cachedResponse) {
        console.log("[Cache] Hit:", redactApiKey(cacheKey));
        return jsonResponse(cachedResponse, 200);
    }

    const tmdbUrl = buildTmdbUrl(currentUrl, authHeader, env);
    const headers = new Headers();
    if (authHeader) {
        headers.set("Authorization", authHeader);
    }

    console.log("[TMDB Proxy] Fetching from TMDB:", redactApiKey(tmdbUrl.toString()));
    const response = await fetch(tmdbUrl, { headers });
    const payload = await readJsonSafely(response);

    if (!response.ok) {
        return jsonResponse({
            message: `Error fetching from upstream TMDB API: ${response.statusText || response.status}`,
            upstream_status: response.status,
            upstream_details: payload || { error: "Failed to fetch data from TMDB." },
            requested_url: redactApiKey(tmdbUrl.toString()),
        }, response.status);
    }

    if (payload !== null) {
        const cacheDuration = parseInteger(env.CACHE_DURATION_MS, DEFAULT_CACHE_DURATION_MS);
        const maxCacheSize = parseInteger(env.MAX_CACHE_SIZE, DEFAULT_MAX_CACHE_SIZE);
        ctx.waitUntil(Promise.resolve().then(() => {
            cleanExpiredCache();
            trimCache(maxCacheSize);
            memoryCache.set(cacheKey, {
                data: payload,
                expiry: Date.now() + cacheDuration,
            });
            console.log("[Cache] Miss and stored:", redactApiKey(cacheKey));
        }));
    }

    return jsonResponse(payload, response.status);
}

async function applyAiQueryFormatting(url, env) {
    const query = url.searchParams.get("query");
    if (!query) {
        console.log(`[API Handler] No 'query' parameter found in path "${url.pathname}". Skipping AI processing.`);
        return url;
    }

    console.log(`[API Handler] Original query for path "${url.pathname}" to be processed: "${query}"`);
    let coreTitle = await callOpenAICompatibleAPI(query, env);

    if (coreTitle === query) {
        console.log(`[API Handler] Primary AI (${env.OPENAI_MODEL_NAME || "Not Configured"}) failed or returned original text. Attempting fallback AI.`);
        coreTitle = await callGoogleGeminiAPI(query, env);
    }

    if (coreTitle && coreTitle.trim() && coreTitle !== query) {
        const formattedUrl = new URL(url.toString());
        formattedUrl.searchParams.set("query", coreTitle);
        console.log(`[API Handler] Path for "${url.pathname}" modified by AI to: ${formattedUrl.pathname + formattedUrl.search}`);
        return formattedUrl;
    }

    console.log(`[API Handler] AI core title extraction resulted in no change for query: "${query}"`);
    return url;
}

async function callOpenAICompatibleAPI(textToFormat, env) {
    const apiKey = env.OPENAI_API_KEY;
    const baseUrl = trimTrailingSlash(env.OPENAI_API_BASE_URL || "");
    const modelName = env.OPENAI_MODEL_NAME;

    if (!apiKey || !baseUrl || !modelName) {
        console.warn("[Primary AI] OpenAI compatible API credentials or endpoint not set. Cannot process.");
        return textToFormat;
    }

    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                {
                    role: "user",
                    content: `${CLEAN_TITLE_PROMPT} "${textToFormat}"`,
                },
            ],
            temperature: 0.1,
            max_tokens: 999999,
        }),
    });

    if (!response.ok) {
        console.error(`[Primary AI - ${modelName}] Error calling API:`, await response.text());
        return textToFormat;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return normalizeAiText(content, textToFormat, `[Primary AI - ${modelName}]`);
}

async function callGoogleGeminiAPI(textToFormat, env) {
    const apiKey = env.GEMINI_API_KEY;
    const modelName = env.GEMINI_MODEL_NAME || "gemini-2.0-flash";

    if (!apiKey || !modelName) {
        console.warn("[Fallback AI] Gemini API credentials or endpoint not set. Cannot process.");
        return textToFormat;
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        {
                            text: `${CLEAN_TITLE_PROMPT} "${textToFormat}"`,
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 80,
            },
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            ],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Fallback AI - ${modelName}] Error calling API:`, errorText);
        if (errorText.includes("CONSUMER_SUSPENDED")) {
            console.warn(`[Fallback AI - ${modelName}] API key/project is suspended. Skipping Gemini result.`);
        }
        return textToFormat;
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return normalizeAiText(content, textToFormat, `[Fallback AI - ${modelName}]`);
}

function buildTmdbUrl(url, authHeader, env) {
    const tmdbUrl = new URL(url.pathname + url.search, TMDB_BASE_URL);
    const tmdbApiKey = (env.TMDB_API_KEY || "").trim();

    if (!authHeader && tmdbApiKey) {
        tmdbUrl.searchParams.set("api_key", tmdbApiKey);
    }

    return tmdbUrl;
}

function getCachedResponse(cacheKey) {
    const cachedItem = memoryCache.get(cacheKey);
    if (!cachedItem) {
        return null;
    }

    if (Date.now() >= cachedItem.expiry) {
        memoryCache.delete(cacheKey);
        console.log("[Cache] Expired and deleted:", redactApiKey(cacheKey));
        return null;
    }

    memoryCache.delete(cacheKey);
    memoryCache.set(cacheKey, cachedItem);
    return cachedItem.data;
}

function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of memoryCache.entries()) {
        if (now > value.expiry) {
            memoryCache.delete(key);
        }
    }
}

function trimCache(maxCacheSize) {
    while (memoryCache.size > maxCacheSize) {
        const oldestKey = memoryCache.keys().next().value;
        memoryCache.delete(oldestKey);
    }
}

async function readJsonSafely(response) {
    const text = await response.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return { data: text };
    }
}

function normalizeAiText(content, fallback, label) {
    const formattedText = String(content || "").trim().replace(/^["']|["']$/g, "");
    if (!formattedText) {
        console.warn(`${label} Received empty or invalid content:`, content);
        return fallback;
    }

    console.log(`${label} Core title result: "${formattedText}"`);
    return formattedText;
}

async function fetchWithTimeout(url, init, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

function jsonResponse(data, status = 200) {
    const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders,
    });

    return new Response(JSON.stringify(data), { status, headers });
}

function appendCorsHeaders(headers) {
    for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
    }
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value) {
    return value.replace(/\/+$/, "");
}

function redactApiKey(value) {
    return value.replace(/([?&]api_key=)[^&]*/g, "$1[REDACTED]");
}
