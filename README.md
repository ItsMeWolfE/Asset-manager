# Asset Manager

A single web page holding the five tools we use to get product content ready for
the site: cropping and resizing photos, cleaning up supplier HTML, and fixing
two kinds of spreadsheet.

Everything runs inside your own browser. No file you open is ever uploaded, and
closing the tab throws all of it away.

**<https://itsmewolfe.github.io/Asset-manager/>**

---

## What it does

| Tool | What it does |
| --- | --- |
| **Batch Cropper** | Strips the empty margin off product photos, in bulk. Optionally cuts the product out of its background too. |
| **Smart Resizer** | Places one image, exactly where you want it, inside a fixed canvas size. |
| **HTML Cleaner** | Turns a supplier's messy description HTML into something safe to paste into the site. |
| **Dragon Fixer** | Turns a Dragon stock export into the two-column file the import expects. |
| **Price XLSX Fixer** | Pulls item codes and updated prices out of any supplier price list. |

The **About** tab inside the app documents every tool in full — what it is for,
how to use it step by step, and what to watch out for — in English and Hebrew.
That is the guide for people using the tools; this file is the guide for people
changing them.

Language, theme, text size and accent colour live in the gear menu and are
remembered per browser.

---

## Opening it

**Double-click `Asset Manager.html`**, or just open the URL above. That is the
whole install.

`Asset Manager.html` is a one-kilobyte launcher, not a copy of the app: it opens
the hosted version. Keep it on a desktop or a shared drive, or hand it to
someone who would rather not keep a bookmark.

Only the first visit needs a connection. After that a service worker keeps the
app cached and it opens offline.

> **Why there is no self-contained single-file build.** There used to be, and it
> could never update itself — a page opened from `file://` may not register a
> service worker or overwrite itself on disk, so every copy went stale the day
> it was built. A launcher pointing at a hosted app is the only arrangement
> where one double-click and an always-current version are the same thing.
>
> The same rule is why `index.html` is blank if you open it from disk: browsers
> refuse to load ES modules over `file://`, so nothing runs.

---

## Running it locally

The app needs a real HTTP origin — ES modules and service workers are both
refused over `file://`. Any static file server works; the repository ships one
that needs nothing installed.

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8123/>. Ctrl+C stops it. Use `-Port` if 8123 is
taken.

`tools/serve.ps1` is a PowerShell `HttpListener` with no dependencies, which
matters on a machine with neither Node nor Python. It marks every response
`no-cache` and serves `.wasm` correctly, so the offline shell, the update check
and the background-removal model all behave as they do in production.

Anything equivalent works too:

```bash
npx serve .                  # Node
python -m http.server 8123   # Python
```

`localhost` counts as a secure context, so the service worker registers without
a certificate.

Two things to expect while developing:

- **The service worker caches aggressively.** After editing anything under
  `assets/`, use a hard reload, or tick **Application → Service Workers → Update
  on reload** in DevTools.
- **The update banner only appears when `version.json` is ahead of
  `APP_VERSION`.** To see it, serve a copy whose `version.json` names a higher
  version. Never commit that — `tools/release.sh` is what moves them together.

---

## How updates reach people

Two mechanisms, backing each other up:

1. `version.json` is fetched on every start with `cache: 'no-store'`. If it
   names a higher version than the running one, the app shows a banner with
   **Update now**.
2. The service worker precaches the app. When a new one installs it waits, and
   that surfaces as the same banner.

Either way it is one prompt and one button. Nothing is downloaded by hand.

This is also why a code change alone is not enough to reach anyone: assets are
served cache-first from a versioned cache, so an existing user keeps the old
files until `CACHE_VERSION` changes. **Ship user-visible changes as a release,
not a bare push.**

---

## Structure

```
Asset Manager.html          the launcher; the file to double-click
index.html                  the app's entry point
version.json                what the update check reads
sw.js                       offline cache + update handshake
manifest.webmanifest        installable-app metadata

assets/css/app.css          the whole design system
assets/js/
  main.js                   shell: nav, preferences, tool mounting
  core/
    version.js              APP_VERSION
    update.js               update check and service-worker handshake
    prefs.js                theme, language, text size, accent
    i18n.js                 translation lookup
    dom.js                  h() helper and the icon set
    ui.js                   status panel, event log, dropzone, toast
    files.js                saveBlob + store-only ZIP writer
    image.js                decode, encode, crop pipeline
    sheet.js                spreadsheet worker client
    sanitize.js             HTML sanitizer
    segment.js              background-removal client
  tools/                    one module per tool
  i18n/                     one file per language, plus the registry
  data/                     About copy and the changelog
  workers/crop-worker-source.js  image bounds analysis
  workers/segment-worker.js      U^2-Net inference
  vendor/                   SheetJS + spreadsheet processors

assets/models/u2netp.onnx   the background-removal network (4.4 MB)
assets/vendor/onnxruntime/  ONNX Runtime Web, WebAssembly build (11 MB)

tools/release.sh            cut a release
tools/serve.ps1             local preview server
```

