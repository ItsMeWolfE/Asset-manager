# Asset Manager

Five browser-local tools for getting product content ready for the site:
batch image cropping, precise resizing, supplier-HTML cleaning, and two
spreadsheet fixers.

Everything runs inside the browser. No file you open is ever uploaded, and
closing the tab discards all of it.

---

## Opening it

**Double-click `Asset Manager.html`.** That is the whole install.

It is a one-kilobyte launcher rather than the app itself: it opens the hosted
version at <https://itsmewolfe.github.io/Asset-manager/>. Copy it to a desktop,
a shared drive, or an email attachment — wherever it is easiest to reach. A
bookmark does the same job; the file exists so there is something to hand to
someone who would rather not keep one.

The app checks for a new release every time it starts. When one exists it shows
a banner with **Update now**; one click and it reloads on the new version.
Nothing to download, no file to replace by hand.

Only the first run needs a connection. After that a service worker keeps the app
cached and it opens offline like anything else.

To run it from this repository instead — on your own machine, or on your own
server — see [Running it locally](#running-it-locally) and
[Deploying](#deploying).

> **Why the app is not one self-contained file.** It used to be, and that file
> could never update itself: a page opened from `file://` may not register a
> service worker or overwrite itself on disk. Every copy went stale the day it
> was built, and the only remedy was to send everyone a new one. A launcher
> pointing at a hosted app is the only arrangement in which one double-click and
> an always-current version are the same thing.
>
> The same browser rule is why `index.html` is blank when opened from disk:
> `<script type="module" src="...">` is treated as a cross-origin request over
> `file://`, so nothing runs. It shows an explanation and points at the hosted
> app rather than sitting there empty.

## The tools

| Tool | What it does |
| --- | --- |
| **Batch Cropper** | Trims the empty margin off product photos in bulk. Full crop or centred 1:1 square, and optionally cuts the product out of its background with a model that runs on the machine you are sitting at. Outputs lossless WebP, as a ZIP or as individual files. |
| **Smart Resizer** | Places one image inside a fixed output canvas, positioned by hand. Fit or fill, drag with centre snapping, transparent or coloured background. |
| **HTML Cleaner** | Flattens a supplier's description markup into safe paragraphs. Tables, images and video survive; scripts, frames, fonts and Word leftovers do not. |
| **Dragon Fixer** | Turns a Dragon stock export into the headerless two-column barcode/stock file the import expects. |
| **Price XLSX Fixer** | Finds the item-code and updated-consumer-price columns in any supplier price list and writes them out as text-safe XLSX. |

The **About** tab documents every tool in full, in English and Hebrew.

Preferences (language, six themes, four text sizes, accent colour) live in the
gear menu and are saved per browser.

---

## Running it locally

This is the edition served from a URL, so it needs a real HTTP origin: browsers
refuse to load ES modules and register service workers over `file://`. Any
static file server will do, and the repository ships one that needs nothing
installed.

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8123/>. Ctrl+C stops it.

`tools/serve.ps1` is a PowerShell `HttpListener` with no dependencies at all,
which matters on a machine with neither Node nor Python. It serves the
repository root, sends `Service-Worker-Allowed` and marks every response
`no-cache`, so the offline shell and the update check behave the way they do in
production rather than being masked by a stale cache. It logs each request,
which is the quickest way to spot a path that 404s.

Use `-Port` if 8123 is taken, or `-Root` to serve a different directory:

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 9000
```

Anything equivalent works just as well:

```bash
npx serve .                  # Node
python -m http.server 8123   # Python
```

`localhost` counts as a secure context, so the service worker registers without
a certificate. Everything works exactly as it does on the deployed site —
offline caching, the version check, and the update banner.

Two things to expect while developing:

- **The service worker caches aggressively.** After editing anything under
  `assets/`, a plain reload can still serve the cached copy. Use a hard reload,
  or tick **Application → Service Workers → Update on reload** in DevTools.
- **The update banner only appears when `version.json` is ahead of
  `APP_VERSION`.** To see it, serve a copy whose `version.json` names a higher
  version while `assets/js/core/version.js` stays put. Do not commit that —
  `tools/release.sh` is what moves the two together.

Opening `index.html` by double-clicking it does **not** work, by design.
`Asset Manager.html` is the file to double-click; see
[Opening it](#opening-it).

---

## Deploying

The app is plain HTML, CSS and ES modules: what is in the repository is what
runs, with no build step, no toolchain and no generated files.

### GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the
   repository root as-is.

The site is served at `https://<user>.github.io/<repo>/`. Every path in the app
is relative, so it works from a subdirectory without configuration.

### Anywhere else

Copy the repository to any static web server. The only requirements are that
`sw.js` and `version.json` are served from the site root and that the origin is
`https://` (or `localhost`), because service workers need a secure context.

If you deploy somewhere other than the URL above, update the link in
`Asset Manager.html` to match — it is hardcoded, because a file opened from
disk has no site to be relative to. It is the only place that URL appears.

Opening `index.html` straight off disk does **not** work. See
[Opening it](#opening-it).

### Previewing a change locally

Serve the repository and open it over HTTP — see
[Running it locally](#running-it-locally).

---

## Cutting a release

```bash
tools/release.sh 3.1.0 "Short title" "Longer note shown in the update prompt"
git push && git push --tags
```

The script updates every place a version lives — `assets/js/core/version.js`,
`version.json`, the `CACHE_VERSION` in `sw.js`, and both changelogs — then
commits and tags. Bumping `CACHE_VERSION` is what
makes browsers install the new service worker, which is what surfaces the update
prompt.

Never edit those version numbers by hand; if they drift apart, clients can end up
being told about an update that the cache then refuses to fetch.

---

## Layout

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
    prefs.js                themes, language, text size, accent
    i18n.js                 translation lookup
    dom.js                  h() helper and the icon set
    ui.js                   status panel, event log, dropzone, toast
    files.js                saveBlob + store-only ZIP writer
    image.js                decode, encode, crop pipeline
    sheet.js                spreadsheet worker client
    sanitize.js             HTML sanitizer
    segment.js              background-removal client
  tools/                    one module per tool
  data/                     About copy, changelog, Hebrew strings
  workers/crop-worker-source.js  image bounds analysis
  workers/segment-worker.js      U^2-Net inference
  vendor/                   SheetJS 0.18.5 + spreadsheet processors

assets/models/u2netp.onnx   the background-removal network (4.4 MB)
assets/vendor/onnxruntime/  ONNX Runtime Web, WebAssembly build (11 MB)

legacy/aio-2_4_1.html       the previous single-file build (local only, gitignored)

tools/release.sh            cut a release
tools/serve.ps1             local preview server
```

### Dependencies

Two, both vendored into this repository and served from this origin like any
other asset. Neither is fetched from a CDN: an office machine may have no route
to one, and nothing here should stop working because a third party did.

- **SheetJS 0.18.5** → parsing XLSX is not worth reimplementing. Carried over
  verbatim inside the spreadsheet worker, along with the Dragon and Price column
  logic.
- **ONNX Runtime Web 1.19.2 + U²-Net** → background removal, and only loaded
  when somebody turns that option on. See
  [Background removal](#background-removal).

2.x shipped React, SheetJS, DOMPurify, JSZip and FileSaver inside one 871 KB
HTML file. Everything but SheetJS was replaced rather than kept:

- **React** → plain ES modules and direct DOM construction.
- **DOMPurify** → `core/sanitize.js`, an allowlist sanitizer that rebuilds the
  tree from scratch rather than scrubbing it in place.
- **JSZip** → `core/files.js`. The cropper only ever asked for `STORE`, since
  WebP does not compress further, so the archive is just headers around raw
  bytes.
- **FileSaver** → an anchor and an object URL.
### Background removal

`assets/js/workers/segment-worker.js` runs U²-Net through ONNX Runtime on the
WebAssembly backend: CPU only, single-threaded. Both of those are forced rather
than chosen — GitHub Pages cannot send the COOP/COEP headers that
`SharedArrayBuffer` needs, so worker threads are unavailable by definition, and
the machines this runs on have no GPU worth using. A 320×320 forward pass costs
roughly a second per image.

`u2netp` is the small variant of U²-Net: 4.4 MB against 168 MB for the full
network, which is what makes it shippable and fast enough on a CPU. It is
Apache-2.0. The better-known RMBG-1.4 was rejected deliberately — its licence
forbids commercial use, and this is a commercial catalogue.

Two constants in that worker shape the result:

- `KEEP_RATIO` discards blobs smaller than that fraction of the largest one,
  which is what removes reflections and stray specks. It is deliberately not
  1.0: a product shot is often a pair or a set, and keeping only the single
  biggest mass silently deletes half the product.
- `EDGE_LO` / `EDGE_HI` pull the network's soft rim apart into an edge that is
  crisp but still anti-aliased.

The model and the runtime are cached by the service worker under
`asset-manager-model-v1`, deliberately not the versioned shell cache, so cutting
a release does not make every machine re-fetch 16 MB. Bump that name in `sw.js`
if the model itself is ever replaced.

### Changing a tool's behaviour

The Dragon and Price column matching lives inside
`assets/js/vendor/sheet-worker-source.js`, which is a single template literal
holding the worker source. It is deliberately untouched from 2.4.1 so the
matching rules are known-good. Edit it only if the header names genuinely
change, and keep it as one classic (non-module) worker — that is what makes it
work in Chromium.
