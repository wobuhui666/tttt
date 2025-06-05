const axios = require('axios');
const TMDB_BASE_URL = 'https://api.themoviedb.org';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

// --- Configuration ---
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION_MS, 10) || 10 * 60 * 1000;
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE, 10) || 1000;

// --- Gemini API Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 更新模型名称为 gemini-1.5-flash-latest 或其他
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'gemini-2.0-flash'; // 从环境变量读取，提供默认值
const GEMINI_API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// --- Fallback OpenAI-Compatible API Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // 备用 API Key
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL; // 备用 API Base URL (例如: https://api.openai.com/v1 或 https://api.groq.com/openai/v1)
const OPENAI_MODEL_NAME = process.env.OPENAI_MODEL_NAME; // 备用 API 模型名称 (例如: gpt-3.5-turbo, llama3-8b-8192)
const OPENAI_API_ENDPOINT = OPENAI_API_BASE_URL ? `${OPENAI_API_BASE_URL}/chat/completions` : null; // 构建备用 API 端点

const GEMINI_FORMATTING_PATHS = [
    '/3/search/movie',
    '/3/search/tv',
    '/3/search/multi',
];

// --- Cache Implementation (无变化) ---
const cache = new Map();
function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now > value.expiry) {
            cache.delete(key);
        }
    }
}

function checkCacheSizeAndEvict() {
    if (cache.size > MAX_CACHE_SIZE) {
        let deleteCount = 0;
        const keysToDelete = Array.from(cache.keys());
        const numToDelete = cache.size - MAX_CACHE_SIZE;
        for (let i = 0; i < numToDelete; i++) {
            if (keysToDelete[i]) {
                cache.delete(keysToDelete[i]);
                deleteCount++;
            }
        }
        if (deleteCount > 0) {
            console.log(`[Cache] Cleaned ${deleteCount} oldest/LRU cache entries`);
        }
    }
}
setInterval(cleanExpiredCache, CACHE_DURATION);

// --- Shared Prompt for Title Cleaning ---
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

