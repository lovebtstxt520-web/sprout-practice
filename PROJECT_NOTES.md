# Sprout (rehearsal build, NOT for submission)
Stack: static index.html + Cloudflare Pages Function functions/api/plant.js (Gemini). Env: GEMINI_API_KEY (secret), optional GEMINI_MODEL, GEMINI_FALLBACK_MODEL.
API: POST /api/plant {image(base64 jpeg), prevImage?, mode single|batch, name?, location indoor|balcony, lang en|zh|th, daysSinceWatered?} -> {species,confidence,stage,count,health,issues[],advice[],waterEveryDays,petSafety,petNote,lowLight,change,changeNote}
Storage: localStorage pl_plants (max ~5 photos each), pl_lang, pl_theme.
Event day: rebuild from a blank project. Do not deploy this one.
