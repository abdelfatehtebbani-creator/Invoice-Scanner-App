/**
 * Reading and writing the three sheets. Columns are looked up by header name,
 * so reordering columns in the spreadsheet does not break the app.
 */

function sheetOf_(def) {
  var ss = ensureSetup_().spreadsheet;
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) sheet = ensureSheet_(ss, def, []);
  return sheet;
}

function readTable_(def) {
  var sheet = sheetOf_(def);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  return { sheet: sheet, headers: headers, idx: idx, rows: rows };
}

function rowToObject_(table, row) {
  var o = {};
  table.headers.forEach(function (h, i) { o[h] = row[i]; });
  return o;
}

function objectToRow_(headers, obj) {
  return headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
}

/** Writes rows at the end of a sheet, keeping ID-like columns as plain text. */
function appendObjects_(def, objects) {
  if (!objects.length) return;
  var sheet = sheetOf_(def);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  var start = sheet.getLastRow() + 1;
  var values = objects.map(function (o) { return objectToRow_(headers, o); });
  formatRange_(sheet, def, headers, start, values.length);
  sheet.getRange(start, 1, values.length, headers.length).setValues(values);
}

function formatRange_(sheet, def, headers, startRow, numRows) {
  headers.forEach(function (h, i) {
    var r = sheet.getRange(startRow, i + 1, numRows, 1);
    if (def.textColumns.indexOf(h) >= 0) r.setNumberFormat('@');
    else if (def.dateColumns.indexOf(h) >= 0) r.setNumberFormat('yyyy-mm-dd');
    else if (def.timestampColumns.indexOf(h) >= 0) r.setNumberFormat('yyyy-mm-dd hh:mm:ss');
    else if (def.moneyColumns.indexOf(h) >= 0) r.setNumberFormat('#,##0.00');
  });
}

function tz_() {
  return Session.getScriptTimeZone() || 'Etc/UTC';
}

function isoToDate_(iso) {
  if (!Shared.isValidIsoDate(iso)) return '';
  var p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
}

function cellToIso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  var s = String(v || '');
  return Shared.isValidIsoDate(s) ? s : s.slice(0, 10);
}

function cellToTimestamp_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), "yyyy-MM-dd'T'HH:mm:ss");
  return String(v || '');
}

function numOrNull_(v) {
  return v === '' || v === null || v === undefined ? null : Shared.parseNumber(v);
}

/** Appends one line to ProcessingLog. Never throws: logging must not break saving. */
function logEvent_(e) {
  try {
    appendObjects_(SHEETS.LOG, [{
      Timestamp: new Date(),
      RequestID: e.requestId || '',
      Stage: e.stage || '',
      Status: e.status || '',
      InvoiceID: e.invoiceId || '',
      ImageFileID: e.imageFileId || '',
      ImageHash: e.imageHash || '',
      Engine: e.engine || '',
      DurationMs: e.durationMs || '',
      Message: String(e.message || '').slice(0, 2000)
    }]);
  } catch (err) {
    console.error('Could not write to ProcessingLog: ' + err.message);
  }
}

/** Returns the InvoiceID a request already saved, if any (repeat clicks, retries). */
function findSavedRequest_(requestId) {
  if (!requestId) return null;
  var cached = CacheService.getScriptCache().get('save:' + requestId);
  if (cached) return cached;
  var t = readTable_(SHEETS.LOG);
  for (var i = t.rows.length - 1; i >= 0; i--) {
    var r = t.rows[i];
    if (String(r[t.idx.RequestID]) === requestId && r[t.idx.Stage] === 'save' && r[t.idx.Status] === 'OK') {
      return String(r[t.idx.InvoiceID]);
    }
  }
  return null;
}

/**
 * Looks for invoices that are probably the same document: same image bytes,
 * same business key, or same party + invoice number.
 */
