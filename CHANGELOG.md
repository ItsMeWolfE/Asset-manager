# Changelog

## 3.0.0 - 2026-09-06

**Repository release with automatic updates**

Rebuilt as a versioned repository that deploys to a URL instead of being passed
around as a single HTML file. The app checks for a new release every time it
starts and offers a one-click update; a service worker keeps it working offline
between updates.

- Interface redesigned directly against the theme variables. All six themes,
  four text sizes, the accent colour and the full Hebrew RTL interface are
  unchanged in behaviour.
- React, DOMPurify, JSZip and FileSaver removed in favour of plain ES modules,
  a purpose-built allowlist sanitizer and a store-only ZIP writer. SheetJS is
  kept, verbatim, inside the spreadsheet worker.
- All five tools behave exactly as they did in 2.4.1: the crop worker, the
  Dragon column matching and the Price header scoring are carried over unchanged.

Fixed along the way:

- Ctrl+V paste in the Batch Cropper and Smart Resizer now works when nothing is
  focused. The handler was bound to the tool container, which a paste targeting
  `<body>` never reaches.
- Switching tools no longer scrolls the heading under the sticky header.
- The Smart Resizer can no longer delete its last preset and leave the picker
  empty with no way back; built-in presets can also be restored.

Known change in behaviour: the app must be served over HTTP(S). Opening the file
straight off disk no longer works, because ES modules and service workers both
require a real origin. That is the trade for updating itself.

## 2.4.1

Earlier history is listed in the About tab and in
`assets/js/data/changelog.js`.
