/* ytrai — Pre-filter (regex-based instant KEEP for obvious music / motivational) */
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
  var MUSIC_CHANNEL = /(\s-\s*topic\s*$|vevo|nocopyrightsounds|^ncs\b|lofi\s*girl|monstercat|trap\s*nation|chill\s*nation|mr\s*suicide\s*sheep|majestic\s*casual)/i;

  // Genuinely inspirational content. High-precision: prefilter keeps bypass the model,
  // so bare words (discipline / mindset / stoicism / "never give up") that collide with
  // ordinary vlogs/news/tutorials are dropped — those fall through to the AI instead.
  var MOTIVATION_SIGNAL = /\b(motivational|study\s+motivation|gym\s+motivation|workout\s+motivation|self[\s-]?discipline|mental\s+toughness|david\s+goggins|jocko\s+willink|les\s+brown|eric\s+thomas|jim\s+rohn)\b/i;

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
    return null; // not obviously keepable — let the AI decide
  }

  return { prefilter: prefilter };
})();
