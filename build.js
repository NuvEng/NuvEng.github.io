'use strict';
// Generates the static files a Stremio/Nuvio catalog addon needs:
//   public/manifest.json
//   public/catalog/<type>/<id>.json   (+ /skip=0.json variant)
//
// Each AnimeSchedule dub entry is resolved to a Kitsu ID, then mapped to a
// real TMDB / IMDb ID via Fribb's anime-lists. Emitting TMDB IDs natively
// resolves in Stremio + Nuvio without requiring Cinemeta.
//
// DEBUG BUILD: temporarily logs the raw "Kobayashi" entry (if present) so we
// can see exactly what episodeDate/title fields AnimeSchedule's API returns
// for it. Remove this block once diagnosed.

const fs = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const AS_TOKEN = process.env.ANIMESCHEDULE_TOKEN;  // GitHub Actions secret
const RPDB_KEY = process.env.RPDB_KEY || '';       // optional secret
const USE_RPDB = process.env.USE_RPDB === 'true';  // opt-in
const POSTER_TEMPLATE = 'https://btttr.cc/poster/imdb/poster-default/{imdb_id}.jpg?tag=none';
// Optional poster URL pattern (e.g. BetterPosters / btttr.cc "poster-only" URL).
// Placeholders: {imdb_id} {tmdb_id} {type} (movie|series) {tmdb_type} (movie|tv)
const POSTER_PATTERN = process.env.POSTER_URL_PATTERN || '';

// Labeled posters ("S1 · E12 DUBBED") are rendered in CI and served from Pages.
// Set LABEL_POSTERS=false in the workflow env to turn this off.
const LABEL_POSTERS = process.env.LABEL_POSTERS !== 'false';
const PAGES_BASE_URL = (process.env.PAGES_BASE_URL ||
  (process.env.GITHUB_REPOSITORY
    ? (() => {
        const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
        return repo.toLowerCase() === `${owner.toLowerCase()}.github.io`
          ? `https://${owner.toLowerCase()}.github.io`
          : `https://${owner.toLowerCase()}.github.io/${repo}`;
      })()
    : '')).replace(/\/+$/, '');
const TMDB_KEY = process.env.TMDB_API_KEY || '';   // optional secret (v3 key or v4 read token)
const MDBLIST_KEY = process.env.MDBLIST_API_KEY || ''; // optional secret

const AS_BASE         = 'https://animeschedule.net/api/v3';
const AS_DUB_ENDPOINT = `${AS_BASE}/timetables/dub`;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const MDBLIST_BASE = 'https://api.mdblist.com';
const FRIBB_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';

const ITEM_TYPE  = 'series';
const CATALOG_ID = 'as-dub-recent';
const OUT_DIR    = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------
const manifest = {
  id: 'community.animeschedule.dub',
  version: '0.8.2',
  name: 'AnimeSchedule Dubbed',
  description:
    'A "Recently Dubbed" anime row sourced from AnimeSchedule.net, mapped to ' +
    'TMDB/IMDb IDs so your client can pull full metadata and find streams.',
  logo: 'https://animeschedule.net/favicon.ico',
  resources: ['catalog'],
  types: [ITEM_TYPE],
  idPrefixes: ['tmdb:', 'tt'],
  catalogs: [{ type: ITEM_TYPE, id: CATALOG_ID, name: 'Recently Dubbed', extra: [] }],
  behaviorHints: { configurable: true, configurationRequired: false }
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const kitsuCache = new Map();
let fribbByKitsu = null;

// ISO-8601 week number + week-year for a date.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7) };
}

