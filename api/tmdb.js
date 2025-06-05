const axios = require('axios');
const TMDB_BASE_URL = 'https://api.themoviedb.org';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

// --- Configuration ---
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION_MS, 10) || 10 * 60 * 1000;
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE, 10) || 1000;

// --- Primary OpenAI-Compatible API Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL;
const OPENAI_MODEL_NAME = process.env.OPENAI_MODEL_NAME;
const OPENAI_API_ENDPOINT = OPENAI_API_BASE_URL ? `${OPENAI_API_BASE_URL}/chat/completions` : null;

// --- Fallback Gemini API Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'gemini-2.0-flash';
const GEMINI_API_ENDPOINT = GEMINI_API_KEY ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}` : null; // 只有设置了Key才构建 Endpoint

const AI_FORMATTING_PATHS = [ // 重命名以反映通用性
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

// --- Shared Prompt for Title Cleaning (无变化) ---
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

// --- Primary OpenAI-Compatible API Call Function ---
async function callOpenAICompatibleAPI(textToFormat) {
    if (!OPENAI_API_KEY || !OPENAI_API_ENDPOINT || !OPENAI_MODEL_NAME) {
        console.warn('[Primary AI] OpenAI compatible API credentials or endpoint not set. Cannot process.');
        return textToFormat; // 返回原始文本表示无法处理
    }

    console.log(`[Primary AI - ${OPENAI_MODEL_NAME}] Requesting core title extraction for: "${textToFormat}"`);
    try {
        const requestBody = {
            model: OPENAI_MODEL_NAME,
            messages: [
                {
                    "role": "user",
                    "content": `${CLEAN_TITLE_PROMPT} "${textToFormat}"`
                }
            ],
            temperature: 0.1,
            max_tokens: 80,
        };

        const response = await axios.post(OPENAI_API_ENDPOINT, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            timeout: 15000 // 添加超时设置 (15秒)
        });

        if (response.data && response.data.choices && response.data.choices[0] &&
            response.data.choices[0].message && response.data.choices[0].message.content) {
            let formattedText = response.data.choices[0].message.content.trim();
            formattedText = formattedText.replace(/^["']|["']$/g, '');
            // 检查是否真的提取了内容，而不是返回空字符串或仅有标点
            if (formattedText && formattedText.length > 0) {
                 console.log(`[Primary AI - ${OPENAI_MODEL_NAME}] Core title result: "${formattedText}"`);
                 return formattedText;
            } else {
                 console.warn(`[Primary AI - ${OPENAI_MODEL_NAME}] Received empty or invalid content:`, response.data.choices[0].message.content);
                 return textToFormat; // 返回原始文本表示处理失败
            }
        } else {
            console.error(`[Primary AI - ${OPENAI_MODEL_NAME}] Unexpected response structure or empty content:`, response.data.choices ? response.data.choices[0] : response.data);
            return textToFormat; // 返回原始文本表示处理失败
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[Primary AI - ${OPENAI_MODEL_NAME}] Error calling API:`, errorMessage);
        return textToFormat; // 返回原始文本表示处理失败
    }
}


