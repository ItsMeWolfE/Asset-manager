// Stock processor - the second half of the spreadsheet worker.
//
// It is appended to the SheetJS bundle rather than spliced into it: the Dragon
// and Price logic inside that bundle stays byte-for-byte what 2.4.1 shipped,
// and the only change made to it is the `self.__sheet` hook at its tail, which
// hands out the helpers below. Everything here runs in the same worker scope.
//
// `String.raw` so the regular expressions read as they would anywhere else -
// an ordinary template literal would need every backslash doubled.
export const STOCK_WORKER_SRC = String.raw`
(function () {
  "use strict";

  var api = self.__sheet;
  if (!api) return;

  var utils = api.utils;
  var readWorkbook = api.readWorkbook;
  var gridWorkbook = api.gridWorkbook;
  var twoColumnSheet = api.twoColumnSheet;
  var writeWorkbook = api.write;
  var normalize = api.normalize;
  var cellText = api.cellText;
  var displayed = api.displayed;
  var scoreItem = api.scoreItem;

  // The two values the import understands. They are written as text, like the
  // price output, so nothing downstream re-reads them as something else.
  var IN_STOCK = "10";
  var OUT_OF_STOCK = "9";

  /**
   * Score a header as a stock column, in the same shape as the price fixer's
   * scoring: the highest score wins, -1 means "not a stock column". The text
   * arrives normalized - lowercased, punctuation flattened, quotes dropped.
   */
  function scoreStockHeader(text) {
    if (!text || text.includes("ספק") || text.includes("יצרן")) return -1;

    var tight = text.replace(/\s/g, "");

    if (tight === "מלאי" || tight === "זמינות") return 120;
    if (tight === "כמותבמלאי" || tight === "יתרתמלאי" || tight === "מצבמלאי" || tight === "סטטוסמלאי") return 116;
    if (text.includes("במלאי")) return 112;
    if (text.includes("מלאי")) return 105;
    if (text.includes("זמינ")) return 100;
    if (tight === "stock" || text.includes("in stock") || text.includes("stock status")) return 98;
    if (text.includes("availab")) return 96;
    if (text.includes("stock")) return 90;
    if (text.includes("כמות") || text.includes("יחיד")) return 80;
    if (text.includes("qty") || text.includes("quantity")) return 78;
    return -1;
  }

  // Out-of-stock wordings are tested first, and have to be: every one of them
  // contains an in-stock wording inside it - "אין במלאי" holds "במלאי" - and
  // never the other way round. Whole words only, because "מלאי" itself ends in
  // the letters of "לא".
  // "EOL" is a whole word on its own terms - \b rather than the spaces the
  // Hebrew wordings need - so a product called "Neolithic" is not read as one.
  var OUT_PHRASES = /(out of stock|sold out|not available|unavailable|back ?order|on order|discontinued|\beol\b)/;
  var OUT_WORDS = /(^|\s)(אין|אינו|אינה|איננו|חסר|חסרה|חסרים|אזל|אזלה|אזלו|נגמר|נגמרה|נגמרו|ללא|לא|no|not|out|none|false|zero)(\s|$)/;
  var IN_PHRASES = /(in stock|on hand|instock)/;
  var IN_WORDS = /(^|\s)(יש|קיים|קיימת|קיימים|נמצא|נמצאת|נמצאים|במלאי|מלאי|זמין|זמינה|זמינים|במחסן|yes|true|available)(\s|$)/;
  var QUANTITY = /-?\d+(?:[.,]\d+)?/;

  /**
   * One cell of a stock column to "10", "9", or null for "no idea" - which is
   * reported and skipped rather than guessed at, so a wording nobody thought
   * of never quietly marks a product out of stock.
   */
  function stockValue(raw) {
    var text = normalize(raw);
    if (!text) return null;

    if (OUT_PHRASES.test(text) || OUT_WORDS.test(text)) return OUT_OF_STOCK;

    // "3 יחידות", "12 יח", or a bare count: how many there are answers the
    // question on its own, and zero of them answers it the other way.
    var quantity = text.match(QUANTITY);
    if (quantity) {
      var amount = Number(quantity[0].replace(",", "."));
      if (Number.isFinite(amount)) return amount > 0 ? IN_STOCK : OUT_OF_STOCK;
    }

    if (IN_PHRASES.test(text) || IN_WORDS.test(text)) return IN_STOCK;
    return null;
  }

  // As deep into a sheet as a header row is looked for, matching the price
  // fixer. Past that it is data, however much it looks like a heading.
  var HEADER_SCAN_ROWS = 250;

  /**
   * Find the row that best pairs an item-code column with a stock column, the
   * way the price fixer pairs item with price. Called without a scoreSecond
   * only the item column matters, which is what stamping every row needs.
   */
  function findColumns(workbook, scoreSecond) {
    var best = null;

    workbook.SheetNames.forEach(function (name, sheetIndex) {
      var sheet = workbook.Sheets[name];
      if (!sheet || !sheet["!ref"]) return;

      var range = utils.decode_range(sheet["!ref"]);
      var lastRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1);

      for (var row = range.s.r; row <= lastRow; row += 1) {
        var item = null;
        var seconds = [];

        for (var column = range.s.c; column <= range.e.c; column += 1) {
          var original = String(displayed(sheet[utils.encode_cell({ r: row, c: column })]) || "").trim();
          if (!original) continue;

          var normalized = normalize(original);

          var itemScore = scoreItem(normalized);
          if (itemScore >= 0 && (!item || itemScore > item.score)) {
            item = { colIndex: column, score: itemScore, original: original, normalized: normalized };
          }

          if (!scoreSecond) continue;
          var score = scoreSecond(normalized);
          if (score >= 0) seconds.push({ colIndex: column, score: score, original: original, normalized: normalized });
        }

        if (!item) continue;
        if (scoreSecond && !seconds.length) continue;

        seconds.sort(function (a, b) { return b.score - a.score || b.colIndex - a.colIndex; });

        // The price fixer's tie-break: of two rows that score the same, the one
        // nearer the top of the sheet is the header and the other is data.
        var pairScore = item.score + (seconds[0] ? seconds[0].score : 0) - Math.min(row - range.s.r, 40) * 0.05;

        if (!best || pairScore > best.pairScore || (pairScore === best.pairScore && sheetIndex < best.sheetIndex)) {
          best = {
            sheetName: name, sheetIndex: sheetIndex, worksheet: sheet, range: range, headerRow: row,
            item: item, stock: seconds[0] || null, stockCandidates: seconds, pairScore: pairScore,
          };
        }
      }
    });

    return best;
  }

  /**
   * Does this read as an item code rather than as a name or a wording? The
   * rule is the Dragon fixer's, which has judged barcodes this way since
   * 2.4.1: it has to carry a digit and no Hebrew.
   */
  function looksLikeCode(text) {
    if (!text || text.length < 3) return false;
    if (/[֐-׿؀-ۿ]/.test(text)) return false;
    return /\d/.test(text);
  }

  // How much of a column has to read as codes, or as stock wordings, before it
  // is taken for that column. Below this the table is left alone rather than
  // guessed at.
  var CONFIDENT = 0.6;

  /**
   * Columns for a table with no headings at all - a list of barcodes and a
   * column of wordings, pasted straight out of somewhere. Nothing scores as a
   * header in that case, so each column is judged by what is in it: the one
   * that reads as item codes, and the one whose wordings map to stock.
   */
  function findColumnsByContent(workbook, wantStock) {
    var best = null;

    workbook.SheetNames.forEach(function (name, sheetIndex) {
      var sheet = workbook.Sheets[name];
      if (!sheet || !sheet["!ref"]) return;

      var range = utils.decode_range(sheet["!ref"]);
      var lastRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1);
      var columns = [];

      for (var column = range.s.c; column <= range.e.c; column += 1) {
        var filled = 0;
        var codes = 0;
        var stocks = 0;
        var width = 0;

        for (var row = range.s.r; row <= lastRow; row += 1) {
          var text = cellText(sheet[utils.encode_cell({ r: row, c: column })], "scan").trim();
          if (!text) continue;
          filled += 1;
          width += text.length;
          if (looksLikeCode(text)) codes += 1;
          if (stockValue(text)) stocks += 1;
        }

        if (filled) {
          columns.push({
            colIndex: column, filled: filled,
            code: codes / filled, stock: stocks / filled, width: width / filled,
          });
        }
      }

      var item = null;
      columns.forEach(function (column) {
        if (column.code < CONFIDENT) return;
        // Two columns of digits - a code and a price, say - are told apart by
        // length: a barcode is the longer of the two.
        if (!item || column.code > item.code || (column.code === item.code && column.width > item.width)) item = column;
      });
      if (!item) return;

      var stock = null;
      if (wantStock) {
        columns.forEach(function (column) {
          if (column.colIndex === item.colIndex || column.stock < CONFIDENT) return;
          // A column of plain numbers reads as a count, so a price column
          // qualifies as readily as a quantity does. Where both are on offer,
          // the one written in words is the one that meant stock.
          if (!stock || column.stock > stock.stock
            || (column.stock === stock.stock && column.code < stock.code)) stock = column;
        });
        if (!stock) return;
      }

      var usable = Math.min(item.filled, stock ? stock.filled : item.filled);
      if (best && usable <= best.usable) return;

      best = {
        sheetName: name, sheetIndex: sheetIndex, worksheet: sheet, range: range,
        // One before the first row of data, so the caller's loop starts on it.
        headerRow: range.s.r - 1,
        headerless: true,
        usable: usable,
        item: { colIndex: item.colIndex, original: utils.encode_col(item.colIndex), normalized: null },
        stock: stock ? { colIndex: stock.colIndex, original: utils.encode_col(stock.colIndex), normalized: null } : null,
        stockCandidates: [],
      };
    });

    return best;
  }

  // How many distinct unreadable stock values are carried back for the log.
  var UNKNOWN_SAMPLES = 3;

  function processStock(workbook, baseName, options) {
    var detect = options.mode === "detect";
    var found = findColumns(workbook, detect ? scoreStockHeader : null)
      || findColumnsByContent(workbook, detect);

    if (!found) {
      throw new Error(detect
        ? "Could not find a product item-code column together with a stock column, by heading or by content. Fields containing 'ספק' or 'יצרן' are ignored."
        : "Could not find a product item-code column, by heading or by content. Fields containing 'ספק' or 'יצרן' are ignored.");
    }

    var fixed = options.value === OUT_OF_STOCK ? OUT_OF_STOCK : IN_STOCK;
    var rows = [];
    var unknownSamples = [];
    var skippedBlank = 0;
    var skippedUnknown = 0;
    var unsafeNumericItems = 0;

    for (var row = found.headerRow + 1; row <= found.range.e.r; row += 1) {
      var itemCell = found.worksheet[utils.encode_cell({ r: row, c: found.item.colIndex })];
      var item = cellText(itemCell, "item").trim();
      var stockText = detect
        ? cellText(found.worksheet[utils.encode_cell({ r: row, c: found.stock.colIndex })], "stock").trim()
        : "";

      // A file that repeats its own headings partway down is not describing a
      // product on that row. With no headings there is nothing to repeat, and
      // a row is kept only while its code still reads as one - which is what
      // drops a stray note, or a heading nobody scored, out of the middle of
      // an otherwise headerless list.
      if (found.headerless) {
        if (item && !looksLikeCode(item)) continue;
      } else if (normalize(item) === found.item.normalized && (!detect || normalize(stockText) === found.stock.normalized)) {
        continue;
      }

      if (!item) {
        if (detect && stockText) skippedBlank += 1;
        continue;
      }

      var value = fixed;

      if (detect) {
        if (!stockText) { skippedBlank += 1; continue; }
        value = stockValue(stockText);
        if (!value) {
          skippedUnknown += 1;
          if (unknownSamples.length < UNKNOWN_SAMPLES && unknownSamples.indexOf(stockText) === -1) unknownSamples.push(stockText);
          continue;
        }
      }

      // Excel stores a long numeric code as a float and rounds it on the way
      // in; the price fixer reports that and so does this.
      if (itemCell && typeof itemCell.v === "number" && (!Number.isSafeInteger(itemCell.v) || Math.abs(itemCell.v) >= 1e15)) {
        unsafeNumericItems += 1;
      }

      rows.push([item, value]);
    }

    if (!rows.length) {
      throw new Error(detect
        ? "The matching columns were found, but no row held both an item code and a stock value that could be read."
        : "The item-code column was found, but no row under it held an item code.");
    }

    var book = utils.book_new();
    utils.book_append_sheet(book, twoColumnSheet(rows), "Stock");
    var buffer = writeWorkbook(book, { type: "array", bookType: "xlsx", compression: true, cellStyles: true });
    var safeName = String(baseName || "stock").replace(/[\\/:*?"<>|]+/g, "_").trim() || "stock";

    return {
      buffer: buffer,
      filename: safeName + "_stock_fixed.xlsx",
      count: rows.length,
      mode: detect ? "detect" : "all",
      value: detect ? null : fixed,
      sheetName: found.sheetName,
      headerless: Boolean(found.headerless),
      headerRow: found.headerRow + 1,
      itemHeader: found.item.original,
      stockHeader: detect ? found.stock.original : null,
      alternativeStock: detect ? found.stockCandidates.length - 1 : 0,
      skippedBlank: skippedBlank,
      skippedUnknown: skippedUnknown,
      unknownSamples: unknownSamples,
      unsafeNumericItems: unsafeNumericItems,
    };
  }

  // Anything that is not a stock job goes to the handler the bundle installed,
  // untouched.
  var base = self.onmessage;

  self.onmessage = function (event) {
    var data = event && event.data;
    if (!data || data.tool !== "stock") { base(event); return; }

    try {
      self.postMessage({ type: "progress", progress: 15, status: "Reading spreadsheet" });
      var workbook = data.kind === "file" ? readWorkbook(data.buffer) : gridWorkbook(data.grid || []);

      self.postMessage({
        type: "progress", progress: 48,
        status: data.mode === "detect" ? "Finding item and stock columns" : "Finding the item-code column",
      });
      var result = processStock(workbook, data.baseName, data);

      self.postMessage({ type: "progress", progress: 82, status: "Building text-formatted XLSX" });
      self.postMessage(Object.assign({ type: "success" }, result), [result.buffer]);
    } catch (error) {
      self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
})();
`;