function findDuplicates_(opts) {
  var t = readTable_(SHEETS.INVOICES);
  var out = [];
  var h = opts.header;
  var key = h ? Shared.businessKey(h) : null;
  var party = h ? Shared.normalizeKeyPart(h.partyName) : '';
  var number = h ? Shared.normalizeKeyPart(h.invoiceNumber) : '';
  t.rows.forEach(function (r) {
    var id = String(r[t.idx.InvoiceID]);
    if (!id || id === opts.excludeId) return;
    var reason = null;
    if (opts.imageHash && String(r[t.idx.ImageHash]) === opts.imageHash) reason = 'same_image';
    else if (key && String(r[t.idx.BusinessKey]) === key) reason = 'same_details';
    else if (number && party && Shared.normalizeKeyPart(r[t.idx.InvoiceNumber]) === number &&
             Shared.normalizeKeyPart(r[t.idx.PartyName]) === party) reason = 'same_number';
    if (reason) {
      out.push({
        invoiceId: id, reason: reason, invoiceNumber: String(r[t.idx.InvoiceNumber]),
        partyName: String(r[t.idx.PartyName]), date: cellToIso_(r[t.idx.InvoiceDate]),
        total: numOrNull_(r[t.idx.Total]), currency: String(r[t.idx.Currency])
      });
    }
  });
  return out;
}

function newInvoiceId_() {
  var stamp = Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd');
  var rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return 'INV-' + stamp + '-' + rand;
}

/** Writes an invoice and its items, replacing previous rows when editing. */
function writeInvoice_(invoiceId, record, items, isUpdate) {
  var now = new Date();
  var invTable = readTable_(SHEETS.INVOICES);
  var rowIndex = -1;
  if (isUpdate) {
    for (var i = 0; i < invTable.rows.length; i++) {
      if (String(invTable.rows[i][invTable.idx.InvoiceID]) === invoiceId) { rowIndex = i; break; }
    }
    if (rowIndex < 0) throw new Error('Invoice ' + invoiceId + ' was not found.');
    record.CreatedAt = invTable.rows[rowIndex][invTable.idx.CreatedAt] || now;
  } else {
    record.CreatedAt = now;
  }
  record.InvoiceID = invoiceId;
  record.UpdatedAt = now;

  if (rowIndex >= 0) {
    var sheetRow = rowIndex + 2;
    formatRange_(invTable.sheet, SHEETS.INVOICES, invTable.headers, sheetRow, 1);
    invTable.sheet.getRange(sheetRow, 1, 1, invTable.headers.length)
      .setValues([objectToRow_(invTable.headers, record)]);
    deleteItemRows_(invoiceId);
  } else {
    appendObjects_(SHEETS.INVOICES, [record]);
  }
  appendObjects_(SHEETS.ITEMS, items.map(function (it, n) {
    var lineNo = n + 1;
    return {
      ItemID: invoiceId + '-' + (lineNo < 10 ? '0' : '') + lineNo,
      InvoiceID: invoiceId,
      LineNo: lineNo,
      Description: it.description,
      Quantity: it.quantity,
      Unit: it.unit,
      UnitPrice: it.unitPrice,
      Discount: it.discount,
      TaxRate: it.taxRate,
      TaxAmount: it.taxAmount,
      LineTotal: it.lineTotal,
      CalculatedTotal: Shared.computeLine(it),
      Confidence: it.confidence || '',
      Flags: (it.flags || []).join(', ')
    };
  }));
}

function deleteItemRows_(invoiceId) {
  var t = readTable_(SHEETS.ITEMS);
  // Delete bottom-up in contiguous blocks so row numbers stay valid.
  var i = t.rows.length - 1;
  while (i >= 0) {
    if (String(t.rows[i][t.idx.InvoiceID]) !== invoiceId) { i--; continue; }
    var end = i;
    while (i - 1 >= 0 && String(t.rows[i - 1][t.idx.InvoiceID]) === invoiceId) i--;
    t.sheet.deleteRows(i + 2, end - i + 1);
    i--;
  }
}

