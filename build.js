'use strict';

// Generates the static files a Stremio/Nuvio catalog addon needs:
//   public/manifest.json
//   public/catalog/<type>/<id>.json
// Run by GitHub Actions on a daily cron. No server required.

const fs = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const AS_TOKEN = process.env.ANIMESCHEDULE_TOKEN; // set as a GitHub Actions secret
const AS_BASE = 'https://animeschedule.net/api/v3';
const AS_DUB_ENDPOINT = `${AS_BASE}/timetables/dub`;

const ITEM_TYPE = 'anime'; // change to 'series' if items won't open in your client
const CATALOG_ID = 'as-dub-recent';
const OUT_DIR = path.join(__dirname, 'public');

// Optional: RatingPosterDB key. If set (as a GitHub Actions secret RPDB_KEY),
// posters are replaced with RPDB rating posters. This also sidesteps Kitsu's
// occasional expiring signed-image URLs. Leave unset to use plain Kitsu art.
const RPDB_KEY = process.env.RPDB_KEY || '';

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------

const manifest = {
  id: 'community.animeschedule.dub',
  version: '0.1.0',
  name: 'AnimeSchedule Dubbed',
  description:
    'A "Recently Dubbed" anime row sourced from AnimeSchedule.net. ' +
    'Requires the Anime Kitsu addon installed in the same client so items can open and play.',
  resources: ['catalog'],
  types: [ITEM_TYPE],
  idPrefixes: ['kitsu:'],
  catalogs: [{ type: ITEM_TYPE, id: CATALOG_ID, name: 'Recently Dubbed', extra: [] }],
  behaviorHints: { configurable: false }
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const kitsuCache = new Map();

async function fetchDubTimetable() {
  const res = await fetch(AS_DUB_ENDPOINT, {
    headers: { Authorization: `Bearer ${AS_TOKEN}` }
  });
  if (!res.ok) {
    throw new Error(`AnimeSchedule responded ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Field-name guesses — verify against the debug dump in the Actions log.
function pickTitle(entry) {
  return entry.english || entry.romaji || entry.title || entry.native || null;
}
function pickDate(entry) {
  const raw = entry.episodeDate || entry.airDate || entry.date || null;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

async function resolveKitsuId(title) {
  if (!title) return null;
  if (kitsuCache.has(title)) return kitsuCache.get(title);
  try {
    const url =
      'https://kitsu.io/api/edge/anime?page[limit]=1&filter[text]=' +
      encodeURIComponent(title);
    const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
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

// Pick a poster. With an RPDB key: a stable rating poster (also avoids Kitsu's
// occasional expiring signed URLs). Without: the first stable Kitsu CDN image,
// skipping signed/expiring ones. Returns undefined if none is safe (the client
// then falls back to the title's own art via Anime Kitsu).
function isStableKitsuUrl(u) {
  return typeof u === 'string' &&
    u.startsWith('https://media.kitsu.app/') &&
    !u.includes('X-Amz-') &&
    !u.includes('?');
}
function posterFor(kitsuId, posterImage) {
  if (RPDB_KEY) {
    return `https://api.ratingposterdb.com/${RPDB_KEY}/kitsu/poster-default/${kitsuId}.jpg?fallback=true`;
  }
  if (posterImage) {
    for (const size of ['medium', 'large', 'original', 'small']) {
      if (isStableKitsuUrl(posterImage[size])) return posterImage[size];
    }
  }
  return undefined;
}

async function buildMetas() {
  const timetable = await fetchDubTimetable();
  const list = Array.isArray(timetable) ? timetable : [];

  if (list[0]) {
    console.log('--- Sample AnimeSchedule dub entry (verify field names) ---');
    console.log(JSON.stringify(list[0], null, 2));
    console.log('-----------------------------------------------------------');
  }

  list.sort((a, b) => pickDate(b) - pickDate(a));

  const seen = new Set();
  const metas = [];
  for (const entry of list) {
    const title = pickTitle(entry);
    const k = await resolveKitsuId(title);
    if (!k || seen.has(k.id)) continue;
    seen.add(k.id);
    metas.push({
      id: `kitsu:${k.id}`,
      type: ITEM_TYPE,
      name: title,
      poster: posterFor(k.id, k.posterImage)
    });
  }
  return metas;
}

// ---------------------------------------------------------------------------
// WRITE STATIC OUTPUT
// ---------------------------------------------------------------------------

async function main() {
  if (!AS_TOKEN) throw new Error('ANIMESCHEDULE_TOKEN is not set.');

  const metas = await buildMetas();
  console.log(`Built ${metas.length} items.`);

  const catalogDir = path.join(OUT_DIR, 'catalog', ITEM_TYPE);
  await fs.mkdir(catalogDir, { recursive: true });

  // .nojekyll so GitHub Pages serves every path untouched.
  await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '');

  await fs.writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  const payload = JSON.stringify({ metas }, null, 2);

  await fs.writeFile(
    path.join(catalogDir, `${CATALOG_ID}.json`),
    payload
  );

  // Stremio/Nuvio often request the catalog with a pagination segment, e.g.
  // /catalog/anime/as-dub-recent/skip=0.json . A live server computes that;
  // a static host needs the file to exist. Emit that variant too so every
  // request shape resolves instead of 404ing.
  const skipDir = path.join(catalogDir, CATALOG_ID);
  await fs.mkdir(skipDir, { recursive: true });
  await fs.writeFile(path.join(skipDir, 'skip=0.json'), payload);

  console.log(
    'Wrote manifest.json, catalog/' + ITEM_TYPE + '/' + CATALOG_ID + '.json, ' +
    'and catalog/' + ITEM_TYPE + '/' + CATALOG_ID + '/skip=0.json'
  );
}

main().catch((e) => {
  console.error('Build failed:', e.message);
  process.exit(1);
});