需要处理的文本是：`; // 注意：这里末尾没有输入文本，将在调用时添加

// --- Fallback OpenAI-Compatible API Call Function ---
async function callOpenAICompatibleAPI(textToFormat) {
    if (!OPENAI_API_KEY || !OPENAI_API_ENDPOINT || !OPENAI_MODEL_NAME) {
        console.warn('[Fallback API] OpenAI compatible API credentials or endpoint not set. Skipping fallback.');
        return textToFormat; // 如果备用 API 未配置，直接返回原文
    }

    console.log(`[Fallback API - ${OPENAI_MODEL_NAME}] Requesting core title extraction for: "${textToFormat}"`);
    try {
        const requestBody = {
            model: OPENAI_MODEL_NAME,
            messages: [
                // 可以选择性地添加 system message 来强化指令
                // {
                //   "role": "system",
                //   "content": "You are an assistant that extracts the core title from movie/TV show search terms, removing all extra information like year, season, episode, quality, etc."
                // },
                {
                    "role": "user",
                    "content": `${CLEAN_TITLE_PROMPT} "${textToFormat}"` // 将提示和待处理文本结合
                }
            ],
            temperature: 0.1,
            max_tokens: 80,
        };

        const response = await axios.post(OPENAI_API_ENDPOINT, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}` // 使用 Bearer Token
            }
        });

        if (response.data && response.data.choices && response.data.choices[0] &&
            response.data.choices[0].message && response.data.choices[0].message.content) {
            let formattedText = response.data.choices[0].message.content.trim();
            formattedText = formattedText.replace(/^["']|["']$/g, ''); // 移除可能的引号
            console.log(`[Fallback API - ${OPENAI_MODEL_NAME}] Core title result: "${formattedText}"`);
            return formattedText;
        } else {
            console.error(`[Fallback API - ${OPENAI_MODEL_NAME}] Unexpected response structure or empty content:`, response.data.choices ? response.data.choices[0] : response.data);
            return textToFormat; // 备用 API 返回结构异常，返回原文
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[Fallback API - ${OPENAI_MODEL_NAME}] Error calling API:`, errorMessage);
        return textToFormat; // 备用 API 调用出错，返回原文
    }
}


// --- Google Gemini API Call Function (with Fallback Logic) ---
async function callGoogleGeminiAPI(textToFormat) {
    if (!GEMINI_API_KEY) {
        console.warn('[Gemini API] GEMINI_API_KEY is not set. Attempting fallback...');
        return await callOpenAICompatibleAPI(textToFormat); // 主 API Key 未设置，尝试备用
    }
    if (!GEMINI_MODEL_NAME) {
        console.warn('[Gemini API] GEMINI_MODEL_NAME is not set in config. Attempting fallback...');
        return await callOpenAICompatibleAPI(textToFormat); // 主 API 模型未设置，尝试备用
    }

    console.log(`[Gemini API - ${GEMINI_MODEL_NAME}] Requesting core title extraction for: "${textToFormat}"`);
    try {
        const requestBody = {
            contents: [{
                parts: [{
                    text: `${CLEAN_TITLE_PROMPT} "${textToFormat}"` // 使用共享提示
                }]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 80,
            },
            safetySettings: [ // 安全设置保持不变
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            ]
        };

        const response = await axios.post(GEMINI_API_ENDPOINT, requestBody, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.candidates && response.data.candidates[0] &&
            response.data.candidates[0].content && response.data.candidates[0].content.parts &&
            response.data.candidates[0].content.parts[0] && response.data.candidates[0].content.parts[0].text) {
            let formattedText = response.data.candidates[0].content.parts[0].text.trim();
            formattedText = formattedText.replace(/^["']|["']$/g, ''); // 移除可能的引号
            console.log(`[Gemini API - ${GEMINI_MODEL_NAME}] Core title result: "${formattedText}"`);
            return formattedText;
        } else {
            // Gemini 返回了数据，但结构不符合预期或内容为空
            console.error(`[Gemini API - ${GEMINI_MODEL_NAME}] Unexpected response structure or empty content:`, response.data.candidates ? response.data.candidates[0] : response.data);
            console.log(`[Gemini API] Gemini response issue. Attempting fallback API for: "${textToFormat}"`);
            return await callOpenAICompatibleAPI(textToFormat); // 尝试备用 API
        }
    } catch (error) {
        // Gemini API 调用直接出错 (网络问题、认证失败等)
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[Gemini API - ${GEMINI_MODEL_NAME}] Error calling API:`, errorMessage);
        console.log(`[Gemini API] Gemini request failed. Attempting fallback API for: "${textToFormat}"`);
        return await callOpenAICompatibleAPI(textToFormat); // 尝试备用 API
    }
}

// --- Request Handlers (handleImageRequest 无变化) ---
async function handleImageRequest(req, res, fullPath) {
    const imagePath = fullPath.replace('/t/p/original/', '');
    const tmdbImageUrl = `${TMDB_IMAGE_BASE_URL}/${imagePath}`;
    try {
        const response = await axios.get(tmdbImageUrl, { responseType: 'stream' });
        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // 图像缓存可以长一些
        response.data.pipe(res);
    } catch (imageError) {
        console.error('[Image Handler] Error fetching image:', tmdbImageUrl, imageError.message);
        const status = imageError.response?.status || 500;
        const message = imageError.response?.data?.status_message || 'Failed to fetch/stream image';
        res.status(status).json({ error: message });
    }
}


