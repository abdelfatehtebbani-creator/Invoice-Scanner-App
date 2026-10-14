// Generated from src/Shared.js by scripts/sync-shared.js. Do not edit.
/**
 * Shared logic used by BOTH the server (Apps Script) and the browser.
 *
 * The whole library lives inside one function and has no dependencies; it is
 * copied into the app by scripts/sync-shared.js (app/js/shared.js). Keep it dependency-free:
 * no Apps Script services may be used in here.
 */
function SharedLib_() {
  'use strict';

  var INVOICE_TYPES = ['purchase', 'sales', 'expense', 'payment'];

  var HEADER_FIELDS = [
    'type', 'invoiceNumber', 'date', 'partyName', 'partyTaxId', 'currency',
    'subtotal', 'discountTotal', 'taxTotal', 'total', 'amountPaid',
    'paymentMethod', 'notes'
  ];

  var NUMERIC_HEADER_FIELDS = ['subtotal', 'discountTotal', 'taxTotal', 'total', 'amountPaid'];

  var ITEM_FIELDS = [
    'description', 'quantity', 'unit', 'unitPrice', 'discount',
    'taxRate', 'taxAmount', 'lineTotal'
  ];

  var NUMERIC_ITEM_FIELDS = ['quantity', 'unitPrice', 'discount', 'taxRate', 'taxAmount', 'lineTotal'];

  /** Converts Arabic-Indic / Persian digits and Arabic separators to ASCII. */
  function normalizeDigits(s) {
    if (s === null || s === undefined) return '';
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0660 && c <= 0x0669) out += String.fromCharCode(48 + c - 0x0660);
      else if (c >= 0x06F0 && c <= 0x06F9) out += String.fromCharCode(48 + c - 0x06F0);
      else if (c === 0x066B) out += '.';          // Arabic decimal separator
      else if (c === 0x066C) out += ',';          // Arabic thousands separator
      else if (c === 0x200E || c === 0x200F || c === 0x061C || c === 0x202A ||
               c === 0x202B || c === 0x202C || c === 0x202D || c === 0x202E) continue;
      else if (c === 0x00A0 || c === 0x202F || c === 0x2009) out += ' ';
      else out += s.charAt(i);
    }
    return out;
  }

  /**
   * Parses a number written in any common convention:
   * 1,234.56 / 1.234,56 / 1 234,56 / 1234,5 / ١٢٣٤٫٥٦ / (12.00) / 12.00-
   * Returns null when the text holds no number.
   */
  function parseNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = normalizeDigits(v).trim();
    if (!/\d/.test(s)) return null;
    var negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /^−/.test(s);
    s = s.replace(/[^\d.,]/g, '');
    if (!s) return null;
    var lastDot = s.lastIndexOf('.');
    var lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) s = s.replace(/,/g, '');
      else s = s.replace(/\./g, '').replace(',', '.');
    } else if (lastComma >= 0) {
      var commas = s.split(',').length - 1;
      if (commas > 1 || /^\d{1,3},\d{3}$/.test(s)) s = s.replace(/,/g, '');
      else s = s.replace(',', '.');
    } else if (lastDot >= 0) {
      var dots = s.split('.').length - 1;
      if (dots > 1) s = s.replace(/\./g, '');
    }
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return negative ? -n : n;
  }

  function round2(n) {
    return n === null || n === undefined ? n : Math.round(n * 100) / 100;
  }

  function isNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /** Tolerance used when comparing amounts printed on an invoice. */
  function tolerance(amount) {
    return Math.max(0.05, Math.abs(amount || 0) * 0.005);
  }

  function near(a, b) {
    if (!isNum(a) || !isNum(b)) return false;
    return Math.abs(a - b) <= tolerance(Math.max(Math.abs(a), Math.abs(b)));
  }

  function sum(list) {
    var t = 0;
    for (var i = 0; i < list.length; i++) t += list[i];
    return t;
  }

  /** Expected total of one line from qty, price, discount and tax. */
  function computeLine(item) {
    var q = isNum(item.quantity) ? item.quantity : null;
    var p = isNum(item.unitPrice) ? item.unitPrice : null;
    if (q === null && p !== null) q = 1;
    if (q === null || p === null) return null;
    var gross = q * p;
    var disc = isNum(item.discount) ? item.discount : 0;
    return round2(gross - disc);
  }

  /** Coerces every numeric field of a draft from text to numbers. */
  function coerceDraft(draft) {
    var h = draft.header || {};
    NUMERIC_HEADER_FIELDS.forEach(function (f) { h[f] = parseNumber(h[f]); });
    draft.header = h;
    draft.items = (draft.items || []).map(function (it) {
      var o = {};
      ITEM_FIELDS.forEach(function (f) { o[f] = it[f]; });
      NUMERIC_ITEM_FIELDS.forEach(function (f) { o[f] = parseNumber(it[f]); });
      o.description = (o.description || '').toString().trim();
      o.unit = (o.unit || '').toString().trim();
      o.confidence = it.confidence || 'high';
      return o;
    }).filter(function (it) {
      return it.description || isNum(it.lineTotal) || isNum(it.unitPrice) || isNum(it.quantity);
    });
    return draft;
  }

  function isValidIsoDate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }

  /**
   * Checks a draft and returns the list of issues. Never mutates the draft
   * except to coerce numbers. Each issue: {level, code, field?, item?, params?}
   * level: 'error' (data is inconsistent or missing something essential)
   *        'warning' (uncertain value that a human should look at)
   */
  function validateDraft(draft, opts) {
    opts = opts || {};
    coerceDraft(draft);
    var h = draft.header;
    var items = draft.items;
    var conf = draft.confidence || {};
    var issues = [];
    function add(level, code, extra) {
      var o = { level: level, code: code };
      for (var k in extra) o[k] = extra[k];
      issues.push(o);
    }

    if (INVOICE_TYPES.indexOf(h.type) < 0) add('error', 'type_missing', { field: 'type' });
    if (!h.date) add('error', 'missing', { field: 'date' });
    else if (!isValidIsoDate(h.date)) add('error', 'date_invalid', { field: 'date' });
    else {
      var today = opts.today || new Date().toISOString().slice(0, 10);
      if (h.date > today) add('warning', 'date_future', { field: 'date' });
      if (h.date < '2000-01-01') add('warning', 'date_old', { field: 'date' });
    }
    if (!h.partyName) add('error', 'missing', { field: 'partyName' });
    if (!isNum(h.total)) add('error', 'missing', { field: 'total' });
    if (!h.invoiceNumber && (h.type === 'purchase' || h.type === 'sales')) {
      add('warning', 'missing', { field: 'invoiceNumber' });
    }
    if (!h.currency) add('warning', 'missing', { field: 'currency' });
    if (isNum(h.total) && h.total < 0) add('warning', 'negative_total', { field: 'total' });

    // Fields the extractor was not sure about stay flagged until the user edits them.
    Object.keys(conf).forEach(function (f) {
      if (conf[f] === 'low' && h[f] !== null && h[f] !== undefined && h[f] !== '') {
        add('warning', 'uncertain', { field: f });
      }
    });

    // Line-level checks.
    var lineTotals = [];
    var allLinesHaveTotal = items.length > 0;
    items.forEach(function (it, i) {
      if (!it.description) add('warning', 'item_no_description', { item: i, field: 'description' });
      if (it.confidence === 'low') add('warning', 'item_uncertain', { item: i });
      var expected = computeLine(it);
      if (isNum(it.lineTotal)) {
        lineTotals.push(it.lineTotal);
        if (expected !== null && !near(expected, it.lineTotal)) {
          // Some invoices print line totals including the line's tax.
          var withTax = isNum(it.taxAmount) ? expected + it.taxAmount :
            (isNum(it.taxRate) ? expected * (1 + it.taxRate / 100) : null);
          if (!(withTax !== null && near(withTax, it.lineTotal))) {
            add('error', 'item_total_mismatch', {
              item: i, field: 'lineTotal',
              params: { expected: round2(expected), printed: it.lineTotal }
            });
          }
        }
      } else {
        allLinesHaveTotal = false;
        if (expected === null) add('error', 'item_no_amount', { item: i, field: 'lineTotal' });
      }
      if (isNum(it.taxRate) && (it.taxRate < 0 || it.taxRate > 100)) {
        add('error', 'tax_rate_invalid', { item: i, field: 'taxRate' });
      }
      if (isNum(it.taxRate) && isNum(it.taxAmount) && expected !== null && it.taxRate > 0) {
        var expTax = expected * it.taxRate / 100;
        if (!near(expTax, it.taxAmount)) {
          add('warning', 'item_tax_mismatch', {
            item: i, field: 'taxAmount', params: { expected: round2(expTax), printed: it.taxAmount }
          });
        }
      }
    });

    var itemsSum = allLinesHaveTotal ? round2(sum(lineTotals)) : null;
    var itemTax = items.filter(function (it) { return isNum(it.taxAmount); })
      .map(function (it) { return it.taxAmount; });
    var itemTaxSum = itemTax.length ? round2(sum(itemTax)) : null;
    var disc = isNum(h.discountTotal) ? h.discountTotal : 0;
    var tax = isNum(h.taxTotal) ? h.taxTotal : 0;

    // Items vs. printed subtotal / total.
    if (itemsSum !== null) {
      if (isNum(h.subtotal)) {
        if (!near(itemsSum, h.subtotal) && !near(itemsSum - disc, h.subtotal) &&
            !near(itemsSum, h.subtotal + tax)) {
          add('error', 'items_vs_subtotal', {
            field: 'subtotal', params: { expected: itemsSum, printed: h.subtotal }
          });
        }
      } else if (isNum(h.total)) {
        var candidates = [itemsSum, itemsSum - disc, itemsSum + tax, itemsSum - disc + tax];
        if (!candidates.some(function (c) { return near(c, h.total); })) {
          add('error', 'items_vs_total', {
            field: 'total', params: { expected: itemsSum, printed: h.total }
          });
        }
      }
    }

    // Header arithmetic: subtotal - discount + tax = total.
    if (isNum(h.subtotal) && isNum(h.total)) {
      var options = [h.subtotal - disc + tax, h.subtotal + tax, h.subtotal - disc];
      if (!options.some(function (c) { return near(c, h.total); })) {
        add('error', 'totals_mismatch', {
          field: 'total', params: { expected: round2(h.subtotal - disc + tax), printed: h.total }
        });
      }
    }
    if (itemTaxSum !== null && isNum(h.taxTotal) && !near(itemTaxSum, h.taxTotal)) {
      add('warning', 'tax_sum_mismatch', {
        field: 'taxTotal', params: { expected: itemTaxSum, printed: h.taxTotal }
      });
    }
    if (isNum(h.amountPaid) && isNum(h.total) && h.amountPaid - h.total > tolerance(h.total)) {
      add('warning', 'paid_exceeds_total', { field: 'amountPaid' });
    }
    if (!items.length && (h.type === 'purchase' || h.type === 'sales')) {
      add('warning', 'no_items', {});
    }

    return {
      issues: issues,
      errors: issues.filter(function (x) { return x.level === 'error'; }).length,
      warnings: issues.filter(function (x) { return x.level === 'warning'; }).length,
      computed: { itemsSum: itemsSum, itemTaxSum: itemTaxSum }
    };
  }

  function normalizeKeyPart(s) {
    return normalizeDigits(s || '').toLowerCase().replace(/[\s\-_.\/#:°]+/g, '').trim();
  }

  /** Key used to recognise the same invoice saved twice. */
  function businessKey(h) {
    return [
      h.type || '', normalizeKeyPart(h.partyName), normalizeKeyPart(h.invoiceNumber),
      h.date || '', isNum(h.total) ? h.total.toFixed(2) : ''
    ].join('|');
  }

  return {
    INVOICE_TYPES: INVOICE_TYPES,
    HEADER_FIELDS: HEADER_FIELDS,
    NUMERIC_HEADER_FIELDS: NUMERIC_HEADER_FIELDS,
    ITEM_FIELDS: ITEM_FIELDS,
    NUMERIC_ITEM_FIELDS: NUMERIC_ITEM_FIELDS,
    normalizeDigits: normalizeDigits,
    parseNumber: parseNumber,
    round2: round2,
    isNum: isNum,
    near: near,
    computeLine: computeLine,
    coerceDraft: coerceDraft,
    isValidIsoDate: isValidIsoDate,
    validateDraft: validateDraft,
    normalizeKeyPart: normalizeKeyPart,
    businessKey: businessKey
  };
}

var Shared = SharedLib_();
