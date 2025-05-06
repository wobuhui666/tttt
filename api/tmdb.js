const axios = require('axios');
const TMDB_BASE_URL = 'https://api.themoviedb.org';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

// --- Configuration ---
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION_MS, 10) || 10 * 60 * 1000;
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE, 10) || 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 更新模型名称为 gemini-1.5-flash-latest
const GEMINI_MODEL_NAME = 'gemini-2.0-flash'; // 或者您指定的其他 Flash 模型
const GEMINI_API_ENDPOINT gemini-2.0-flash= `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

const GEMINI_FORMATTING_PATHS = [
    '/3/search/movie',
    '/3/search/tv',
    '/3/search/multi',
];

// --- Cache Implementation (remains the same) ---
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
            console.log(`Cleaned ${deleteCount} oldest/LRU cache entries`);
        }
    }
}
setInterval(cleanExpiredCache, CACHE_DURATION);


// --- Google Gemini API Call Function (Prompt remains the same, model endpoint updated) ---
async function callGoogleGeminiAPI(textToFormat) {
    if (!GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY is not set. Skipping Gemini formatting.');
        return textToFormat;
    }
    if (!GEMINI_MODEL_NAME) {
        console.warn('GEMINI_MODEL_NAME is not set in config. Skipping Gemini formatting.');
        return textToFormat;
    }


    console.log(`[Gemini API - ${GEMINI_MODEL_NAME}] Requesting core title extraction for: "${textToFormat}"`);
    try {
        const requestBody = {
            contents: [{
                parts: [{
                    text: `请从以下影视搜索词中提取最核心的标题。务必移除所有与核心标题无关的附加信息，包括但不限于：
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

需要处理的文本是： "${textToFormat}"`
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
            console.error(`[Gemini API - ${GEMINI_MODEL_NAME}] Unexpected response structure or empty content:`, response.data.candidates ? response.data.candidates[0] : response.data);
            return textToFormat;
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[Gemini API - ${GEMINI_MODEL_NAME}] Error calling API:`, errorMessage);
        return textToFormat;
    }
}

// --- Request Handlers (handleImageRequest and handleApiRequest remain the same as previous version) ---
async function handleImageRequest(req, res, fullPath) {
    const imagePath = fullPath.replace('/t/p/original/', '');
    const tmdbImageUrl = `${TMDB_IMAGE_BASE_URL}/${imagePath}`;
    try {
        const response = await axios.get(tmdbImageUrl, { responseType: 'stream' });
        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        response.data.pipe(res);
    } catch (imageError) {
        console.error('Error fetching image:', tmdbImageUrl, imageError.message);
        const status = imageError.response?.status || 500;
        const message = imageError.response?.data?.status_message || 'Failed to fetch/stream image';
        res.status(status).json({ error: message });
    }
}


async function handleApiRequest(req, res, originalFullPath) {
    let currentPath = originalFullPath;
    const authHeader = req.headers.authorization;
    const parsedUrl = new URL(originalFullPath, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (GEMINI_FORMATTING_PATHS.includes(pathname)) {
        try {
            const urlObject = new URL(currentPath, 'http://localhost');
            const queryParamValue = urlObject.searchParams.get('query');

            if (queryParamValue) {
                const textToFormatForGemini = queryParamValue;
                console.log(`Original query for path "${pathname}" to be processed for core title by Gemini (${GEMINI_MODEL_NAME}): "${textToFormatForGemini}"`);

                const coreTitleFromGemini = await callGoogleGeminiAPI(textToFormatForGemini);

                if (coreTitleFromGemini && coreTitleFromGemini.trim() !== "" && coreTitleFromGemini !== queryParamValue) {
                    urlObject.searchParams.set('query', coreTitleFromGemini);
                    currentPath = urlObject.pathname + urlObject.search;
                    console.log(`Path for "${pathname}" modified by Gemini (${GEMINI_MODEL_NAME}) (core title) to: ${currentPath}`);
                } else if (coreTitleFromGemini === queryParamValue) {
                    console.log(`Gemini (${GEMINI_MODEL_NAME}) core title extraction resulted in no change for query: "${queryParamValue}"`);
                } else {
                    console.log(`Gemini (${GEMINI_MODEL_NAME}) core title extraction was skipped, returned an empty/error string, or did not meaningfully change the query for: "${queryParamValue}"`);
                }
            }
        } catch (e) {
            console.error("Error during query formatting pre-processing:", e.message);
        }
    }

    const cacheKey = currentPath;

    if (cache.has(cacheKey)) {
        const cachedItem = cache.get(cacheKey);
        if (Date.now() < cachedItem.expiry) {
            console.log('Cache hit:', cacheKey);
            cache.delete(cacheKey);
            cache.set(cacheKey, cachedItem);
            return res.status(200).json(cachedItem.data);
        } else {
            cache.delete(cacheKey);
            console.log('Cache expired and deleted:', cacheKey);
        }
    }

    const tmdbUrl = `${TMDB_BASE_URL}${currentPath}`;
    const config = {};
    if (authHeader) {
        config.headers = { 'Authorization': authHeader };
    }

    console.log('Fetching from TMDB:', tmdbUrl);
    try {
        const response = await axios.get(tmdbUrl, config);
        if (response.status === 200) {
            checkCacheSizeAndEvict();
            cache.set(cacheKey, {
                data: response.data,
                expiry: Date.now() + CACHE_DURATION
            });
            console.log('Cache miss and stored:', cacheKey);
        } else {
            console.log('Response not cached (non-200 status):', response.status, cacheKey);
        }
        res.status(response.status).json(response.data);
    } catch (tmdbError) {
        console.error('Error fetching from TMDB:', tmdbError.response ? JSON.stringify(tmdbError.response.data) : tmdbError.message);
        const status = tmdbError.response?.status || 500;
        const errorData = tmdbError.response?.data || { error: 'Failed to fetch data from TMDB.' };
        res.status(status).json({
            message: tmdbError.message,
            details: errorData
        });
    }
}

// --- Main Export (remains the same) ---
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
        console.error('General unhandled error in main export:', error.message, error.stack);
        res.status(500).json({
            error: 'An unexpected general error occurred in the proxy.',
            details: error.message
        });
    }
};
