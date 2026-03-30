/* xrai — Pre-filter (regex-based instant noise detection) */
var XraiPrefilter = (function () {
  'use strict';

  // === SIGNAL SAFELIST — never filter these ===
  // Tech/AI keywords that indicate the tweet is likely worth reading
  var TECH_SIGNAL = /\b(ai|llm|gpt|claude|openai|anthropic|gemini|ollama|model|transformer|token|inference|fine\s*tun|embed|vector|rag|agent|mcp|sdk|api|deploy|ship|launch|release|v\d|open\s*source|github|repo|commit|merge|pr\b|pull\s*request|code|coding|vibe\s*cod|dev|engineer|architect|startup|saas|arr|mrr|revenue|valuation|funding|seed|series\s*[a-d]|yc|product|ux|ui|figma|react|next\.?js|vue|svelte|node|python|rust|typescript|swift|docker|kubernetes|k8s|aws|gcp|azure|cloudflare|vercel|supabase|postgres|redis|mongo|sql|database|benchmark|latency|throughput|gpu|cuda|metal|chip|silicon|diffusion|sora|runway|midjourney|flux|dall-e|stable\s*diffusion|video\s*gen|image\s*gen|text\s*to|speech|tts|stt|whisper|deepseek|qwen|gemma|llama|phi|mistral|grounding|retrieval|prompt|chain\s*of\s*thought|context\s*window|robot|autonom|self\s*driv|neural|machine\s*learn|deep\s*learn|reinforcement|crypto|bitcoin|ethereum|blockchain|web3|defi|nft|cursor|copilot|windsurf|karpathy|seedance|suno|kling|pika|luma|hailuo|minimax|comfyui|langchain|langgraph|crewai|autogen|n8n|make\.com|zapier|firecrawl|openclaw|clawdbot|state\s*machine)\b/i;

  // Entrepreneurship/business signal
  var BIZ_SIGNAL = /\b(founder|ceo|cto|coo|co-?found|bootstrap|profit|customer|churn|retention|conversion|growth|scale|pivot|acquisition|ipo|exit|cap\s*table|equity|vest|burn\s*rate|runway|market\s*fit|pmf|b2b|b2c|outbound|inbound|cold\s*email|sales|pipeline|onboard|pricing|freemium|enterprise)\b/i;

  // === NOISE PATTERNS ===
  var NSFW = /\b(onlyfans|thirst\s*trap|horny|nude[s]?|nudes|nsfw|xxx|porn|sexy|topless|lingerie|18\+|barely\s*legal|slutty|booty|thicc|come\s*see\s*me|link\s*in\s*bio.*\b(spicy|exclusive|content))\b/i;

  var ENGAGEMENT_BAIT = /\b(follow\s*(for|4)\s*follow|f4f|ratio\s+this|retweet\s*if|like\s*if\s*you|rt\s*if|drop\s*your|comment\s*your|tag\s*(a\s*friend|someone)|who\s*(else|agrees)|unpopular\s*opinion.*:?\s*$|what'?s\s*your\s*excuse|bet\s*you\s*can'?t|only\s*\d+%\s*(of\s*people|can|will)|this\s*is\s*a\s*test)\b/i;

  var ENGAGEMENT_SUFFIX = /\b(who\s*agrees\??|thoughts\??|am\s*i\s*wrong\??|change\s*my\s*mind|let\s*that\s*sink\s*in|read\s*that\s*again|iykyk|no\s*cap)\s*[.!?]*$/i;

  var SPAM = /\b(free\s*money|giveaway|passive\s*income|make\s*\$?\d+[k]?\s*(a\s*day|daily|per\s*month|in\s*my\s*first)|get\s*rich|dm\s*me\s*for|crypto\s*gem|100x\s*potential|guaranteed\s*returns|airdrop|drop\s*wallet|whitelist\s*spot|one\s*simple\s*trick|one\s*weird\s*trick|this\s*one\s*trick|side\s*hustle|financial\s*freedom)\b/i;

  // Crypto pump/scam patterns — separate from general spam
  var CRYPTO_PUMP = /(\d{2,}x\b|\d{1,3},?\d{3}%\s*gain|private\s*(tg|telegram)\s*(channel|group)|the\s*ticker\s*is|next\s*100x|buy\s*before|pump\s*(it|this)|rug\s*pull|moon\s*soon|degen\s*play|\$[A-Z]{2,8}\s*(at|before|from)\s*\$)/i;

  var CLICKBAIT_PHRASES = /\b(you\s*won'?t\s*believe|wait\s*(for|till)\s*(it|the\s*end)|this\s*is\s*so\s*(good|crazy|funny|wild|insane)|my\s*(grandma|mom|dad|kid)\s*(taught|showed|told)|i\s*can'?t\s*(believe|stop)|no\s*way|bro\s*what|absolute\s*madness|i'?m\s*dead|crying|screaming|watch\s*till\s*(the\s*)?end|what\s*happens\s*next\s*will\s*(shock|surprise|blow)|mind\s*blow|most\s*chaotic|100\s*\/\s*10|10\s*\/\s*10|\d+\/10\s*🍿|will\s*shock\s*you|stay\s*till\s*(the\s*)?end|this\s*will\s*(change|blow|shock|break)|you\s*need\s*to\s*see\s*this|i\s*wasn'?t\s*ready|nobody\s*expected|didn'?t\s*see\s*(this|that)\s*coming)\b/i;

  // Entertainment/lifestyle noise — not tech related
  var ENTERTAINMENT_NOISE = /\b(anime|manga|naruto|madara|one\s*piece|goku|jujutsu|demon\s*slayer|cosplay|marvel|dc\s*comics|avenger|harry\s*potter|hogwarts|snape|game\s*of\s*thrones|nba|nfl|fifa|premier\s*league|messi|ronaldo|lebron|recipe|cooking|baking|workout|gym|fitness|weight\s*loss|diet|skincare|makeup|fashion|outfit|ootd|haul|unbox|prank|challenge|mukbang|asmr|zodiac|horoscope|astrology|celebrity|gossip|drama|tea\b(?!\s*party)|stan|fandom|ship\b(?!\s*ped)|couple\s*goals)\b/i;

  function prefilter(data) {
    var text = (data.text || '').trim();
    var hasMedia = data.hasMedia || data.hasVideo || data.hasImage || data.hasGif;

    // === SAFELIST CHECK FIRST ===
    // If text contains tech/AI/biz keywords, NEVER prefilter — let AI decide
    if (TECH_SIGNAL.test(text) || BIZ_SIGNAL.test(text)) {
      return null; // pass to AI
    }

    // Empty text with media = likely engagement bait
    if (!text && hasMedia) {
      return { prediction: 'noise', confidence: 0.85, reason: 'media-only, no text', source: 'prefilter' };
    }

    // Ultra-short text without media = usually nothing useful
    if (text.length < 15 && !hasMedia) {
      return { prediction: 'noise', confidence: 0.80, reason: 'ultra-short text', source: 'prefilter' };
    }

    // NSFW
    if (NSFW.test(text)) {
      return { prediction: 'noise', confidence: 0.95, reason: 'nsfw', source: 'prefilter' };
    }

    // Engagement bait
    if (ENGAGEMENT_BAIT.test(text)) {
      return { prediction: 'noise', confidence: 0.9, reason: 'engagement-bait', source: 'prefilter' };
    }

    // Engagement suffixes
    if (ENGAGEMENT_SUFFIX.test(text)) {
      return { prediction: 'noise', confidence: 0.85, reason: 'engagement-suffix', source: 'prefilter' };
    }

    // Spam
    if (SPAM.test(text)) {
      return { prediction: 'noise', confidence: 0.9, reason: 'spam', source: 'prefilter' };
    }

    // Crypto pump/scam
    if (CRYPTO_PUMP.test(text)) {
      return { prediction: 'noise', confidence: 0.9, reason: 'crypto-pump', source: 'prefilter' };
    }

    // Clickbait phrases — no length restriction, clickbait is clickbait
    if (CLICKBAIT_PHRASES.test(text)) {
      return { prediction: 'noise', confidence: 0.85, reason: 'clickbait-phrase', source: 'prefilter' };
    }

    // Entertainment/lifestyle content — not relevant to tech
    if (ENTERTAINMENT_NOISE.test(text)) {
      return { prediction: 'noise', confidence: 0.80, reason: 'entertainment', source: 'prefilter' };
    }

    // VIDEO + SHORT VAGUE TEXT (< 80 chars) without tech keywords = entertainment bait
    // Tech keywords already caught by safelist above, so anything here is non-tech
    if (data.hasVideo && text.length < 80) {
      return { prediction: 'noise', confidence: 0.80, reason: 'short-video-non-tech', source: 'prefilter' };
    }

    // IMAGE + SHORT VAGUE TEXT (< 40 chars) without tech keywords
    if (data.hasImage && text.length < 40) {
      return { prediction: 'noise', confidence: 0.75, reason: 'short-image-non-tech', source: 'prefilter' };
    }

    // Not caught — pass to AI
    return null;
  }

  return { prefilter: prefilter };
})();
