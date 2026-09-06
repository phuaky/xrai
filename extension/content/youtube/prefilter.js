/* ytrai - high-precision instant decisions before local-model classification */
var YtraiPrefilter = (function () {
  'use strict';

  // High-precision music cues in the title. Tight on purpose: a false keep means a
  // distracting video shows, and anything missed here still goes to the AI model.
  // (bare "cover"/"live"/"soundtrack" excluded — they match phone covers / livestreams /
  // "soundtrack of my life" docs; feat./ft. require the period to avoid "feat of strength".)
  // No outer \b wrapper: many alternatives begin/end with non-word chars ("(lyrics)")
  // or end mid-word ("feat. F"), which a surrounding \b...\b would wrongly reject.
  // Bare-word alternatives carry their own \b anchors instead.
  var MUSIC_SIGNAL = /official\s+(music\s+)?video|official\s+audio|official\s+lyric(s)?(\s+video)?|lyric\s+video|with\s+lyrics|\(lyrics?\)|\(audio\)|\(visualizer\)|official\s+visualizer|music\s+video|full\s+album|full\s+ep|original\s+soundtrack|\bost\b|prod\.?\s+by|produced\s+by|\bremix\b|\bmashup\b|\bbootleg\b|\bnightcore\b|\bphonk\b|\bsynthwave\b|\bvaporwave\b|\blo-?fi\b|slowed\s*(\+|and)?\s*reverb|sped\s*up|\bbpm\b|\b(feat|ft)\.\s*[a-z]|beats?\s+to\s+(study|relax|sleep|chill|focus)|(study|sleep|focus|relaxing|chill|workout|gym)\s+(music|beats|playlist|mix)|\b(house|techno|trance|dubstep|edm|trap|drum\s*(&|and|n)\s*bass|dnb)\s+(mix|set|music)|\bunplugged\b|acoustic\s+(version|session)|live\s+(performance|session|in\s+concert|concert)/i;

  // Auto-generated artist channels ("Artist - Topic"), VEVO, and unambiguous music channels.
  // vevo anchored to end-of-name: real VEVO channels are "<Artist>VEVO" (no space, e.g.
  // "ColdplayVEVO"). A bare "vevo" match also fires on unrelated channels that happen to
  // have it in the name, like "Vevo Footnotes" (a behind-the-scenes doc channel, not music).
  var MUSIC_CHANNEL = /(\s-\s*topic\s*$|vevo\s*$|nocopyrightsounds|^ncs\b|lofi\s*girl|monstercat|trap\s*nation|chill\s*nation|mr\s*suicide\s*sheep|majestic\s*casual)/i;

  // Genuinely inspirational content. High-precision: prefilter keeps bypass the model,
  // so bare words (discipline / mindset / stoicism / "never give up") that collide with
  // ordinary vlogs/news/tutorials are dropped — those fall through to the AI instead.
  // "motivational" and "mental toughness" are deliberately NOT bare triggers here: both
  // collide with interviews/podcasts *about* the topic ("I Interviewed a Navy SEAL About
  // Mental Toughness") and meta/business coverage of it ("The Business of Motivational
  // Speaking") — the AI correctly sorts these as OTHER, the prefilter can't.
  var MOTIVATION_SIGNAL = /\b(study\s+motivation|gym\s+motivation|workout\s+motivation|self[\s-]?discipline|david\s+goggins|jocko\s+willink|les\s+brown|eric\s+thomas|jim\s+rohn)\b/i;

  // Formats that reliably promise a complete, deliberate piece rather than a
  // contextless clip. These are keeps because false blocking is the costly side.
  var USEFUL_FORMAT = /(^how\s+to\b|\b(explained|understanding|field\s+guide|postmortem|case\s+study|deep\s+dive|documentary|full\s+(match|journey|interview)|learn(?:ing)?\b|tutorial|review|study\s+with\s+me|pomodoro)\b)/i;
  var USEFUL_INTEREST = /\b(ai\s+agents?|artificial\s+intelligence|chatgpt|claude|deepseek|postgres|github|robotics?|startups?|espresso|coffee|barista|grinders?|whoop|running|marathon|ultramarathon|cycling|singapore|malaysia)\b/i;
  var USEFUL_CHANNEL = /\bfight\s+films\b/i;

  // Only patterns whose low-context intent is explicit enough to bypass the
  // model. Broad words such as "vlog", "sports", or "interview" stay model-owned.
  var DISTRACTION_SIGNAL = /^(no\s+way\b|this\s+was\s+a\s+bad\s+idea|i\s+couldn['’]t\s+say\s+no|i\s+promised\s+i['’]d\s+find\s+it|i\s+was\s+worried\s+for)|\b(reacting\s+to|try\s+not\s+to\s+laugh|official\s+trailer|gameplay|unboxing\s+every|morning\s+routine|fails?\s+compilation|subscribe\s+for\s+more|loses\s+it|\bdrama\b|no\s+playback|cocomelon|nursery\s+rhymes?)\b/i;

  function prefilter(data) {
    var title = (data.title || '').trim();
    var channel = (data.channel || '').trim();
    var hay = title + ' ' + channel;

    if (MUSIC_CHANNEL.test(channel)) {
      return { category: 'music', confidence: 0.95, reason: 'music-channel' };
    }
    if (MUSIC_SIGNAL.test(hay)) {
      return { category: 'music', confidence: 0.9, reason: 'music' };
    }
    if (MOTIVATION_SIGNAL.test(hay)) {
      return { category: 'motivational', confidence: 0.85, reason: 'motivational' };
    }
    if (DISTRACTION_SIGNAL.test(hay)) {
      return { category: 'distraction', confidence: 0.95, reason: 'clear-distraction' };
    }
    if (USEFUL_FORMAT.test(hay) || USEFUL_INTEREST.test(hay) || USEFUL_CHANNEL.test(channel)) {
      return { category: 'useful', confidence: 0.9, reason: 'useful-format-or-interest' };
    }
    return null; // not obviously keepable — let the AI decide
  }

  return { prefilter: prefilter };
})();
