#!/usr/bin/env node

// xrai Meta-Learning Script
// Analyzes user corrections and improves prefilter patterns + classification prompt
//
// Usage:
//   node scripts/improve.js corrections.json
//   cat corrections.json | node scripts/improve.js
//
// To export corrections from the extension:
//   1. Open chrome://extensions → xrai → Service Worker console
//   2. Run: chrome.storage.local.get('xrai_corrections', r => copy(JSON.stringify(r.xrai_corrections)))
//   3. Paste into corrections.json
//
// Or run with claude -p for automated improvement:
//   node scripts/improve.js corrections.json | claude -p "$(cat scripts/improve-prompt.md)"

const fs = require('fs');
const path = require('path');

const PREFILTER_PATH = path.join(__dirname, '..', 'extension', 'content', 'prefilter.js');
const OLLAMA_PATH = path.join(__dirname, '..', 'extension', 'lib', 'ollama.js');

async function main() {
  // Read corrections from file arg or stdin
  let correctionsJson;
  if (process.argv[2]) {
    correctionsJson = fs.readFileSync(process.argv[2], 'utf8');
  } else {
    correctionsJson = fs.readFileSync(0, 'utf8'); // stdin
  }

  let corrections;
  try {
    corrections = JSON.parse(correctionsJson);
  } catch (e) {
    console.error('Error: Invalid JSON input');
    process.exit(1);
  }

  if (!Array.isArray(corrections) || corrections.length === 0) {
    console.log('No corrections to analyze.');
    process.exit(0);
  }

  // Read current prefilter and prompt
  const prefilterCode = fs.readFileSync(PREFILTER_PATH, 'utf8');
  const ollamaCode = fs.readFileSync(OLLAMA_PATH, 'utf8');

  // Extract current CLASSIFY_SYSTEM prompt
  const promptMatch = ollamaCode.match(/var CLASSIFY_SYSTEM = '([\s\S]*?)';/);
  const currentPrompt = promptMatch ? promptMatch[1].replace(/\\n/g, '\n').replace(/\\'/g, "'") : 'NOT FOUND';

  // Analyze corrections
  const falseSignals = corrections.filter(c => c.aiPrediction === 'signal' && c.userCorrection === 'noise');
  const falseNoise = corrections.filter(c => c.aiPrediction === 'noise' && c.userCorrection === 'signal');

  console.log('═══════════════════════════════════════════');
  console.log('  xrai Meta-Learning Analysis');
  console.log('═══════════════════════════════════════════');
  console.log(`  Total corrections: ${corrections.length}`);
  console.log(`  False signals (noise leaked through): ${falseSignals.length}`);
  console.log(`  False noise (signal wrongly hidden): ${falseNoise.length}`);
  console.log('');

  // Pattern analysis for false signals (things that should be caught)
  if (falseSignals.length > 0) {
    console.log('  FALSE SIGNALS — Noise that leaked through:');
    console.log('  ──────────────────────────────────────────');
    falseSignals.forEach(c => {
      const text = c.text.substring(0, 80);
      const media = c.mediaType !== 'text' ? ` [${c.mediaType}]` : '';
      console.log(`    "${text}..."${media}`);
    });
    console.log('');

    // Look for common patterns in false signals
    const patterns = analyzePatterns(falseSignals.map(c => c.text));
    if (patterns.length > 0) {
      console.log('  DETECTED PATTERNS in false signals:');
      patterns.forEach(p => console.log(`    → ${p}`));
      console.log('');
    }
  }

  if (falseNoise.length > 0) {
    console.log('  FALSE NOISE — Signal wrongly hidden:');
    console.log('  ────────────────────────────────────');
    falseNoise.forEach(c => {
      const text = c.text.substring(0, 80);
      const media = c.mediaType !== 'text' ? ` [${c.mediaType}]` : '';
      console.log(`    "${text}..."${media}`);
    });
    console.log('');
  }

  // Generate the improvement prompt for Claude
  const improvementPrompt = generateImprovementPrompt(corrections, currentPrompt, prefilterCode);

  // Write the prompt to a file for piping to claude -p
  const promptPath = path.join(__dirname, 'improve-prompt.md');
  fs.writeFileSync(promptPath, improvementPrompt);

  console.log('  NEXT STEPS:');
  console.log('  ───────────');
  console.log('  Run this to get AI-generated improvements:');
  console.log('');
  console.log(`    claude -p "$(cat ${promptPath})" < ${process.argv[2] || 'corrections.json'}`);
  console.log('');
  console.log('  Or review the prompt at:');
  console.log(`    ${promptPath}`);
  console.log('');
}

function analyzePatterns(texts) {
  const patterns = [];

  // Check for short texts
  const shortTexts = texts.filter(t => t.length < 40);
  if (shortTexts.length > texts.length * 0.3) {
    patterns.push(`${shortTexts.length}/${texts.length} are short (<40 chars) — consider tightening short-text filter`);
  }

  // Check for question marks (vague questions)
  const questions = texts.filter(t => t.includes('?'));
  if (questions.length > texts.length * 0.2) {
    patterns.push(`${questions.length}/${texts.length} are questions — vague questions often leak through`);
  }

  // Check for motivational/philosophical language
  const motivational = texts.filter(t =>
    /\b(life|success|believe|theory|journey|mindset|growth|level|think about)\b/i.test(t)
  );
  if (motivational.length > texts.length * 0.2) {
    patterns.push(`${motivational.length}/${texts.length} contain motivational language`);
  }

  // Check for one-liners from big accounts (no substance)
  const oneLiner = texts.filter(t => t.length < 60 && !t.includes('\n'));
  if (oneLiner.length > texts.length * 0.3) {
    patterns.push(`${oneLiner.length}/${texts.length} are one-liners — consider penalizing ultra-short opinions`);
  }

  return patterns;
}

function generateImprovementPrompt(corrections, currentPrompt, prefilterCode) {
  const falseSignals = corrections.filter(c => c.aiPrediction === 'signal' && c.userCorrection === 'noise');
  const falseNoise = corrections.filter(c => c.aiPrediction === 'noise' && c.userCorrection === 'signal');

  return `# xrai Filter Improvement Task

You are improving a tweet classification system. Analyze the user corrections below and suggest specific improvements to the prefilter regex patterns and the LLM classification prompt.

## Current Classification Prompt
\`\`\`
${currentPrompt}
\`\`\`

## Current Prefilter Code
\`\`\`javascript
${prefilterCode}
\`\`\`

## User Corrections (${corrections.length} total)

### False Signals — These were classified as SIGNAL but user marked NOISE (${falseSignals.length}):
${falseSignals.map(c => `- "${c.text.substring(0, 200)}" [${c.mediaType}]`).join('\n')}

### False Noise — These were classified as NOISE but user marked SIGNAL (${falseNoise.length}):
${falseNoise.map(c => `- "${c.text.substring(0, 200)}" [${c.mediaType}]`).join('\n')}

## Your Task

1. **Analyze patterns** in the misclassifications. What types of content are being mis-classified?

2. **Suggest prefilter improvements**: New regex patterns that would catch false signals WITHOUT requiring an LLM call. Be specific — provide the exact regex.

3. **Suggest prompt improvements**: Changes to the classification prompt that would help the 1.5-3B model distinguish these edge cases better.

4. **Output format**: Provide your suggestions as:

\`\`\`json
{
  "prefilter_additions": [
    {"pattern": "regex here", "category": "category name", "confidence": 0.85, "reason": "why this catches noise"}
  ],
  "prompt_changes": [
    {"type": "add_negative_example", "text": "example of what is NOT signal"},
    {"type": "add_rule", "text": "new rule to add to prompt"}
  ],
  "analysis": "brief summary of what you found"
}
\`\`\`

Be conservative — only suggest patterns with very low false positive risk. It's better to miss some noise than to accidentally hide signal.
`;
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