// The timetable endpoint only returns one week, so fetch this week AND last
// week; otherwise the row empties out every Monday. Last week is best-effort.
async function fetchDubTimetable() {
  const headers = { Authorization: `Bearer ${AS_TOKEN}` };
  const res = await fetch(AS_DUB_ENDPOINT, { headers });
  if (!res.ok) throw new Error(`AnimeSchedule responded ${res.status} ${res.statusText}`);
  const current = await res.json();

  let previous = [];
  try {
    const { year, week } = isoWeek(new Date(Date.now() - 7 * 86400000));
    const prev = await fetch(`${AS_DUB_ENDPOINT}?year=${year}&week=${week}`, { headers });
    if (prev.ok) previous = await prev.json();
    else console.log(`Previous week (${year}-W${week}) responded ${prev.status} — using this week only.`);
  } catch (e) {
    console.log('Previous week fetch failed — using this week only.');
  }
  const cur  = Array.isArray(current)  ? current  : [];
  const prv  = Array.isArray(previous) ? previous : [];
  console.log(`Timetable: ${cur.length} this week + ${prv.length} last week.`);
  return cur.concat(prv);
}

async function loadFribbMapping() {
  if (fribbByKitsu) return fribbByKitsu;
  const res = await fetch(FRIBB_URL);
  if (!res.ok) throw new Error(`Fribb mapping responded ${res.status}`);
  const arr = await res.json();
  fribbByKitsu = new Map();
  for (const e of arr) {
    if (e && e.kitsu_id != null) fribbByKitsu.set(Number(e.kitsu_id), e);
  }
  console.log(`Loaded Fribb mapping: ${fribbByKitsu.size} kitsu-keyed entries.`);
  return fribbByKitsu;
}

// ---- English-dub filter ----------------------------------------------------
// The dub timetable has no language field, so drop anything that names a
// non-English dub in its titles or URL slug, e.g. "(Hindi Dub)",
// "Spanish dub", "[Latin American]", "naruto-hindi-dub".
const NON_ENGLISH_LANGS = [
  'hindi', 'tamil', 'telugu', 'malayalam', 'kannada', 'bengali', 'marathi',
  'spanish', 'castilian', 'latin american', 'latino', 'latam', 'portuguese', 'brazilian',
  'french', 'german', 'italian', 'arabic', 'russian', 'ukrainian', 'polish', 'turkish',
  'indonesian', 'malay', 'thai', 'vietnamese', 'tagalog', 'filipino', 'korean',
  'mandarin', 'cantonese', 'chinese dub', 'japanese dub', 'dutch', 'swedish', 'norwegian',
  'danish', 'finnish', 'greek', 'hebrew', 'czech', 'hungarian', 'romanian'
];
const LANG_ALT = NON_ENGLISH_LANGS.map((l) => l.replace(/ /g, '[\\s-]')).join('|');
const NON_ENG_RE = new RegExp(
  `(?:\\b(?:${LANG_ALT})[\\s-]*(?:dub|dubbed|audio|version)\\b)|` +   // "Hindi Dub"
  `(?:[\\(\\[]\\s*(?:${LANG_ALT})\\s*[\\)\\]])`,                     // "(Hindi)"
  'i'
);

function isEnglishDub(entry) {
  if (entry.airType && String(entry.airType).toLowerCase() !== 'dub') return false;
  const hay = [entry.title, entry.english, entry.romaji, entry.route, entry.delayedText]
    .filter(Boolean).join(' | ');
  return !NON_ENG_RE.test(hay);
}

function pickTitle(entry) {
  return entry.english || entry.romaji || entry.title || entry.native || null;
}