// --- Request Handlers (handleApiRequest 调用主 AI 函数，内部处理备用逻辑) ---
async function handleApiRequest(req, res, originalFullPath) {
    let currentPath = originalFullPath;
    const authHeader = req.headers.authorization;
    const parsedUrl = new URL(originalFullPath, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 检查是否需要 AI 处理 query 参数
    if (GEMINI_FORMATTING_PATHS.includes(pathname)) {
        try {
            const urlObject = new URL(currentPath, 'http://localhost'); // 使用 currentPath 构建 URL 对象
            const queryParamValue = urlObject.searchParams.get('query');

            if (queryParamValue) {
                const textToFormatForAI = queryParamValue;
                console.log(`[API Handler] Original query for path "${pathname}" to be processed for core title: "${textToFormatForAI}"`);

                // 调用主 AI 函数 (内部包含备用逻辑)
                const coreTitleFromAI = await callGoogleGeminiAPI(textToFormatForAI);

                // 检查 AI 是否成功返回了不同的、非空的标题
                if (coreTitleFromAI && coreTitleFromAI.trim() !== "" && coreTitleFromAI !== queryParamValue) {
                    urlObject.searchParams.set('query', coreTitleFromAI);
                    currentPath = urlObject.pathname + urlObject.search; // 更新请求路径
                    console.log(`[API Handler] Path for "${pathname}" modified by AI to: ${currentPath}`);
                } else if (coreTitleFromAI === queryParamValue) {
                    console.log(`[API Handler] AI core title extraction resulted in no change for query: "${queryParamValue}"`);
                } else {
                    // AI 处理失败或返回空，使用原始 query
                    console.log(`[API Handler] AI core title extraction failed or returned empty for: "${queryParamValue}". Using original query.`);
                }
            } else {
                 console.log(`[API Handler] No 'query' parameter found in path "${pathname}". Skipping AI processing.`);
            }
        } catch (e) {
            console.error("[API Handler] Error during query formatting pre-processing:", e.message);
            // 即使预处理失败，也应继续尝试使用原始路径访问 TMDB
        }
    }

    // --- 缓存逻辑 (使用可能被 AI 修改后的 currentPath) ---
    const cacheKey = currentPath; // 使用最终的路径作为缓存键

    // 检查缓存
    if (cache.has(cacheKey)) {
        const cachedItem = cache.get(cacheKey);
        if (Date.now() < cachedItem.expiry) {
            console.log('[Cache] Hit:', cacheKey);
            // LRU: 重新设置以更新其在 Map 中的顺序
            cache.delete(cacheKey);
            cache.set(cacheKey, cachedItem);
            return res.status(200).json(cachedItem.data);
        } else {
            cache.delete(cacheKey);
            console.log('[Cache] Expired and deleted:', cacheKey);
        }
    }

    // --- TMDB API 调用 ---
    const tmdbUrl = `${TMDB_BASE_URL}${currentPath}`; // 使用最终路径
    const config = {};
    if (authHeader) {
        config.headers = { 'Authorization': authHeader };
    }

    console.log('[TMDB Proxy] Fetching from TMDB:', tmdbUrl);
    try {
        const response = await axios.get(tmdbUrl, config);
        // 缓存成功的响应
        if (response.status === 200) {
            checkCacheSizeAndEvict(); // 检查缓存大小
            cache.set(cacheKey, {
                data: response.data,
                expiry: Date.now() + CACHE_DURATION
            });
            console.log('[Cache] Miss and stored:', cacheKey);
        } else {
            console.log('[TMDB Proxy] Response not cached (non-200 status):', response.status, cacheKey);
        }
        res.status(response.status).json(response.data);
    } catch (tmdbError) {
        console.error('[TMDB Proxy] Error fetching from TMDB:', tmdbError.response ? JSON.stringify(tmdbError.response.data) : tmdbError.message);
        const status = tmdbError.response?.status || 500;
        const errorData = tmdbError.response?.data || { error: 'Failed to fetch data from TMDB.' };
        // 返回更详细的错误信息
        res.status(status).json({
            message: `Error fetching from upstream TMDB API: ${tmdbError.message}`,
            upstream_status: status,
            upstream_details: errorData,
            requested_url: tmdbUrl // 添加请求的 URL 方便调试
        });
    }
}

// --- Main Export (无变化) ---
module.exports = async (req, res) => {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*'); // 允许所有来源，生产环境建议更严格控制
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); // 允许的方法
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // 允许的请求头

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    try {
        const fullPath = req.url; // 获取完整的请求路径，包括查询参数

        // 路由：区分图片请求和 API 请求
        if (fullPath.startsWith('/t/p/original/')) {
            await handleImageRequest(req, res, fullPath);
        } else {
            await handleApiRequest(req, res, fullPath);
        }
    } catch (error) {
        // 通用错误处理，捕获未被具体处理函数捕获的异常
        console.error('[Main Export] General unhandled error:', error.message, error.stack);
        res.status(500).json({
            error: 'An unexpected general error occurred in the proxy.',
            details: error.message
        });
    }
};