# Bug Asset Manager

Five browser-local tools for getting product content ready for the site:
batch image cropping, precise resizing, supplier-HTML cleaning, and two
spreadsheet fixers.

Everything runs inside the browser. No file you open is ever uploaded, and
closing the tab discards all of it.

---

## Using it

Open the deployed URL. That is the whole install.

The app checks for a new release every time it starts. When one exists it shows
a banner with **Update now**; one click and it reloads on the new version. There
is nothing to download and no file to replace by hand.

After the first visit it works offline — a service worker keeps the app cached,
so a dropped connection does not stop you working.

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

## Deploying

The app is plain HTML, CSS and ES modules. There is **no build step** — what is
in the repository is what runs.

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

Opening `index.html` straight off disk does **not** work: ES modules and service
workers both need a real HTTP origin. That is the one thing 3.0 gives up in
exchange for updating itself.

### Previewing a change locally

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8123/>. It serves the repository over HTTP with no
dependencies, which matters on a machine with no Node or Python installed.
Ctrl+C stops it.

---

## Cutting a release

```bash
tools/release.sh 3.1.0 "Short title" "Longer note shown in the update prompt"
git push && git push --tags
```

The script updates the four places a version lives — `assets/js/core/version.js`,
`version.json`, the `CACHE_VERSION` in `sw.js`, and both changelogs — then
commits and tags. Bumping `CACHE_VERSION` is what makes browsers install the new
service worker, which is what surfaces the update prompt.

Never edit those version numbers by hand; if they drift apart, clients can end up
being told about an update that the cache then refuses to fetch.

---

## Layout

```
index.html                  entry point
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
  workers/crop-worker.js    image bounds analysis
  vendor/                   SheetJS 0.18.5 + spreadsheet processors

legacy/aio-2_4_1.html       the previous single-file build, for reference
tools/release.sh            release script
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