---

## Deploying

Plain HTML, CSS and ES modules: what is in the repository is what runs. No build
step, no toolchain, nothing generated.

**GitHub Pages** — **Settings → Pages → Source: GitHub Actions**, then push to
`main`. The workflow in `.github/workflows/pages.yml` publishes the repository
root as-is, after checking that the three version numbers agree.

**Anywhere else** — copy the repository to any static web server. `sw.js` and
`version.json` must be served from the site root, and the origin must be
`https://` or `localhost`, because service workers need a secure context. If you
deploy somewhere new, update the URL in `Asset Manager.html`; it is hardcoded,
because a file opened from disk has no site to be relative to, and it is the
only place that URL appears.

---

## Cutting a release

```bash
tools/release.sh 3.3.0 "Short title" "Longer note shown in the update prompt"
git push && git push --tags
```

The script moves every place a version lives — `assets/js/core/version.js`,
`version.json`, the `CACHE_VERSION` in `sw.js`, and both changelogs — then
commits and tags. Bumping `CACHE_VERSION` is what makes browsers install the new
service worker, which is what surfaces the update prompt.

Never edit those numbers by hand. If they drift apart the Pages workflow fails
the deploy, which is the intended outcome: clients would otherwise be told about
an update the cache then refuses to fetch.

**Keep this file and the About tab current in the same commit as the change they
describe.** A change to what the app does, how it is run, or how it is laid out
belongs in the README; a change to what a user sees or does belongs in
`assets/js/data/about.js`, in both languages. The tool descriptions in
[What it does](#what-it-does) are the About taglines verbatim, so the two never
disagree about what a tool is for.

---

## Languages

`assets/js/i18n/` holds one file per language plus `index.js`, the registry.
English is the source language: its strings are the keys used throughout the
code, so it needs no catalogue and can never fall out of date.

To add a language, copy `he.js`, translate the values, and add it to `LANGUAGES`
in `index.js`. That is the whole change — the preferences picker, the `<html>`
`lang` and `dir` attributes and every lookup read from that list, so no code
tests for a particular language.

A missing translation renders as English rather than as a blank, which makes a
partial catalogue safe to ship. To find gaps, temporarily record the misses
inside `t()` and click through every tool: strings passed as arguments to
helpers like `segButton` never appear inside a `t(...)` call, so searching the
source for them misses a good number.

Release notes in `data/changelog.js` go through the same lookup, so translating
one means adding its title and description to the catalogue.

---

## Background removal

`assets/js/workers/segment-worker.js` runs U²-Net through ONNX Runtime on the
WebAssembly backend: CPU only, single-threaded. Both are forced rather than
chosen — GitHub Pages cannot send the COOP/COEP headers `SharedArrayBuffer`
needs, and the machines this runs on have no GPU worth using. A 320×320 forward
pass costs roughly a second per image.

`u2netp` is the small U²-Net: 4.4 MB against 168 MB for the full network, which
is what makes it shippable and fast enough on a CPU. It is Apache-2.0. The
better-known RMBG-1.4 was rejected deliberately — its licence forbids commercial
use, and this is a commercial catalogue.

Two constants in that worker shape the result:

- `KEEP_RATIO` discards blobs smaller than that fraction of the largest one,
  which removes reflections and stray specks. It is deliberately not 1.0: a
  product shot is often a pair or a set, and keeping only the biggest mass
  silently deletes half the product.
- `EDGE_LO` / `EDGE_HI` pull the network's soft rim into an edge that is crisp
  but still anti-aliased.

The model and the runtime are cached under `asset-manager-model-v1`, deliberately
not the versioned shell cache, so cutting a release does not make every machine
re-fetch 16 MB. Bump that name in `sw.js` if the model is ever replaced.

---

## Dependencies

Two, both vendored into this repository and served from this origin like any
other asset. Neither comes from a CDN: an office machine may have no route to
one, and nothing here should stop working because a third party did.

- **SheetJS 0.18.5** — parsing XLSX is not worth reimplementing. Carried over
  verbatim inside the spreadsheet worker, along with the Dragon and Price column
  logic.
- **ONNX Runtime Web 1.19.2 + U²-Net** — background removal, fetched only when
  somebody turns that option on.

2.x shipped React, SheetJS, DOMPurify, JSZip and FileSaver inside one 871 KB
HTML file. Everything but SheetJS was replaced rather than kept: React became
plain ES modules and direct DOM construction, DOMPurify became
`core/sanitize.js` (an allowlist sanitizer that rebuilds the tree rather than
scrubbing it in place), JSZip became the store-only writer in `core/files.js`,
and FileSaver became an anchor and an object URL.

### Changing a tool's behaviour

The Dragon and Price column matching lives inside
`assets/js/vendor/sheet-worker-source.js`, a single template literal holding the
worker source. It is deliberately untouched from 2.4.1 so the matching rules stay
known-good. Edit it only if the header names genuinely change, and keep it as one
classic (non-module) worker — that is what makes it work in Chromium.