function invoiceSummary_(t, r) {
  return {
    invoiceId: String(r[t.idx.InvoiceID]),
    type: String(r[t.idx.Type]),
    invoiceNumber: String(r[t.idx.InvoiceNumber]),
    date: cellToIso_(r[t.idx.InvoiceDate]),
    partyName: String(r[t.idx.PartyName]),
    currency: String(r[t.idx.Currency]),
    total: numOrNull_(r[t.idx.Total]),
    itemCount: numOrNull_(r[t.idx.ItemCount]),
    reviewStatus: String(r[t.idx.ReviewStatus]),
    processingStatus: String(r[t.idx.ProcessingStatus]),
    createdAt: cellToTimestamp_(r[t.idx.CreatedAt])
  };
}

function listInvoices_(f) {
  f = f || {};
  var t = readTable_(SHEETS.INVOICES);
  var q = Shared.normalizeDigits(f.q || '').toLowerCase().trim();
  var list = t.rows.filter(function (r) { return r[t.idx.InvoiceID]; }).map(function (r) {
    var s = invoiceSummary_(t, r);
    s._search = [s.invoiceId, s.invoiceNumber, s.partyName, s.currency, String(r[t.idx.PartyTaxID]),
      String(r[t.idx.Notes])].join(' ').toLowerCase();
    return s;
  }).filter(function (s) {
    if (f.type && s.type !== f.type) return false;
    if (f.status && s.reviewStatus !== f.status) return false;
    if (f.from && s.date < f.from) return false;
    if (f.to && s.date > f.to) return false;
    if (q && s._search.indexOf(q) < 0) return false;
    return true;
  });
  list.sort(function (a, b) {
    return (b.date + b.createdAt).localeCompare(a.date + a.createdAt);
  });
  var total = list.length;
  list = list.slice(0, f.limit || 200).map(function (s) { delete s._search; return s; });
  return { invoices: list, total: total };
}

function getInvoice_(invoiceId) {
  var t = readTable_(SHEETS.INVOICES);
  var row = null;
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][t.idx.InvoiceID]) === invoiceId) { row = t.rows[i]; break; }
  }
  if (!row) throw new Error('Invoice not found: ' + invoiceId);
  var o = rowToObject_(t, row);
  var header = {
    type: String(o.Type), invoiceNumber: String(o.InvoiceNumber), date: cellToIso_(o.InvoiceDate),
    partyName: String(o.PartyName), partyTaxId: String(o.PartyTaxID), currency: String(o.Currency),
    subtotal: numOrNull_(o.Subtotal), discountTotal: numOrNull_(o.DiscountTotal),
    taxTotal: numOrNull_(o.TaxTotal), total: numOrNull_(o.Total), amountPaid: numOrNull_(o.AmountPaid),
    paymentMethod: String(o.PaymentMethod), notes: String(o.Notes)
  };
  var it = readTable_(SHEETS.ITEMS);
  var items = it.rows.filter(function (r) { return String(r[it.idx.InvoiceID]) === invoiceId; })
    .sort(function (a, b) { return a[it.idx.LineNo] - b[it.idx.LineNo]; })
    .map(function (r) {
      return {
        description: String(r[it.idx.Description]), quantity: numOrNull_(r[it.idx.Quantity]),
        unit: String(r[it.idx.Unit]), unitPrice: numOrNull_(r[it.idx.UnitPrice]),
        discount: numOrNull_(r[it.idx.Discount]), taxRate: numOrNull_(r[it.idx.TaxRate]),
        taxAmount: numOrNull_(r[it.idx.TaxAmount]), lineTotal: numOrNull_(r[it.idx.LineTotal]),
        confidence: String(r[it.idx.Confidence] || 'high')
      };
    });
  var issues = [];
  try { issues = JSON.parse(o.Issues || '[]'); } catch (e) { issues = []; }
  return {
    invoiceId: invoiceId,
    header: header,
    items: items,
    issues: issues,
    uncertainFields: String(o.UncertainFields || '').split(/,\s*/).filter(String),
    reviewStatus: String(o.ReviewStatus),
    processingStatus: String(o.ProcessingStatus),
    engine: String(o.OcrEngine),
    imageFileId: String(o.ImageFileID),
    imageUrl: String(o.ImageURL),
    createdAt: cellToTimestamp_(o.CreatedAt),
    updatedAt: cellToTimestamp_(o.UpdatedAt)
  };
}