function pickDate(entry) {
  const raw = entry.episodeDate || entry.airDate || entry.date || null;
  const t   = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// AnimeSchedule Timetable Anime: episodeNumber, plus subtractedEpisodeNumber
// when several episodes drop at once ("11-12").
function pickEpisode(entry) {
  const to   = Number(entry.episodeNumber);
  if (!Number.isFinite(to) || to <= 0) return null;
  const from = Number(entry.subtractedEpisodeNumber);
  return Number.isFinite(from) && from > 0 && from < to ? `${from}-${to}` : String(to);
}

// 'dubbed' | 'soon' | 'delayed' from airingStatus (aired/airing/unaired/delayed-air),
// falling back to the episode date.
function pickState(entry, now) {
  const a = String(entry.airingStatus || '').toLowerCase();
  if (a === 'delayed-air' || String(entry.status || '').toLowerCase() === 'delayed') return 'delayed';
  if (a === 'aired' || a === 'airing') return 'dubbed';
  if (a === 'unaired') return 'soon';
  return pickDate(entry) > now ? 'soon' : 'dubbed';
}

const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

// Season from the title ("2nd Season", "Season 3", "Third Season"), else Fribb.
function pickSeason(title, fribbEntry) {
  const t = String(title || '');
  let m = t.match(/(\d+)\s*(?:st|nd|rd|th)\s+season/i) || t.match(/\bseason\s*(\d+)/i);
  if (m) return Number(m[1]);
  m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season/i);
  if (m) return ORDINAL_WORDS[m[1].toLowerCase()];
  const fs_ = fribbEntry && fribbEntry.season;
  if (fs_ && Number(fs_.tmdb) > 0) return Number(fs_.tmdb);
  if (fs_ && Number(fs_.tvdb) > 0) return Number(fs_.tvdb);
  return null;
}

function episodeLabel(season, episode) {
  if (!episode) return null;
  return season ? `S${season} · E${episode}` : `Ep ${episode}`;
}

async function resolveKitsuId(title) {
  if (!title) return null;
  if (kitsuCache.has(title)) return kitsuCache.get(title);
  try {
    const url =
      'https://kitsu.io/api/edge/anime?page[limit]=1&filter[text]=' +
      encodeURIComponent(title);
    const res  = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
    const json = await res.json();
    const item = json && json.data && json.data[0];
    const result = item
      ? { id: item.id, posterImage: (item.attributes && item.attributes.posterImage) || null }
      : null;
    kitsuCache.set(title, result);
    return result;
  } catch (e) {
    kitsuCache.set(title, null);
    return null;
  }
}

// Kitsu numeric id → 'tmdb:<id>' or 'tt...' via Fribb.
function mapKitsuToId(kitsuId) {
  const e = fribbByKitsu.get(Number(kitsuId));
  if (!e) return null;
  const tmdb = e.themoviedb_id || {};
  if (tmdb.tv != null && tmdb.tv !== '')       return { id: `tmdb:${tmdb.tv}`, tmdbType: 'tv', fribb: e };
  if (typeof e.imdb_id === 'string' && e.imdb_id.startsWith('tt')) return { id: e.imdb_id, tmdbType: null, fribb: e };
  if (tmdb.movie != null && tmdb.movie !== '') return { id: `tmdb:${tmdb.movie}`, tmdbType: 'movie', fribb: e };
  return null;
}

function fromPattern(tt, tmdbId, tmdbType) {
  if (!POSTER_PATTERN) return undefined;
  const needsImdb = /\{imdb(_id)?\}/.test(POSTER_PATTERN);
  const needsTmdb = /\{tmdb(_id)?\}/.test(POSTER_PATTERN);
  if ((needsImdb && !tt) || (needsTmdb && !tmdbId)) return undefined;
  const kind = tmdbType === 'movie' ? 'movie' : 'series';
  return POSTER_PATTERN
    .replace(/\{imdb(_id)?\}/g, tt || '')
    .replace(/\{tmdb(_id)?\}/g, tmdbId || '')
    .replace(/\{tmdb_type\}/g, tmdbType === 'movie' ? 'movie' : 'tv')
    .replace(/\{type\}/g, kind);
}