// --- Fallback Google Gemini API Call Function ---
async function callGoogleGeminiAPI(textToFormat) {
    // 检查 Gemini 配置是否完整
    if (!GEMINI_API_KEY || !GEMINI_MODEL_NAME || !GEMINI_API_ENDPOINT) {
        console.warn('[Fallback AI] Gemini API credentials or endpoint not set. Cannot process.');
        return textToFormat; // 返回原始文本表示无法处理
    }

    console.log(`[Fallback AI - ${GEMINI_MODEL_NAME}] Requesting core title extraction for: "${textToFormat}"`);
    try {
        const requestBody = {
            contents: [{
                parts: [{
                    text: `${CLEAN_TITLE_PROMPT} "${textToFormat}"`
                }]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 80,
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            ]
        };

        const response = await axios.post(GEMINI_API_ENDPOINT, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000 // 添加超时设置 (15秒)
        });

        if (response.data && response.data.candidates && response.data.candidates[0] &&
            response.data.candidates[0].content && response.data.candidates[0].content.parts &&
            response.data.candidates[0].content.parts[0] && response.data.candidates[0].content.parts[0].text) {
            let formattedText = response.data.candidates[0].content.parts[0].text.trim();
            formattedText = formattedText.replace(/^["']|["']$/g, '');
            // 检查是否真的提取了内容
             if (formattedText && formattedText.length > 0) {
                 console.log(`[Fallback AI - ${GEMINI_MODEL_NAME}] Core title result: "${formattedText}"`);
                 return formattedText;
            } else {
                 console.warn(`[Fallback AI - ${GEMINI_MODEL_NAME}] Received empty or invalid content:`, response.data.candidates[0].content.parts[0].text);
                 return textToFormat; // 返回原始文本表示处理失败
            }
        } else {
            console.error(`[Fallback AI - ${GEMINI_MODEL_NAME}] Unexpected response structure or empty content:`, response.data.candidates ? response.data.candidates[0] : response.data);
            return textToFormat; // 返回原始文本表示处理失败
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[Fallback AI - ${GEMINI_MODEL_NAME}] Error calling API:`, errorMessage);
        // 特别处理 CONSUMER_SUSPENDED 错误，避免不必要的日志刷屏
        if (errorMessage.includes("CONSUMER_SUSPENDED")) {
             console.warn(`[Fallback AI - ${GEMINI_MODEL_NAME}] API key/project is suspended. Skipping further Gemini attempts until resolved.`);
             // 可以考虑在这里设置一个临时标志，短时间内不再尝试 Gemini
        }
        return textToFormat; // 返回原始文本表示处理失败
    }
}

// --- Request Handlers (handleImageRequest 无变化) ---
async function handleImageRequest(req, res, fullPath) {
    const imagePath = fullPath.replace('/t/p/original/', '');
    const tmdbImageUrl = `${TMDB_IMAGE_BASE_URL}/${imagePath}`;
    try {
        const response = await axios.get(tmdbImageUrl, { responseType: 'stream' });
        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        response.data.pipe(res);
    } catch (imageError) {
        console.error('[Image Handler] Error fetching image:', tmdbImageUrl, imageError.message);
        const status = imageError.response?.status || 500;
        const message = imageError.response?.data?.status_message || 'Failed to fetch/stream image';
        res.status(status).json({ error: message });
    }
}


// --- Request Handlers (handleApiRequest with Primary/Fallback Logic) ---
async function handleApiRequest(req, res, originalFullPath) {
    let currentPath = originalFullPath;
    const authHeader = req.headers.authorization;
    const parsedUrl = new URL(originalFullPath, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    let coreTitleFromAI = null; // 用于存储最终AI处理结果
    let queryParamValue = null; // 存储原始 query 值

    // 检查是否需要 AI 处理 query 参数
    if (AI_FORMATTING_PATHS.includes(pathname)) {
        try {
            const urlObject = new URL(currentPath, 'http://localhost');
            queryParamValue = urlObject.searchParams.get('query'); // 获取原始 query

            if (queryParamValue) {
                const textToFormatForAI = queryParamValue;
                console.log(`[API Handler] Original query for path "${pathname}" to be processed: "${textToFormatForAI}"`);

                // --- Step 1: Try Primary AI (OpenAI Compatible) ---
                coreTitleFromAI = await callOpenAICompatibleAPI(textToFormatForAI);

                // --- Step 2: Check Primary AI result, if failed or no change, try Fallback AI (Gemini) ---
                // 如果主 AI 返回了原始文本 (表示失败或未配置)，则尝试备用 AI
                if (coreTitleFromAI === textToFormatForAI) {
                    console.log(`[API Handler] Primary AI (${OPENAI_MODEL_NAME || 'Not Configured'}) failed or returned original text. Attempting fallback AI.`);
                    coreTitleFromAI = await callGoogleGeminiAPI(textToFormatForAI);

                    // 如果备用 AI 也返回了原始文本 (表示失败或未配置)
                    if (coreTitleFromAI === textToFormatForAI) {
                         console.log(`[API Handler] Fallback AI (${GEMINI_MODEL_NAME || 'Not Configured'}) also failed or returned original text. Using original query.`);
                         // coreTitleFromAI 保持为原始文本
                    }
                }

                // --- Step 3: Apply the result if AI processing was successful and changed the query ---
                // 检查最终的 AI 结果是否有效且与原始 query 不同
                if (coreTitleFromAI && coreTitleFromAI.trim() !== "" && coreTitleFromAI !== queryParamValue) {
                    urlObject.searchParams.set('query', coreTitleFromAI);
                    currentPath = urlObject.pathname + urlObject.search; // 更新请求路径
                    console.log(`[API Handler] Path for "${pathname}" modified by AI to: ${currentPath}`);
                } else if (coreTitleFromAI === queryParamValue) {
                    console.log(`[API Handler] AI core title extraction resulted in no change for query: "${queryParamValue}"`);
                } else {
                    // AI 处理失败或返回空，使用原始 query (coreTitleFromAI 此时等于 queryParamValue)
                    console.log(`[API Handler] AI core title extraction failed or returned empty/invalid. Using original query: "${queryParamValue}"`);
                    coreTitleFromAI = queryParamValue; // 确保使用原始值
                }
            } else {
                 console.log(`[API Handler] No 'query' parameter found in path "${pathname}". Skipping AI processing.`);
            }
        } catch (e) {
            console.error("[API Handler] Error during query formatting pre-processing:", e.message);
            // 即使预处理失败，也应继续尝试使用原始路径访问 TMDB
            coreTitleFromAI = queryParamValue; // 保证出错时使用原始 query (如果存在)
            currentPath = originalFullPath; // 保证出错时使用原始路径
        }
    }

    // --- 缓存逻辑 (使用最终确定的 currentPath) ---
    const cacheKey = currentPath;

    if (cache.has(cacheKey)) {
        const cachedItem = cache.get(cacheKey);
        if (Date.now() < cachedItem.expiry) {
            console.log('[Cache] Hit:', cacheKey);
            cache.delete(cacheKey);
            cache.set(cacheKey, cachedItem);
            return res.status(200).json(cachedItem.data);
        } else {
            cache.delete(cacheKey);
            console.log('[Cache] Expired and deleted:', cacheKey);
        }
    }

    // --- TMDB API 调用 ---
    const tmdbUrl = `${TMDB_BASE_URL}${currentPath}`;
    const config = {};
    if (authHeader) {
        config.headers = { 'Authorization': authHeader };
    }

    console.log('[TMDB Proxy] Fetching from TMDB:', tmdbUrl);
    try {
        const response = await axios.get(tmdbUrl, config);
        if (response.status === 200) {
            checkCacheSizeAndEvict();
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
        res.status(status).json({
            message: `Error fetching from upstream TMDB API: ${tmdbError.message}`,
            upstream_status: status,
            upstream_details: errorData,
            requested_url: tmdbUrl
        });
    }
}

// --- Main Export (无变化) ---
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    try {
        const fullPath = req.url;
        if (fullPath.startsWith('/t/p/original/')) {
            await handleImageRequest(req, res, fullPath);
        } else {
            await handleApiRequest(req, res, fullPath);
        }
    } catch (error) {
        console.error('[Main Export] General unhandled error:', error.message, error.stack);
        res.status(500).json({
            error: 'An unexpected general error occurred in the proxy.',
            details: error.message
        });
    }
};