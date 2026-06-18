'use strict';
// Generates the static files a Stremio/Nuvio catalog addon needs:
//   public/manifest.json
//   public/catalog/<type>/<id>.json   (+ /skip=0.json variant)
//
// Each AnimeSchedule dub entry is resolved to a Kitsu ID, then mapped to a
// real TMDB / IMDb ID via Fribb's anime-lists. Emitting TMDB IDs natively
// resolves in Stremio + Nuvio without requiring Cinemeta.

const fs = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const AS_TOKEN = process.env.ANIMESCHEDULE_TOKEN;  // GitHub Actions secret
const RPDB_KEY = process.env.RPDB_KEY || '';       // optional secret

const AS_BASE         = 'https://animeschedule.net/api/v3';
const AS_DUB_ENDPOINT = `${AS_BASE}/timetables/dub`;
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
  version: '0.2.5',
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
// Prefer TMDB tv ID — resolves natively in Stremio + Nuvio without Cinemeta.
function mapKitsuToId(kitsuId) {
  const e = fribbByKitsu.get(Number(kitsuId));
  if (!e) return null;
  const tmdb = e.themoviedb_id || {};
  if (tmdb.tv)    return `tmdb:${tmdb.tv}`;
  if (e.imdb_id)  return e.imdb_id;
  if (tmdb.movie) return `tmdb:${tmdb.movie}`;
  return null;
}

// Poster priority:
//   1. RPDB rating poster (only when key set AND we have an IMDb tt ID)
//   2. Stable Kitsu CDN URL (skips signed/expiring X-Amz- URLs)
//   3. undefined — client falls back to its metadata provider's art
function posterFor(finalId, kitsuPosterImage) {
  if (RPDB_KEY && finalId.startsWith('tt')) {
    return `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${finalId}.jpg?fallback=true`;
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

async function buildMetas() {
  const [timetable] = await Promise.all([fetchDubTimetable(), loadFribbMapping()]);

  const list = Array.isArray(timetable) ? timetable : [];
  console.log(`AnimeSchedule returned ${list.length} raw entries.`);

  if (list[0]) {
    console.log('--- Sample entry ---');
    console.log(JSON.stringify(list[0], null, 2));
    console.log('-------------------');
  }

  // Sort: already-aired episodes first (most recent at top), future episodes
  // at the end (soonest upcoming first). This puts today's/yesterday's dubs
  // at position 1 rather than Sunday's shows jumping the queue.
  const now = Date.now();
  list.sort((a, b) => {
    const da = pickDate(a), db = pickDate(b);
    const aFuture = da > now, bFuture = db > now;
    if (aFuture && !bFuture) return 1;   // a is future, b already aired → b wins
    if (!aFuture && bFuture) return -1;  // a already aired, b is future → a wins
    if (!aFuture && !bFuture) return db - da; // both aired: most recent first
    return da - db;                           // both future: soonest first
  });

  const seen  = new Set();
  const metas = [];
  let skipped = 0;

  for (const entry of list) {
    const title = pickTitle(entry);
    const k     = await resolveKitsuId(title);
    if (!k) { skipped++; continue; }

    const finalId = mapKitsuToId(k.id);
    if (!finalId) { skipped++; continue; }

    if (seen.has(finalId)) continue;
    seen.add(finalId);

    metas.push({
      id:     finalId,
      type:   ITEM_TYPE,
      name:   title,
      poster: posterFor(finalId, k.posterImage)
    });
  }

  console.log(`Built ${metas.length} items; skipped ${skipped} (no Kitsu hit or no Fribb mapping).`);
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

  // Some clients request the paginated path .../skip=0.json — emit it too.
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
