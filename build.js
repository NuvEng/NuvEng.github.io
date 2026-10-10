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
  version: '0.4.0',
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

async function fetchDubTimetable() {
  const res = await fetch(AS_DUB_ENDPOINT, {
    headers: { Authorization: `Bearer ${AS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`AnimeSchedule responded ${res.status} ${res.statusText}`);
  return res.json();
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

function pickTitle(entry) {
  return entry.english || entry.romaji || entry.title || entry.native || null;
}

function pickDate(entry) {
  const raw = entry.episodeDate || entry.airDate || entry.date || null;
  const t   = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
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
  if (tmdb.tv != null && tmdb.tv !== '')       return { id: `tmdb:${tmdb.tv}`, tmdbType: 'tv' };
  if (typeof e.imdb_id === 'string' && e.imdb_id.startsWith('tt')) return { id: e.imdb_id, tmdbType: null };
  if (tmdb.movie != null && tmdb.movie !== '') return { id: `tmdb:${tmdb.movie}`, tmdbType: 'movie' };
  return null;
}

function posterFor(finalId, kitsuPosterImage, imdbId, tmdbPoster) {
  const id = typeof finalId === 'string' ? finalId : String(finalId || '');
  const tt = id.startsWith('tt') ? id : imdbId;

  if (RPDB_KEY && tt) {
    return `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${tt}.jpg?fallback=true`;
  }
  if (tmdbPoster) return tmdbPoster;
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
    imdbId:      typeof imdb === 'string' && imdb.startsWith('tt') ? imdb : undefined
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

async function buildMetas() {
  const [timetable] = await Promise.all([fetchDubTimetable(), loadFribbMapping()]);

  const list = Array.isArray(timetable) ? timetable : [];
  console.log(`AnimeSchedule returned ${list.length} raw entries.`);

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

    const description = [md.ratingsLine, t.description].filter(Boolean).join('\n\n') || undefined;

    metas.push({
      id:          finalId,
      type:        ITEM_TYPE,
      name:        title,
      poster:      posterFor(finalId, k.posterImage, t.imdbId, t.tmdbPoster),
      posterShape: 'poster',
      background:  t.background,
      description: description,
      releaseInfo: t.releaseInfo,
      genres:      t.genres,
      imdbRating:  md.imdbRating || t.imdbRating
    });
  }

  console.log(`Built ${metas.length} items; skipped ${skipped} (no Kitsu hit or no Fribb mapping); TMDB-enriched ${enriched}; MDBList-rated ${rated}.`);
  console.log('Top 5 final order:', metas.slice(0, 5).map((m) => m.name));
  return metas;
}

// ---------------------------------------------------------------------------
// WRITE STATIC OUTPUT
// ---------------------------------------------------------------------------
async function main() {
  if (!AS_TOKEN) throw new Error('ANIMESCHEDULE_TOKEN is not set.');

  const metas      = await buildMetas();
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
