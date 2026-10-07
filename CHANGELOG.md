# Changelog

## 4.1.1 - 2026-10-07

**Pasted lists without tabs**

A list pasted with spaces between the barcode and the name, instead of a tab, now splits into columns. Before, each line stayed one cell, so In stock, Out of stock and Custom wrote the barcode together with the name into column A.

## 4.1.0 - 2026-10-07

**Your own text in column B**

Spreadsheets has a fourth output, Custom, beside Prices, Stock and Dragon: it writes whatever text you type into column B next to every item code. Stock's two switches became one Column B switch: Stock column reads it from the file, and In stock (10) and Out of stock (9) write that value on every row.

## 4.0.2 - 2026-09-30

**Readable text on any accent colour**

The accent colour picker in the settings stays open while you drag across it, instead of closing on the first colour it picks. Text on the accent colour - buttons, the chosen side of each switch, the logo - now turns black when the colour is too light for white to be read on it, and turns back to white when it is dark enough again.

## 4.0.1 - 2026-09-30

**Save your own defaults**

The Images tool now opens on Optimise, WebP, one ZIP, a tight trim and the background kept. Its switches no longer save themselves when clicked: Save as default, at the top of the tool, makes whatever is on screen what it opens with in this browser, and Reset default goes back to the original.

## 4.0.0 - 2026-09-29

**Six tools became four**

The Image Optimiser and the Smart Resizer are now one tool called Images, with a switch at the top choosing between Optimise and Place. They share the file format, the download packaging, the dropzone and the paste handler, and Place finally writes WebP at quality 92 instead of losslessly, so a placed photo is no longer larger than the JPEG it came from. The XLSX Fixer and the Dragon Fixer are now Spreadsheets, with Dragon as a third option on the Output switch that already read Prices and Stock. Cropping on or off plus the separate full or square choice became one Trim control reading Off, Tight or Square, so there is no longer a switch on screen doing nothing. Nothing was taken away, every setting carries over, and old bookmarks still land on the tool that absorbed them.

## 3.9.1 - 2026-09-29

**WebP comes out at quality 92**

The Image Optimiser now writes WebP at quality 92 instead of losslessly. A lossless WebP has to reproduce a JPEG's own compression noise exactly, which made converted supplier photos come out roughly twice the size of the JPEG they came from; the same files are now about a quarter of it. Quality 92 looks the same on product photography. PNG is unaffected, and transparency is untouched in both formats, so a cut-out product keeps exactly the edge it had.

## 3.9.0 - 2026-09-29

**The Batch Cropper is now the Image Optimiser**

The Batch Cropper has become the Image Optimiser. It still trims the empty border off product photos, but cropping is now a switch, and turning it off leaves every pixel alone and converts the file only. A second switch picks the format: Product images (WebP) by default, or Page images (PNG) for the places that cannot take a WebP. Both are lossless and keep transparency, and WebP is far smaller.

## 3.8.1 - 2026-09-29

**The resizer says it is loading**

Choosing several large images left the Smart Resizer blank while they decoded. It now shows a progress panel counting the images as they arrive.

## 3.8.0 - 2026-09-29

**Choose what an adjustment touches**

The Smart Resizer's new Adjustments switch decides whether Fit, Fill, the scale slider and dragging move every loaded image together or only the one on screen, so a batch can be placed as a set or image by image. The choice is remembered.

## 3.7.0 - 2026-09-29

**Smart Resizer takes a batch**

The Smart Resizer now loads as many images as you give it. They share the canvas size and background, each keeps its own scale and position, every one is fitted as it loads, and the run downloads as a single ZIP. One image behaves exactly as before.

## 3.6.1 - 2026-09-22

**EOL reads as out of stock**

A stock column that marks a discontinued line EOL was counted as unreadable and skipped. EOL now joins the out-of-stock wordings, so those rows are written out as 9 the way אזל במלאי and לא זמין already were.

## 3.6.0 - 2026-09-17

**Headings stay with their text**

A supplier writes a feature block as one paragraph - a bold heading, a line break, then the text that belongs to it. The cleaner treated every break as a paragraph break, so the heading was torn off into its own paragraph and left floating above a gap, and the double breaks between blocks disappeared. A single break is now a line break inside the paragraph, keeping a heading and its text in one block; two or more end the paragraph and the extra ones stay as the blank lines they drew.

## 3.5.0 - 2026-09-17

**Blank lines survive the HTML Cleaner**

A description pasted as a bold header, text, an image or video and a blank line between them came out with the blank lines gone and the blocks packed together. A paragraph that was blank in the pasted text now stays a blank paragraph, keeping the spacing you had. Empty paragraphs the flattening itself leaves behind are still dropped, and spans are still removed everywhere.

## 3.4.1 - 2026-09-16

**Stock lists with no headings**

A list of barcodes beside a column of wordings, with no headings at all, failed in both stock modes. When nothing in the table scores as a heading, the columns are now chosen by what is in them instead: the one that reads as item codes, and the one whose wordings map to stock. Headings still win wherever they exist.

## 3.4.0 - 2026-09-15

**Stock values in the XLSX Fixer**

The Price XLSX Fixer is now the XLSX Fixer, and writes stock as well as prices. It can read a stock column - 'יש במלאי' and '3 יחידות' become 10, 'אין במלאי' and 'אזל במלאי' become 9 - or mark every item code in the file in stock or out of stock in one go. Uploading, dragging and pasting all work exactly as before.

## 3.3.2 - 2026-09-09

**Prices export as bare numbers**

A price copied out of Excel carried its currency sign into the output - '₪ 79' instead of 79. The shekel sign, spaces and thousands separators are now stripped, leaving the number on its own, still written as text.

## 3.3.1 - 2026-09-09

**Price header and pasted-table fixes**

The Price XLSX Fixer now accepts a price column whose heading simply names מחיר, such as 'עדוכן מחיר 10.9.26', instead of failing to find one. Pasted tables also keep their columns lined up: merged cells are no longer flattened, a header row sitting in its own table is found, cells holding more than one line no longer break the row apart, and editing a long paste no longer silently drops the rows below the preview.

## 3.3.0 - 2026-09-06

**Complete Hebrew translation**

The interface is now fully translated: over half of it was still appearing in English when Hebrew was selected, including the whole release history. Each language now lives in its own file, so adding another one is a single file plus a single line.

## 3.2.0 - 2026-09-06

**Background removal in the Batch Cropper**

The Batch Cropper can now cut the product out of its background, using a model that runs on your own computer. Nothing is uploaded and no graphics card is needed. It is off by default; turn it on with the Background control.

## 3.1.0 - 2026-09-06

**Wide-screen layout fixes**

The preferences popover no longer sits open and empty under the header, tool panels that should be hidden stay hidden, and the sidebar descriptions wrap instead of running over the panel beside them.

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

Ships in two editions, built from the same source:

- `index.html` — the hosted edition, which updates itself. Must be served over
  HTTP(S); browsers refuse to load ES modules and service workers from
  `file://`, so opening it from disk shows an explanation and points at the
  standalone build.
- `asset-manager.html` — one self-contained file that runs by double-clicking
  it, the direct descendant of `aio-2_4_1.html`. Generated by
  `tools/build-standalone.sh`. It cannot update itself, because a `file://` page
  may not overwrite itself on disk.

Both workers are started from a Blob, which is what lets the identical code path
run hosted and from disk — the same fix 2.0.2 made for the standalone build.

## 2.4.1

Earlier history is listed in the About tab and in
`assets/js/data/changelog.js`.
