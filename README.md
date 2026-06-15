# AnimeSchedule Dubbed — static Stremio/Nuvio addon

A "Recently Dubbed" anime row, generated daily from AnimeSchedule.net and
served as plain static JSON on GitHub Pages. No server, no credit card.

It outputs `kitsu:` IDs and relies on the **Anime Kitsu** addon (installed in
the same client) to open and play each title.

---

## How it works

A GitHub Actions cron runs `build.js` once a day. That script calls
AnimeSchedule's dub timetable, resolves each title to a Kitsu ID, and writes
two static files into `public/`:

- `public/manifest.json`
- `public/catalog/anime/as-dub-recent.json`

GitHub Pages serves them (it sends the CORS header Stremio needs and is HTTPS).
Stremio just reads static files — all the work happened ahead of time in CI.

---

## Setup (about 5 minutes)

### 1. Get an AnimeSchedule API token
- Account at animeschedule.net → `https://animeschedule.net/users/<you>/settings/api`
- Create an Application, copy the token.

### 2. Put these files in a new PUBLIC GitHub repo
Public repos get free Actions + Pages. Upload:
```
build.js
package.json
.github/workflows/deploy.yml
README.md
```

### 3. Add your token as a repo secret
Repo → Settings → Secrets and variables → Actions → New repository secret
- Name: `ANIMESCHEDULE_TOKEN`
- Value: your token

### 4. Turn on Pages with the Actions source
Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**

### 5. Run it
Push the files (the workflow runs on push), or go to the **Actions** tab →
"Build and Deploy Addon" → **Run workflow**. Wait for the green check.

### 6. Get your manifest URL
After a successful run it's at:
```
https://<your-username>.github.io/<your-repo>/manifest.json
```

### 7. Install in Nuvio / Stremio
- Add-ons → paste the manifest URL above.
- Also install **Anime Kitsu** in the same client, or items won't open.

It refreshes every day on the cron. To refresh on demand, Actions → Run workflow.

---

## Verify / refine (it's a starter)

Open the latest Actions run log and look at the **"Sample AnimeSchedule dub
entry"** dump — it shows the real field shape. Then:

1. **Field names** — adjust `pickTitle()` / `pickDate()` in `build.js` if the
   real fields differ from the guesses (`english`/`romaji`/`title`,
   `episodeDate`/`airDate`/`date`).
2. **Endpoint** — change `AS_DUB_ENDPOINT` if your account exposes the dub
   timetable at a different path. Docs: https://animeschedule.net/api/v3/documentation
3. **Kitsu matching** — `resolveKitsuId()` matches by title text and can
   mis-hit. If entries include a MAL id, mapping MAL → Kitsu (e.g. via Fribb's
   `anime-lists`) is far more reliable.
4. **Type** — if items appear but won't open, change `ITEM_TYPE` to `'series'`.
