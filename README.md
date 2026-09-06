# Asset Manager

Five browser-local tools for getting product content ready for the site:
batch image cropping, precise resizing, supplier-HTML cleaning, and two
spreadsheet fixers.

Everything runs inside the browser. No file you open is ever uploaded, and
closing the tab discards all of it.

---

## Two editions

| | Hosted (`index.html`) | Standalone (`asset-manager.html`) |
| --- | --- | --- |
| How you open it | a URL | double-click the file |
| Needs a server | yes | no |
| Updates itself | **yes**, one click | no — replace the file |
| Works offline | yes, after the first visit | yes, always |

Both are built from the same source and behave identically. Use the hosted one
if you want the automatic updates; that is what the whole update mechanism is
for.

### Hosted

Open the deployed URL. That is the whole install. To run it from this
repository instead — on your own machine, or on your own server — see
[Running it locally](#running-it-locally) and [Deploying](#deploying).

The app checks for a new release every time it starts. When one exists it shows
a banner with **Update now**; one click and it reloads on the new version. There
is nothing to download and no file to replace by hand.

After the first visit it works offline — a service worker keeps the app cached,
so a dropped connection does not stop you working.

### Standalone

`asset-manager.html` is one self-contained file. Double-click it and it
runs: no server, no network, nothing to install. It is the direct descendant of
the old `aio-2_4_1.html`.

It cannot update itself — a page opened from `file://` is not allowed to
overwrite itself on disk, and cannot register a service worker. When a new
version ships, download the file again.

Rebuild it after changing anything under `assets/`:

```bash
tools/build-standalone.sh
```

> **Why `index.html` is blank when opened from disk:** browsers refuse to load
> `<script type="module" src="...">` over `file://`, treating it as a
> cross-origin request. Nothing runs, so the page stays empty. It now shows an
> explanation instead of nothing, and points at the standalone build. This is a
> browser rule, not something the app can work around — which is exactly why the
> standalone build exists.

### The tools

| Tool | What it does |
| --- | --- |
| **Batch Cropper** | Trims the empty margin off product photos in bulk. Full crop or centred 1:1 square. Outputs lossless WebP, as a ZIP or as individual files. |
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

Opening `index.html` by double-clicking it does **not** work, by design. Use
`asset-manager.html` for that; see [Two editions](#two-editions).

---

## Deploying

The hosted app is plain HTML, CSS and ES modules: what is in the repository is
what runs, with no build step and no toolchain. The only generated file is
`asset-manager.html`, and `tools/release.sh` rebuilds it for you.

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

Opening `index.html` straight off disk does **not** work — use
`asset-manager.html` for that. See [Two editions](#two-editions).

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
`version.json`, the `CACHE_VERSION` in `sw.js`, and both changelogs — rebuilds
`asset-manager.html`, then commits and tags. Bumping `CACHE_VERSION` is what
makes browsers install the new service worker, which is what surfaces the update
prompt.

Never edit those version numbers by hand; if they drift apart, clients can end up
being told about an update that the cache then refuses to fetch.

---

## Layout

```
index.html                  entry point (hosted edition)
asset-manager.html          generated single-file edition - do not edit
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
  tools/                    one module per tool
  data/                     About copy, changelog, Hebrew strings
  workers/crop-worker-source.js  image bounds analysis
  vendor/                   SheetJS 0.18.5 + spreadsheet processors

legacy/aio-2_4_1.html       the previous single-file build (local only, gitignored)

tools/release.sh            cut a release
tools/build-standalone.sh   regenerate asset-manager.html
tools/serve.ps1             local preview server
```

### Dependencies

None at runtime. 2.x shipped React, SheetJS, DOMPurify, JSZip and FileSaver
inside one 871 KB HTML file; 3.0 keeps only SheetJS, because parsing XLSX is not
something worth reimplementing.

- **React** → plain ES modules and direct DOM construction.
- **DOMPurify** → `core/sanitize.js`, an allowlist sanitizer that rebuilds the
  tree from scratch rather than scrubbing it in place.
- **JSZip** → `core/files.js`. The cropper only ever asked for `STORE`, since
  WebP does not compress further, so the archive is just headers around raw
  bytes.
- **FileSaver** → an anchor and an object URL.
- **SheetJS 0.18.5** → kept, carried over verbatim inside the spreadsheet worker
  along with the Dragon and Price column logic.

### Changing a tool's behaviour

The Dragon and Price column matching lives inside
`assets/js/vendor/sheet-worker-source.js`, which is a single template literal
holding the worker source. It is deliberately untouched from 2.4.1 so the
matching rules are known-good. Edit it only if the header names genuinely
change, and keep it as one classic (non-module) worker — that is what makes it
work in Chromium.