function posterFor(finalId, kitsuPosterImage, imdbId, tmdbPoster, tmdbId, tmdbType) {
  const id = typeof finalId === 'string' ? finalId : String(finalId || '');
  const tt = id.startsWith('tt') ? id : imdbId;

  const custom = fromPattern(tt, tmdbId, tmdbType);
  if (custom) return custom;

  // btttr.cc rating posters for anything with an IMDb ID; TMDB poster otherwise.
  if (tt) return POSTER_TEMPLATE.replace('{imdb_id}', tt);
  if (tmdbPoster) return tmdbPoster;
  if (RPDB_KEY && USE_RPDB && tt) {
    return `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${tt}.jpg?fallback=true`;
  }
  if (kitsuPosterImage) {
    for (const size of ['medium', 'large', 'original', 'small']) {
      const u = kitsuPosterImage[size];
      if (
        typeof u === 'string' &&
        u.startsWith('https://media.kitsu.app/') &&
        !u.includes('X-Amz-') &&
        !u.includes('?')
      ) return u;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// TMDB ENRICHMENT (optional — skipped if TMDB_API_KEY is not set)
// ---------------------------------------------------------------------------
const tmdbCache = new Map();

async function tmdbGet(pathAndQuery) {
  if (!TMDB_KEY) return null;
  // v4 "API Read Access Token" is a long JWT (starts with eyJ); v3 key is 32 hex chars.
  const isBearer = TMDB_KEY.startsWith('eyJ');
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${TMDB_BASE}${pathAndQuery}${sep}language=en-US` +
              (isBearer ? '' : `&api_key=${TMDB_KEY}`);
  const headers = { Accept: 'application/json' };
  if (isBearer) headers.Authorization = `Bearer ${TMDB_KEY}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

// finalId is 'tmdb:<id>' or 'tt...'. tmdbType is 'tv' or 'movie' (hint from Fribb).
async function fetchTmdbDetails(finalId, tmdbType) {
  const key = `${finalId}|${tmdbType}`;
  if (tmdbCache.has(key)) return tmdbCache.get(key);

  let data = null;
  let kind = tmdbType || 'tv';

  if (finalId.startsWith('tmdb:')) {
    const id = finalId.slice(5);
    data = await tmdbGet(`/${kind}/${id}?append_to_response=external_ids`);
  } else if (finalId.startsWith('tt')) {
    const found = await tmdbGet(`/find/${finalId}?external_source=imdb_id`);
    const hit = found && ((found.tv_results && found.tv_results[0]) ||
                          (found.movie_results && found.movie_results[0]));
    if (hit) {
      kind = found.tv_results && found.tv_results[0] ? 'tv' : 'movie';
      data = await tmdbGet(`/${kind}/${hit.id}?append_to_response=external_ids`);
    }
  }

  tmdbCache.set(key, data);
  return data;
}

function tmdbToMetaFields(d) {
  if (!d) return {};
  const date  = d.first_air_date || d.release_date || '';
  const imdb  = (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null;
  const out = {
    description: d.overview || undefined,
    background:  d.backdrop_path ? `${TMDB_IMG}/original${d.backdrop_path}` : undefined,
    tmdbPoster:  d.poster_path   ? `${TMDB_IMG}/w500${d.poster_path}`       : undefined,
    releaseInfo: date ? date.slice(0, 4) : undefined,
    genres:      Array.isArray(d.genres) ? d.genres.map((g) => g.name) : undefined,
    imdbRating:  d.vote_average ? d.vote_average.toFixed(1) : undefined,
    imdbId:      typeof imdb === 'string' && imdb.startsWith('tt') ? imdb : undefined,
    tmdbId:      d.id != null ? String(d.id) : undefined
  };
  return out;
}

// ---------------------------------------------------------------------------
// MDBLIST RATINGS (optional — skipped if MDBLIST_API_KEY is not set)
// Free tier allows ~1000 requests/day; one request per title per run.
// ---------------------------------------------------------------------------
const RATING_LABELS = {
  imdb: 'IMDb', mal: 'MAL', tomatoes: 'RT', metacritic: 'MC',
  trakt: 'Trakt', letterboxd: 'LB', tmdb: 'TMDB'
};
let mdblistDisabled = false;

async function fetchMdblist(imdbId, tmdbId, tmdbType) {
  if (!MDBLIST_KEY || mdblistDisabled) return null;
  const mediaType = tmdbType === 'movie' ? 'movie' : 'show';
  const url = imdbId
    ? `${MDBLIST_BASE}/imdb/${mediaType}/${imdbId}?apikey=${MDBLIST_KEY}`
    : tmdbId
      ? `${MDBLIST_BASE}/tmdb/${mediaType}/${tmdbId}?apikey=${MDBLIST_KEY}`
      : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      console.log(`MDBList responded ${res.status} — disabling MDBList for the rest of this run.`);
      mdblistDisabled = true;
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function mdblistToFields(m) {
  if (!m || !Array.isArray(m.ratings)) return {};
  const by = {};
  for (const r of m.ratings) {
    if (r && r.source && r.value != null && r.value !== 0) by[r.source] = r.value;
  }
  const parts = [];
  for (const src of ['imdb', 'mal', 'tomatoes', 'letterboxd']) {
    if (by[src] == null) continue;
    const v = src === 'tomatoes' ? `${by[src]}%` : by[src];
    parts.push(`${RATING_LABELS[src]} ${v}`);
  }
  return {
    imdbRating:  by.imdb != null ? String(by.imdb) : undefined,
    ratingsLine: parts.length ? `⭐ ${parts.join(' · ')}` : undefined,
    certification: m.certification || undefined
  };
}

// ---------------------------------------------------------------------------
// LABELED POSTERS — download each poster, draw an "S1 · E12 DUBBED" pill on it,
// save it under public/posters/, and point the catalog at that copy.
// Any failure falls back to the original poster URL.
// ---------------------------------------------------------------------------
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* not installed → no labels */ }

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (type && !type.startsWith('image/')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Poster-tinted tag colour (like BetterPosters' own tags) ---------------
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

function relLum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
  const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Look at the whole poster: overall brightness, dominant hue (weighted by
// how colourful each pixel is) and how much of the poster is that hue in a
// strong, mid-tone form.
async function analyzePoster(buf) {
  const { data, info } = await sharp(buf).resize(40, 60, { fit: 'fill' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const N = data.length / info.channels, BUCKETS = 24;
  const w = new Array(BUCKETS).fill(0), hx = new Array(BUCKETS).fill(0),
        hy = new Array(BUCKETS).fill(0), ss = new Array(BUCKETS).fill(0),
        vivid = new Array(BUCKETS).fill(0);
  let sumL = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    sumL += l;
    if (l < 0.06 || l > 0.95) continue;
    const chroma = s * (1 - Math.abs(2 * l - 1));
    if (chroma < 0.06) continue;
    const b = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    w[b] += chroma; ss[b] += s * chroma;
    hx[b] += Math.cos(h * Math.PI / 180) * chroma; hy[b] += Math.sin(h * Math.PI / 180) * chroma;
    if (s > 0.45 && l > 0.3 && l < 0.72) vivid[b]++;
  }
  let best = -1, bestW = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const tot = w[b] + 0.5 * (w[(b + 1) % BUCKETS] + w[(b + BUCKETS - 1) % BUCKETS]);
    if (tot > bestW) { bestW = tot; best = b; }
  }
  if (best < 0) return { meanL: sumL / N, hue: 210, sat: 0.05, vividShare: 0 };
  let hue = Math.atan2(hy[best], hx[best]) * 180 / Math.PI; if (hue < 0) hue += 360;
  const near = [best, (best + 1) % BUCKETS, (best + BUCKETS - 1) % BUCKETS];
  return {
    meanL: sumL / N,
    hue,
    sat: ss[best] / w[best],
    vividShare: near.reduce((a, b) => a + vivid[b], 0) / N
  };
}

// BetterPosters-style adaptive tag, picked per poster:
//   strong single colour  → vivid tag, white text        (One Piece, Azur Lane)
//   bright poster         → pale tint, dark text         (Horimiya, Banana Fish)
//   dark but colourful    → mid-tone tint, white text    (Mushoku)
//   dark and muted        → deep tint, white text        (Bleach, Apothecary)
// Text colour is whichever of dark/white contrasts more with the tag.
function adaptiveTagStyle(a) {
  const { hue: h, sat: s, meanL, vividShare } = a;
  let fill;
  if (vividShare > 0.16)       fill = hslToHex(h, Math.min(0.78, Math.max(0.5, s)), 0.5);
  else if (meanL >= 0.42)      fill = hslToHex(h, Math.min(0.4, Math.max(0.1, s * 0.6)), 0.86);
  else if (s > 0.3)            fill = hslToHex(h, Math.min(0.45, s * 0.8), 0.31);
  else                         fill = hslToHex(h, Math.min(0.25, s), 0.19);

  const DARK = '#161616', LIGHT = '#FFFFFF';
  let ink = contrast(fill, LIGHT) >= contrast(fill, DARK) ? LIGHT : DARK;
  if (ink === LIGHT && contrast(fill, LIGHT) < 4.5) {
    const [fh, fs] = rgbToHsl(...[1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16)));
    for (let ll = 0.48; ll >= 0.25; ll -= 0.02) {
      fill = hslToHex(fh, fs, ll);
      if (contrast(fill, LIGHT) >= 4.5) break;
    }
  }
  return { fill, ink };
}

async function renderTabText(text, ink, alpha, fontPx) {
  const out = await sharp({
    text: {
      text: `<span foreground="${ink}" fgalpha="${alpha}">${escapeXml(text)}</span>`,
      font: `Liberation Sans, Arimo, Arial, DejaVu Sans Bold ${fontPx}`,
      rgba: true,
      dpi: 72
    }
  }).png().toBuffer({ resolveWithObject: true });
  return { img: out.data, w: out.info.width, h: out.info.height };
}

// Draws the label as a tab at the top centre in btttr.cc's tag shape (flush
// with the top edge, rounded bottom corners). Sizes come from btttr's
// 500x750 poster and are scaled to the actual image.
async function renderLabeledPoster(srcUrl, outFile, label, state) {
  const buf = await fetchImage(srcUrl);
  if (!buf) return false;
  const { width, height } = await sharp(buf).metadata();
  if (!width || !height) return false;

  const text  = `${label} ${state === 'soon' ? 'Soon' : state === 'delayed' ? 'Delayed' : 'Dubbed'}`;
  const k     = width / 500;
  const tabH  = Math.round(70 * k);
  const padX  = Math.round(36 * k);
  const r     = Math.round(10 * k);

  // Measure text, shrinking if it would be too wide.
  let fontPx = Math.round(42 * k), t;
  for (;;) {
    t = await renderTabText(text, '#000000', '100%', fontPx);
    if (t.w + padX * 2 <= width * 0.86 || fontPx <= 20 * k) break;
    fontPx -= 2;
  }
  const tabW = t.w + padX * 2;
  const x    = Math.round((width - tabW) / 2);

  const { fill, ink } = adaptiveTagStyle(await analyzePoster(buf));

  // Frosted tab: blurred poster patch with the tint laid over it, clipped to the tab shape.
  const shape = `M0 0 H${tabW} V${tabH - r} Q${tabW} ${tabH} ${tabW - r} ${tabH} H${r} Q0 ${tabH} 0 ${tabH - r} Z`;
  const tint  = Buffer.from(`<svg width="${tabW}" height="${tabH}" xmlns="http://www.w3.org/2000/svg">
    <path d="${shape}" fill="${fill}" fill-opacity="0.86"/></svg>`);
  const mask  = Buffer.from(`<svg width="${tabW}" height="${tabH}" xmlns="http://www.w3.org/2000/svg">
    <path d="${shape}" fill="#fff"/></svg>`);
  const tab = await sharp(buf)
    .extract({ left: x, top: 0, width: tabW, height: tabH })
    .blur(Math.max(1, 8 * k))
    .composite([{ input: tint }, { input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Soon / delayed get slightly softer text so new dubs stand out.
  const label_ = await renderTabText(text, ink, state === 'dubbed' ? '100%' : '72%', fontPx);

  await sharp(buf)
    .composite([
      { input: tab, top: 0, left: x },
      { input: label_.img, top: Math.max(0, Math.round((tabH - label_.h) / 2)), left: Math.round((width - label_.w) / 2) }
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outFile);
  return true;
}

async function labelPosters(metas) {
  if (!LABEL_POSTERS) { console.log('LABEL_POSTERS=false — skipping poster labels.'); return; }
  if (!sharp) { console.log('sharp not installed — skipping poster labels.'); return; }
  if (!PAGES_BASE_URL) { console.log('PAGES_BASE_URL unknown — skipping poster labels.'); return; }

  const dir = path.join(OUT_DIR, 'posters');
  await fs.mkdir(dir, { recursive: true });

  const jobs = metas.filter((m) => m.poster && m._label);
  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < jobs.length) {
      const m = jobs[i++];
      // Episode is in the filename so clients re-download when a new ep is dubbed.
      const slug = `${m.id.replace(/[^a-z0-9]+/gi, '-')}-` +
                   `${m._label.replace(/[^a-z0-9]+/gi, '').toLowerCase()}` +
                   `${m._state === 'dubbed' ? '' : '-' + m._state}.jpg`;
      try {
        const ok = await renderLabeledPoster(m.poster, path.join(dir, slug), m._label, m._state);
        if (ok) { m.poster = `${PAGES_BASE_URL}/posters/${slug}`; done++; } else failed++;
      } catch (e) {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`Labeled posters: ${done} rendered, ${failed} kept the original poster.`);
}

async function buildMetas() {
  const [timetable] = await Promise.all([fetchDubTimetable(), loadFribbMapping()]);

  const raw  = Array.isArray(timetable) ? timetable : [];
  console.log(`AnimeSchedule returned ${raw.length} raw entries.`);
  const list = raw.filter(isEnglishDub);
  const dropped = raw.filter((e) => !isEnglishDub(e));
  console.log(`English-dub filter: kept ${list.length}, dropped ${dropped.length}` +
    (dropped.length ? ` → ${dropped.map((e) => pickTitle(e) || e.route).join('; ')}` : '.'));
  if (raw[0] && raw[0].streams) {
    console.log('Sample streams (check for non-English sources):', JSON.stringify(raw[0].streams));
  }

  // --- DEBUG: dump the raw Kobayashi entry, if present -----------------
  const kobayashi = list.find(
    (e) => pickTitle(e) && pickTitle(e).toLowerCase().includes('kobayashi')
  );
  if (kobayashi) {
    console.log('--- KOBAYASHI ENTRY (raw, full) ---');
    console.log(JSON.stringify(kobayashi, null, 2));
    console.log('------------------------------------');
  } else {
    console.log('No entry with "kobayashi" in its title was found in this run.');
  }
  // -----------------------------------------------------------------------

  if (list[0]) {
    console.log('--- Sample entry (first in raw list) ---');
    console.log(JSON.stringify(list[0], null, 2));
    console.log('-----------------------------------------');
  }

  // Sort: already-aired episodes first (most recent at top), future episodes
  // at the end (soonest upcoming first).
  const now = Date.now();
  list.sort((a, b) => {
    const da = pickDate(a), db = pickDate(b);
    const aFuture = da > now, bFuture = db > now;
    if (aFuture && !bFuture) return 1;
    if (!aFuture && bFuture) return -1;
    if (!aFuture && !bFuture) return db - da;
    return da - db;
  });

  const seen  = new Set();
  const metas = [];
  let skipped = 0;
  let enriched = 0;
  let rated = 0;
  let labeled = 0;
  console.log(POSTER_PATTERN ? 'Using custom POSTER_URL_PATTERN for posters.' : 'No POSTER_URL_PATTERN — using TMDB posters.');
  if (!MDBLIST_KEY) console.log('MDBLIST_API_KEY not set — skipping MDBList ratings.');
  if (!TMDB_KEY) console.log('TMDB_API_KEY not set — skipping TMDB enrichment.');

  for (const entry of list) {
    const title = pickTitle(entry);
    const k     = await resolveKitsuId(title);
    if (!k) { skipped++; continue; }

    const mapped = mapKitsuToId(k.id);
    if (!mapped || !mapped.id) { skipped++; continue; }
    const finalId = mapped.id;

    if (seen.has(finalId)) continue;
    seen.add(finalId);

    const t = tmdbToMetaFields(await fetchTmdbDetails(finalId, mapped.tmdbType));
    if (t.description) enriched++;

    const imdbId = finalId.startsWith('tt') ? finalId : t.imdbId;
    const tmdbId = finalId.startsWith('tmdb:') ? finalId.slice(5) : null;
    const md = mdblistToFields(await fetchMdblist(imdbId, tmdbId, mapped.tmdbType));
    if (md.ratingsLine) rated++;

    const label    = episodeLabel(pickSeason(title, mapped.fribb), pickEpisode(entry));
    const state    = pickState(entry, now);
    const dubLine  = !label ? null
      : state === 'soon'    ? `🗓️ Next dub: ${label}`
      : state === 'delayed' ? `⏸️ Dub delayed: ${label}${entry.delayedText ? ` (${entry.delayedText})` : ''}`
      : `🆕 Dubbed: ${label}`;
    if (label) labeled++;

    const description = [dubLine, md.ratingsLine, t.description].filter(Boolean).join('\n\n') || undefined;

    metas.push({
      id:          finalId,
      type:        ITEM_TYPE,
      name:        title,
      poster:      posterFor(finalId, k.posterImage, t.imdbId, t.tmdbPoster, tmdbId || t.tmdbId, mapped.tmdbType),
      posterShape: 'poster',
      background:  t.background,
      description: description,
      releaseInfo: t.releaseInfo,
      genres:      t.genres,
      imdbRating:  md.imdbRating || t.imdbRating,
      _label:      label,
      _state:      state
    });
  }

  console.log(`Built ${metas.length} items; skipped ${skipped} (no Kitsu hit or no Fribb mapping); TMDB-enriched ${enriched}; MDBList-rated ${rated}; with episode number ${labeled}.`);
  console.log('Top 5 final order:', metas.slice(0, 5).map((m) => m.name));
  return metas;
}

// ---------------------------------------------------------------------------
// WRITE STATIC OUTPUT
// ---------------------------------------------------------------------------
async function main() {
  if (!AS_TOKEN) throw new Error('ANIMESCHEDULE_TOKEN is not set.');

  const metas      = await buildMetas();
  await labelPosters(metas);
  for (const m of metas) { delete m._label; delete m._state; }
  const catalogDir = path.join(OUT_DIR, 'catalog', ITEM_TYPE);

  await fs.mkdir(catalogDir, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '');
  await fs.writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  const payload = JSON.stringify({ metas }, null, 2);
  await fs.writeFile(path.join(catalogDir, `${CATALOG_ID}.json`), payload);

  const skipDir = path.join(catalogDir, CATALOG_ID);
  await fs.mkdir(skipDir, { recursive: true });
  await fs.writeFile(path.join(skipDir, 'skip=0.json'), payload);

  console.log(
    'Wrote manifest.json, ' +
    `catalog/${ITEM_TYPE}/${CATALOG_ID}.json, ` +
    `catalog/${ITEM_TYPE}/${CATALOG_ID}/skip=0.json`
  );
}

main().catch((e) => {
  console.error('Build failed:', e.message);
  process.exit(1);
});
