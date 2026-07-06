/* xrai — Workflow-tip detection (regex, deterministic)
 *
 * Flags SHOWN tweets that look like actionable workflow tips — tool usage
 * patterns, setups, releases worth evaluating — so main.js can capture them
 * into the tips ledger (collector /tips → data/tips.jsonl → scripts/tips.js).
 *
 * Deliberately HIGH RECALL, low precision: this only runs on tweets the
 * pipeline already decided to SHOW, so the classifier is the precision layer
 * (funnel bait that wears tip clothing gets hidden before capture). The
 * ledger's evaluate/mark step is where usefulness is judged, not here.
 */
var XraiTips = (function () {
  'use strict';

  // A tip must name a concrete tool/tech in the working stack...
  var TIP_TOOL = /\b(claude\s*code|claude|codex|cursor|copilot|windsurf|mcp|ollama|gpt-?[45o]?|gemini|llm[s]?|agent(s|ic)?|subagent[s]?|lang(chain|graph)|crewai|autogen|n8n|zapier|comfyui|deepseek|qwen|llama|mistral|openai|anthropic|prompt[s]?|context\s*window|system\s*prompt|CLAUDE\.md|hook[s]?|skill[s]?|worktree[s]?|api[s]?|sdk|cli|terminal|vs\s*code|neovim|figma|repo|git|github|docker|whisper|harness|eval[s]?|benchmark[s]?)\b/i;

  // ...AND describe a practice you could copy (how-to, setup, first-person
  // method, release-to-evaluate).
  var TIP_PRACTICE = /\b(how\s+(i|to|we)\b|my\s+(setup|workflow|stack|system|process|approach|trick)|here'?s\s+(how|my|the\s+(workflow|setup|trick|pattern))|pro\s*tip|tip[s]?\s*:|trick\s+(is|i)|instead\s+of|try\s+(this|it|starting)|start\s+(with|by)|use\s+(it|this|them)\s+to|i(['’])?ve\s+been\s+(using|running|doing|digging)|something\s+new\s+i(['’])?m\s+trying|what\s+i\s+do\s+is|step[\s-]*by[\s-]*step|guide|playbook|workflow|automat(e|ed|ion)|set\s*up|underrated\s+(way|use|feature)|game\s*changer\s+for|works\s+(great|well)\s+for|you\s+can\s+(now\s+)?(use|run|pipe|connect)|let[s]?\s+you\b|turns?\s+out\s+you\s+can|share\s+(my|the)\b|my\s+\d+\s+(key\s+)?\w+|i\s+(built|wrote|made|shipped|wired|automated|fact-checked|transcribed)|open[\s-]?sourc(e|ed|ing)|we\s+(just\s+)?(open[\s-]?sourced|shipped|released|launched)|full\s+method)\b/i;

  // One-liners don't carry enough method to be worth ledger space.
  var MIN_LENGTH = 60;

  function isTip(text) {
    var t = (text || '').trim();
    if (t.length < MIN_LENGTH) return false;
    return TIP_TOOL.test(t) && TIP_PRACTICE.test(t);
  }

  return { isTip: isTip };
})();
