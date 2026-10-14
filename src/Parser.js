/**
 * Turns raw OCR text (Arabic, English or French) into a structured draft:
 * header fields, line items and a confidence level for every field.
 *
 * This is the free fallback engine used with Google Drive OCR, which returns
 * text without table structure. The parser therefore rebuilds the item table
 * from the text and marks every guess as low confidence.
 */

var PARSER_KEYWORDS_ = {
  itemHeader: [
    'description', 'designation', 'désignation', 'article', 'item', 'items', 'produit', 'libellé',
    'libelle', 'product', 'البيان', 'الصنف', 'المادة', 'الوصف', 'المنتج', 'السلعة', 'التفاصيل',
    'qty', 'qte', 'qté', 'quantité', 'quantite', 'quantity', 'الكمية', 'العدد',
    'unit price', 'price', 'prix', 'p.u', 'pu', 'السعر', 'سعر الوحدة', 'الثمن',
    'amount', 'montant', 'total', 'المبلغ', 'المجموع', 'القيمة'
  ],
  subtotal: [
    'sub total', 'sub-total', 'subtotal', 'sous-total', 'sous total', 'total ht', 'montant ht',
    'total hors taxe', 'total hors taxes', 'net ht', 'المجموع الفرعي', 'الإجمالي قبل الضريبة',
    'المبلغ قبل الضريبة', 'المجموع قبل الضريبة', 'الاجمالي قبل الضريبة', 'المبلغ الصافي قبل'
  ],
  tax: [
    'vat', 'tax', 'tva', 't.v.a', 'taxe', 'gst', 'ضريبة', 'الضريبة', 'القيمة المضافة', 'ض.ق.م', 'رسم'
  ],
  discount: ['discount', 'remise', 'rabais', 'réduction', 'reduction', 'خصم', 'الخصم', 'تخفيض', 'تنزيل'],
  paid: [
    'amount paid', 'paid', 'payé', 'paye', 'versé', 'verse', 'versement', 'cash', 'espèces', 'especes',
    'المدفوع', 'المبلغ المدفوع', 'نقدا', 'نقداً', 'مدفوع'
  ],
  change: ['change', 'rendu', 'monnaie', 'الباقي', 'المتبقي', 'الصرف'],
  total: [
    'grand total', 'total ttc', 'net à payer', 'net a payer', 'montant ttc', 'total due', 'amount due',
    'total amount', 'balance due', 'total à payer', 'total a payer', 'المبلغ الإجمالي', 'الإجمالي',
    'الاجمالي', 'المجموع الكلي', 'المجموع', 'صافي المبلغ', 'الصافي', 'المبلغ المستحق', 'إجمالي',
    'اجمالي', 'المطلوب', 'total', 'montant'
  ],
  invoiceNo: [
    'invoice no', 'invoice number', 'invoice #', 'invoice n', 'inv no', 'inv #', 'facture n',
    'facture no', 'n° facture', 'no facture', 'numéro', 'numero', 'bill no', 'receipt no', 'reçu n',
    'ticket n', 'bon n', 'receipt #', 'receipt number', 'ticket #', 'order #', 'order no', 'رقم الفاتورة', 'فاتورة رقم', 'رقم الإيصال', 'رقم الوصل', 'رقم السند', 'رقم', 'invoice', 'receipt', 'facture'
  ],
  date: ['date', 'dated', 'le ', 'تاريخ', 'التاريخ', 'بتاريخ'],
  supplier: [
    'supplier', 'vendor', 'seller', 'from', 'fournisseur', 'vendeur', 'émetteur', 'المورد', 'البائع',
    'اسم المورد', 'المؤسسة', 'الشركة'
  ],
  customer: [
    'customer', 'client', 'bill to', 'billed to', 'sold to', 'buyer', 'acheteur', 'العميل', 'الزبون',
    'المشتري', 'السيد', 'السادة', 'اسم العميل'
  ],
  taxId: [
    'vat no', 'vat number', 'tax id', 'trn', 'nif', 'n.i.f', 'nis', 'rc', 'r.c', 'ice', 'siret',
    'الرقم الضريبي', 'رقم التعريف الجبائي', 'السجل التجاري', 'رقم السجل'
  ],
  paymentMethod: {
    cash: ['cash', 'espèces', 'especes', 'نقدا', 'نقداً', 'كاش'],
    card: ['card', 'carte', 'visa', 'mastercard', 'cib', 'edahabia', 'بطاقة'],
    transfer: ['transfer', 'virement', 'تحويل', 'bank'],
    cheque: ['cheque', 'chèque', 'check', 'شيك', 'صك']
  }
};

/** Arabic currency abbreviation such as "د.ج" that must not be part of a longer word. */
function parserArAbbr_(a, b) {
  return '(?<![\\u0621-\\u064A])' + a + '[. ]?' + b + '(?![\\u0621-\\u064A])';
}

var PARSER_CURRENCIES_ = [
  ['DZD', '\\bDZD\\b|\\bD\\.?A\\b|' + parserArAbbr_('د', 'ج') + '|dinars?\\s+alg|دينار\\s+جزائري'],
  ['SAR', '\\bSAR\\b|' + parserArAbbr_('ر', 'س') + '|ريال\\s+سعودي|\\bSR\\b'],
  ['AED', '\\bAED\\b|' + parserArAbbr_('د', 'إ') + '|درهم\\s+إماراتي'],
  ['EGP', '\\bEGP\\b|' + parserArAbbr_('ج', 'م') + '|جنيه'],
  ['MAD', '\\bMAD\\b|\\bDH\\b|\\bDhs?\\b|درهم(?!\\s+إماراتي)'],
  ['TND', '\\bTND\\b|\\bDT\\b|' + parserArAbbr_('د', 'ت') + '|دينار\\s+تونسي'],
  ['KWD', '\\bKWD\\b|' + parserArAbbr_('د', 'ك') + '|دينار\\s+كويتي'],
  ['QAR', '\\bQAR\\b|' + parserArAbbr_('ر', 'ق') + '|ريال\\s+قطري'],
  ['BHD', '\\bBHD\\b|' + parserArAbbr_('د', 'ب') + '|دينار\\s+بحريني'],
  ['OMR', '\\bOMR\\b|' + parserArAbbr_('ر', 'ع') + '|ريال\\s+عماني'],
  ['JOD', '\\bJOD\\b|دينار\\s+أردني'],
  ['LYD', '\\bLYD\\b|دينار\\s+ليبي'],
  ['EUR', '€|\\bEUR\\b|\\beuros?\\b|يورو'],
  ['GBP', '£|\\bGBP\\b'],
  ['USD', '\\$|\\bUSD\\b|دولار']
].map(function (c) { return { code: c[0], re: new RegExp(c[1], 'i') }; });

var PARSER_UNITS_ = [
  'pcs', 'pc', 'pce', 'pièce', 'piece', 'pieces', 'u', 'un', 'unit', 'units', 'unité', 'kg', 'g', 'gr',
  'l', 'lt', 'ltr', 'ml', 'm', 'm2', 'm3', 'cm', 'box', 'boxes', 'carton', 'ctn', 'pack', 'paquet',
  'sac', 'bag', 'h', 'hr', 'hrs', 'jour', 'day', 'days', 'قطعة', 'كغ', 'كلغ', 'كيلو', 'غ', 'لتر',
  'علبة', 'كرتون', 'كيس', 'متر', 'ساعة', 'يوم', 'حبة', 'وحدة'
];

var PARSER_MONTHS_ = {
  jan: 1, january: 1, janvier: 1, janv: 1, 'يناير': 1, 'جانفي': 1, 'كانون الثاني': 1,
  feb: 2, february: 2, fevrier: 2, février: 2, fev: 2, fév: 2, 'فبراير': 2, 'فيفري': 2, 'شباط': 2,
  mar: 3, march: 3, mars: 3, 'مارس': 3, 'آذار': 3,
  apr: 4, april: 4, avril: 4, avr: 4, 'أبريل': 4, 'ابريل': 4, 'أفريل': 4, 'افريل': 4, 'نيسان': 4,
  may: 5, mai: 5, 'مايو': 5, 'ماي': 5, 'أيار': 5,
  jun: 6, june: 6, juin: 6, 'يونيو': 6, 'جوان': 6, 'حزيران': 6,
  jul: 7, july: 7, juillet: 7, juil: 7, 'يوليو': 7, 'جويلية': 7, 'تموز': 7,
  aug: 8, august: 8, aout: 8, août: 8, 'أغسطس': 8, 'اغسطس': 8, 'أوت': 8, 'اوت': 8, 'آب': 8,
  sep: 9, sept: 9, september: 9, septembre: 9, 'سبتمبر': 9, 'أيلول': 9,
  oct: 10, october: 10, octobre: 10, 'أكتوبر': 10, 'اكتوبر': 10, 'تشرين الأول': 10,
  nov: 11, november: 11, novembre: 11, 'نوفمبر': 11, 'تشرين الثاني': 11,
  dec: 12, december: 12, decembre: 12, décembre: 12, déc: 12, 'ديسمبر': 12, 'كانون الأول': 12
};

/** Lower-cases and strips accents/diacritics so keyword matching is tolerant. */
function parserFold_(s) {
  return Shared.normalizeDigits(s).toLowerCase()
    .replace(/[ً-ْـ]/g, '')          // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[ôö]/g, 'o')
    .replace(/[ûüù]/g, 'u').replace(/[îï]/g, 'i').replace(/ç/g, 'c');
}

function parserHasKeyword_(line, list) {
  var f = ' ' + parserFold_(line) + ' ';
  for (var i = 0; i < list.length; i++) {
    var k = parserFold_(list[i]);
    // Latin keywords must match as whole words; Arabic ones as substrings.
    if (/[a-z]/.test(k)) {
      var re = new RegExp('(^|[^a-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])');
      if (re.test(f)) return list[i];
    } else if (f.indexOf(k) >= 0) {
      return list[i];
    }
  }
  return null;
}

/**
 * Extracts number tokens from a line, with their position and whether they are
 * percentages. Spaces are accepted as thousands separators only when the number
 * ends with decimals ("1 500,00"), so "2 500" stays two separate numbers.
 */
function parserNumbers_(line) {
  var s = Shared.normalizeDigits(line);
  var re = /(\d{1,3}(?: \d{3})+[.,]\d{1,3}|\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d+)?)(\s?%)?/g;
  var out = [];
  var m;
  while ((m = re.exec(s)) !== null) {
    var before = s.charAt(m.index - 1);
    var token = m[1];
    var after = s.charAt(m.index + m[0].length);
    // Skip parts of dates, times and codes ("12/10", "A12"), and sizes that belong
    // to the description ("5L", "250g", "1kg").
    if (/[\/:]/.test(before) || /^[\/:]/.test(after) || /[A-Za-z]/.test(before) ||
        (/[A-Za-zء-ي]/.test(after) && !/[.,]\d+$/.test(token))) {
      continue;
    }
    var value = Shared.parseNumber(token);
    if (value === null) continue;
    var isPct = !!m[2] || before === '%';
    if (before === '-' && !/\d/.test(s.charAt(m.index - 2))) value = -value;
    var tok = { value: value, raw: token, index: m.index, pct: isPct };
    // "10 135,00" may be one number (10135) or a quantity followed by a price.
    var sp = token.match(/^(\d{1,3}) (\d{3}(?: \d{3})*[.,]\d{1,3})$/);
    if (sp) tok.split = [Shared.parseNumber(sp[1]), Shared.parseNumber(sp[2].replace(/ /g, ''))];
    out.push(tok);
  }
  return out;
}

function parserLastAmount_(line) {
  var nums = parserNumbers_(line).filter(function (t) { return !t.pct; });
  return nums.length ? nums[nums.length - 1].value : null;
}

function parserPercent_(line) {
  var nums = parserNumbers_(line).filter(function (t) { return t.pct; });
  return nums.length ? nums[0].value : null;
}

function parserPad_(n) { return (n < 10 ? '0' : '') + n; }

function parserMakeDate_(y, m, d) {
  if (y < 100) y += 2000;
  var iso = y + '-' + parserPad_(m) + '-' + parserPad_(d);
  return Shared.isValidIsoDate(iso) ? iso : null;
}

/** Finds a date in a line. Returns {iso, ambiguous} or null. */
function parserFindDate_(line) {
  var s = Shared.normalizeDigits(line);
  var m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    var iso = parserMakeDate_(+m[1], +m[2], +m[3]);
    if (iso) return { iso: iso, ambiguous: false };
  }
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?!\d)/);
  if (m) {
    var a = +m[1], b = +m[2], y = +m[3];
    if (a > 12 && b <= 12) return wrap(parserMakeDate_(y, b, a), false);
    if (b > 12 && a <= 12) return wrap(parserMakeDate_(y, a, b), false);
    // Day-first is the convention in Arabic and French documents.
    return wrap(parserMakeDate_(y, b, a), a !== b);
  }
  var f = parserFold_(s);
  var monthNames = Object.keys(PARSER_MONTHS_).sort(function (x, y2) { return y2.length - x.length; });
  for (var i = 0; i < monthNames.length; i++) {
    var name = parserFold_(monthNames[i]);
    var idx = f.indexOf(name);
    if (idx < 0) continue;
    if (/[a-z]/.test(name) && (/[a-z]/.test(f.charAt(idx - 1)) || /[a-z]/.test(f.charAt(idx + name.length)))) continue;
    var month = PARSER_MONTHS_[monthNames[i]];
    var re1 = new RegExp('(\\d{1,2})(?:st|nd|rd|th|er)?\\s*' + escapeRe(name) + '\\.?,?\\s*(\\d{4})');
    var re2 = new RegExp(escapeRe(name) + '\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})');
    var mm = f.match(re1);
    if (mm) return wrap(parserMakeDate_(+mm[2], month, +mm[1]), false);
    mm = f.match(re2);
    if (mm) return wrap(parserMakeDate_(+mm[2], month, +mm[1]), false);
  }
  return null;

  function wrap(iso, ambiguous) { return iso ? { iso: iso, ambiguous: ambiguous } : null; }
  function escapeRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}

function parserDetectCurrency_(text) {
  var best = null, bestCount = 0;
  PARSER_CURRENCIES_.forEach(function (c) {
    var re = new RegExp(c.re.source, 'gi');
    var count = (text.match(re) || []).length;
    if (count > bestCount) { best = c.code; bestCount = count; }
  });
  return best;
}

function parserDetectType_(text) {
  var f = parserFold_(text);
  var has = function (list) { return list.some(function (k) { return f.indexOf(parserFold_(k)) >= 0; }); };
  if (has(['payment receipt', 'recu de paiement', 'سند قبض', 'ايصال دفع', 'ايصال استلام', 'وصل استلام', 'received from', 'recu de'])) {
    return { value: 'payment', confidence: 'high' };
  }
  if (has(['sales invoice', 'facture de vente', 'فاتورة مبيعات', 'فاتورة بيع'])) return { value: 'sales', confidence: 'high' };
  if (has(['purchase invoice', "facture d'achat", 'فاتورة مشتريات', 'فاتورة شراء', 'bon de reception'])) {
    return { value: 'purchase', confidence: 'high' };
  }
  if (has(['invoice', 'facture', 'فاتورة', 'factura'])) return { value: 'purchase', confidence: 'low' };
  if (has(['receipt', 'ticket', 'recu', 'ايصال', 'وصل', 'كشف'])) return { value: 'expense', confidence: 'low' };
  return { value: 'expense', confidence: 'low' };
}

/** Text that is left on a line once numbers, currency marks and separators are removed. */
function parserTextPart_(line) {
  var s = Shared.normalizeDigits(line);
  PARSER_CURRENCIES_.forEach(function (c) { s = s.replace(new RegExp(c.re.source, 'gi'), ' '); });
  return s.replace(/(?<![A-Za-z\u0621-\u064A\d])\d+(?:[., ]\d+)*(?![A-Za-z\u0621-\u064A\d])\s?%?/g, ' ')
    .replace(/[|*=_~•·]+/g, ' ')
    .replace(/(^|\s)[x×:#\-.,]+(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parserLetters_(s) {
  var m = s.match(/[A-Za-zÀ-ɏ؀-ۿ]/g);
  return m ? m.length : 0;
}

/** Picks quantity, unit price, discount and line total from a line's numbers. */
function parserInterpretItem_(nums, pcts, text) {
  var item = {
    quantity: null, unitPrice: null, discount: null, taxRate: null, taxAmount: null,
    lineTotal: null, confidence: 'low'
  };
  if (pcts.length) item.taxRate = pcts[pcts.length - 1];
  var v = nums.slice();
  if (!v.length) return item;
  if (v.length === 1) {
    item.lineTotal = v[0];
    return item;
  }
  var total = v[v.length - 1];
  var rest = v.slice(0, -1);
  // Look for qty * price (- discount) = total among the other numbers.
  for (var i = 0; i < rest.length; i++) {
    for (var j = 0; j < rest.length; j++) {
      if (i === j) continue;
      var q = rest[i], p = rest[j];
      if (q <= 0 || q > 100000) continue;
      if (Shared.near(q * p, total)) {
        // When both orders match (e.g. 2 x 2 = 4), prefer the integer as quantity.
        var swap = Math.round(p) === p && Math.round(q) !== q;
        item.quantity = swap ? p : q;
        item.unitPrice = swap ? q : p;
        item.lineTotal = total;
        item.confidence = 'high';
        return item;
      }
      if (item.taxRate !== null && Shared.near(q * p * (1 + item.taxRate / 100), total)) {
        item.quantity = q; item.unitPrice = p; item.lineTotal = total;
        item.taxAmount = Shared.round2(q * p * item.taxRate / 100);
        item.confidence = 'high';
        return item;
      }
      for (var k = 0; k < rest.length; k++) {
        if (k === i || k === j) continue;
        if (Shared.near(q * p - rest[k], total) && rest[k] < q * p) {
          item.quantity = q; item.unitPrice = p; item.discount = rest[k]; item.lineTotal = total;
          item.confidence = 'high';
          return item;
        }
      }
    }
  }
  // No consistent combination: keep the most likely reading but mark it uncertain.
  item.lineTotal = total;
  if (rest.length === 1) {
    var only = rest[0];
    if (Math.round(only) === only && only > 0 && only <= 1000 && total >= only) {
      item.quantity = only;
      item.unitPrice = Shared.round2(total / only);
    } else {
      item.unitPrice = only;
    }
  } else {
    var qIdx = -1;
    for (var n = 0; n < rest.length; n++) {
      if (Math.round(rest[n]) === rest[n] && rest[n] > 0 && rest[n] <= 1000) { qIdx = n; break; }
    }
    if (qIdx >= 0) item.quantity = rest[qIdx];
    item.unitPrice = rest[rest.length - 1 === qIdx ? rest.length - 2 : rest.length - 1];
  }
  return item;
}

function parserUnit_(text) {
  var words = parserFold_(text).split(/\s+/);
  for (var i = words.length - 1; i >= 0; i--) {
    var w = words[i].replace(/[.,:]$/, '');
    if (PARSER_UNITS_.indexOf(w) >= 0 && (w.length > 1 || words.length > 1)) return w;
  }
  return '';
}

function parserStripUnit_(text, unit) {
  if (!unit) return text;
  var parts = text.split(/\s+/);
  for (var i = parts.length - 1; i >= 0; i--) {
    if (parserFold_(parts[i]).replace(/[.,:]$/, '') === unit) { parts.splice(i, 1); break; }
  }
  return parts.join(' ').trim();
}

function parserIsSummaryLine_(line) {
  var K = PARSER_KEYWORDS_;
  return !!(parserHasKeyword_(line, K.subtotal) || parserHasKeyword_(line, K.total) ||
    parserHasKeyword_(line, K.paid) || parserHasKeyword_(line, K.change) ||
    (parserHasKeyword_(line, K.tax) && parserNumbers_(line).length <= 2) ||
    (parserHasKeyword_(line, K.discount) && parserNumbers_(line).length <= 2));
}

/** Number of item-table header words (description, qty, price...) in a line. */
function parserHeaderHits_(line) {
  var f = parserFold_(line);
  var hits = 0;
  PARSER_KEYWORDS_.itemHeader.forEach(function (k) {
    var kk = parserFold_(k);
    if (/[a-z]/.test(kk) ? new RegExp('(^|[^a-z])' + kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])').test(f)
                         : f.indexOf(kk) >= 0) hits++;
  });
  return hits;
}

/**
 * Finds the line where the item table header ends. Handles headers on one line
 * ("Désignation Qté P.U Montant") and headers split one word per line.
 */
function parserFindTableHeader_(lines) {
  for (var i = 0; i < lines.length; i++) {
    if (parserNumbers_(lines[i]).length) continue;
    if (parserHeaderHits_(lines[i]) >= 2) return i;
    var hits = 0, j = i;
    while (j < lines.length && j < i + 6 && !parserNumbers_(lines[j]).length &&
           parserHeaderHits_(lines[j]) >= 1 && lines[j].split(/\s+/).length <= 3) {
      hits += parserHeaderHits_(lines[j]);
      j++;
    }
    if (j - i >= 2 && hits >= 2) return j - 1;
  }
  return -1;
}

/** Index of the last line in the top part that is clearly document metadata. */
function parserMetaEnd_(lines, limit) {
  var K = PARSER_KEYWORDS_;
  var last = -1;
  for (var i = 0; i < Math.min(lines.length, limit); i++) {
    var l = lines[i];
    if (parserFindDate_(l) || parserHasKeyword_(l, K.invoiceNo) || parserHasKeyword_(l, K.taxId) ||
        parserHasKeyword_(l, K.customer) || parserHasKeyword_(l, K.supplier) ||
        /(tel|tél|phone|fax|هاتف|الهاتف|جوال|www|@|street|rue|avenue|شارع|حي )/i.test(l)) {
      last = i;
    }
  }
  return last;
}

/** Rebuilds line items from the lines between the table header and the totals. */
function parserExtractItems_(lines) {
  var K = PARSER_KEYWORDS_;
  var headerIdx = parserFindTableHeader_(lines);
  var end = lines.length;
  var start;
  if (headerIdx >= 0) {
    start = headerIdx + 1;
  } else {
    var firstSummary = lines.length;
    for (var s0 = 0; s0 < lines.length; s0++) {
      if (parserIsSummaryLine_(lines[s0])) { firstSummary = s0; break; }
    }
    start = parserMetaEnd_(lines, firstSummary) + 1;
  }
  for (var e = start; e < lines.length; e++) {
    if (parserIsSummaryLine_(lines[e]) && e >= start) { end = e; break; }
  }

  var rows = lines.slice(start, end).map(function (l) {
    var toks = parserNumbers_(l);
    var plain = toks.filter(function (t) { return !t.pct; });
    return {
      line: l,
      text: parserTextPart_(l),
      toks: plain,
      nums: plain.map(function (t) { return t.value; }),
      pcts: toks.filter(function (t) { return t.pct; }).map(function (t) { return t.value; })
    };
  });

  // Drive OCR sometimes outputs a table column by column: all descriptions first,
  // then all quantities, then all prices. Detect that layout and re-pair it.
  var textOnly = rows.filter(function (r) { return r.nums.length === 0 && parserLetters_(r.text) >= 2; });
  var numOnly = rows.filter(function (r) { return r.nums.length === 1 && parserLetters_(r.text) === 0; });
  if (textOnly.length >= 2 && numOnly.length >= textOnly.length * 2 &&
      numOnly.length % textOnly.length === 0 &&
      rows.indexOf(textOnly[textOnly.length - 1]) < rows.indexOf(numOnly[0])) {
    var n = textOnly.length, cols = numOnly.length / n;
    return textOnly.map(function (r, idx) {
      var nums = [];
      for (var c = 0; c < cols; c++) nums.push(numOnly[c * n + idx].nums[0]);
      return parserBuildItem_(r.text, [nums], [], '');
    });
  }

  var items = [];
  var pendingText = '';
  rows.forEach(function (r) {
    var letters = parserLetters_(r.text);
    if (!r.nums.length) {
      if (letters >= 2 && !parserHasKeyword_(r.line, K.taxId) && !parserFindDate_(r.line)) {
        // Description wrapped onto its own line; attach it to the next numeric line.
        pendingText = pendingText ? pendingText + ' ' + r.text : r.text;
      }
      return;
    }
    if (parserFindDate_(r.line) || parserHasKeyword_(r.line, K.taxId)) return;
    var text = pendingText ? (letters ? pendingText + ' ' + r.text : pendingText) : r.text;
    pendingText = '';
    if (!parserLetters_(text)) return;
    items.push(parserBuildItem_(text, parserNumberVariants_(r.toks), r.pcts, r.line));
  });
  return items;
}

/**
 * Alternative readings of a line's numbers. "10 135,00" can be 10135 or
 * quantity 10 and price 135; every combination is tried, plain reading first.
 */
function parserNumberVariants_(toks) {
  var variants = [[]];
  toks.forEach(function (t) {
    var next = [];
    variants.forEach(function (v) {
      next.push(v.concat([t.value]));
      if (t.split) next.push(v.concat(t.split));
    });
    variants = next.slice(0, 16);
  });
  return variants;
}

function parserBuildItem_(text, variants, pcts, rawLine) {
  var lead = rawLine && Shared.normalizeDigits(rawLine).match(/^\s*(\d+)\s*[x×*]\s*\D/i);
  var rowNo = rawLine && /^\s*\d{1,2}[\s.)\-]+\D/.test(Shared.normalizeDigits(rawLine));
  var item = null;
  for (var v = 0; v < variants.length; v++) {
    var nums = variants[v];
    var candidate;
    if (lead && nums.length === 2) {
      // "2 x Coffee 7.00": quantity then line total; the unit price is derived.
      candidate = parserInterpretItem_([], pcts, text);
      candidate.quantity = nums[0];
      candidate.lineTotal = nums[1];
      candidate.unitPrice = Shared.round2(nums[1] / nums[0]);
      candidate.confidence = 'low';
    } else {
      candidate = parserInterpretItem_(nums, pcts, text);
      // A leading small integer before the text is often a row number.
      if (candidate.confidence !== 'high' && rowNo && nums.length >= 3) {
        var noRow = parserInterpretItem_(nums.slice(1), pcts, text);
        if (noRow.confidence === 'high') candidate = noRow;
      }
    }
    if (!item) item = candidate;
    if (candidate.confidence === 'high') { item = candidate; break; }
  }
  if (!item) item = parserInterpretItem_([], pcts, text);
  if (!lead && rawLine && /^\s*1\s+\D/.test(Shared.normalizeDigits(rawLine)) && item.quantity === null &&
      Shared.isNum(item.unitPrice) && Shared.isNum(item.lineTotal)) {
    // "1 Orange Juice 3.75"
    if (Shared.near(item.unitPrice, 1)) { item.quantity = 1; item.unitPrice = item.lineTotal; }
  }
  var unit = parserUnit_(text);
  item.unit = unit;
  item.description = parserStripUnit_(text, unit);
  return item;
}

function parserFindLabeledValue_(lines, keywords, maxLines) {
  for (var i = 0; i < Math.min(lines.length, maxLines || lines.length); i++) {
    var k = parserHasKeyword_(lines[i], keywords);
    if (!k) continue;
    var line = lines[i];
    var idx = parserFold_(line).indexOf(parserFold_(k).trim());
    var after = line.slice(idx + k.length).replace(/^[\s:：\-–#°.]+/, '').trim();
    if (after) return { value: after, line: i };
    if (lines[i + 1]) return { value: lines[i + 1].trim(), line: i + 1, nextLine: true };
  }
  return null;
}

function parserInvoiceNumber_(lines) {
  var K = PARSER_KEYWORDS_;
  for (var i = 0; i < lines.length; i++) {
    var l = Shared.normalizeDigits(lines[i]);
    var k = parserHasKeyword_(l, K.invoiceNo);
    if (!k) continue;
    if (parserHasKeyword_(l, K.taxId)) continue;
    var foldedK = parserFold_(k);
    if (foldedK === 'رقم' && /(هاتف|الهاتف|جوال|tel|phone|سجل|ضريبي|حساب|تعريف)/.test(parserFold_(l))) continue;
    var idx = parserFold_(l).indexOf(foldedK);
    var after = l.slice(idx + k.length);
    var m = after.match(/^[^A-Za-z0-9؀-ۿ]*([A-Za-z]{0,6}[\-\/]?\d[A-Za-z0-9\-\/]*)/);
    if (m) return { value: m[1].replace(/[\-\/]$/, ''), confidence: 'high' };
    if (lines[i + 1]) {
      var m2 = Shared.normalizeDigits(lines[i + 1]).match(/^\s*([A-Za-z]{0,6}[\-\/]?\d[A-Za-z0-9\-\/]*)\s*$/);
      if (m2) return { value: m2[1], confidence: 'low' };
    }
  }
  for (var j = 0; j < Math.min(lines.length, 12); j++) {
    var m3 = Shared.normalizeDigits(lines[j]).match(/(?:^|\s)(?:no\.?|n°|#)\s*([A-Za-z0-9][A-Za-z0-9\-\/]+)/i);
    if (m3 && /\d/.test(m3[1])) return { value: m3[1], confidence: 'low' };
  }
  return null;
}

function parserDate_(lines) {
  var K = PARSER_KEYWORDS_;
  var fallback = null;
  for (var i = 0; i < lines.length; i++) {
    var d = parserFindDate_(lines[i]);
    if (!d) {
      if (parserHasKeyword_(lines[i], K.date) && lines[i + 1]) {
        d = parserFindDate_(lines[i + 1]);
        if (d) return { value: d.iso, confidence: d.ambiguous ? 'low' : 'high' };
      }
      continue;
    }
    if (parserHasKeyword_(lines[i], K.date)) return { value: d.iso, confidence: d.ambiguous ? 'low' : 'high' };
    if (!fallback) fallback = { value: d.iso, confidence: 'low' };
  }
  return fallback;
}

function parserParty_(lines, type) {
  var K = PARSER_KEYWORDS_;
  // Purchases and expenses: the issuer is the party. Sales: the customer.
  // Payment receipts: whoever the money was received from.
  var labels = type === 'sales' ? K.customer :
    type === 'payment' ? ['received from', 'recu de', 'reçu de', 'استلمنا من', 'استلمت من', 'وصلنا من']
      .concat(K.customer) : K.supplier;
  var found = parserFindLabeledValue_(lines, labels, 25);
  if (found && parserLetters_(found.value) >= 3 && !parserNumbers_(found.value).length) {
    var name = found.value.replace(/^(السيد|السيدة|السادة|mr|mrs|ms|m|mme|mlle)\.?\s*[:：]?\s*/i, '');
    return { value: name.replace(/\s+/g, ' ').slice(0, 120), confidence: 'high' };
  }
  if (type === 'sales') return null;
  // Otherwise the first meaningful line of the document is usually the issuer.
  var skip = [].concat(K.invoiceNo, K.date, K.taxId,
    ['invoice', 'facture', 'فاتورة', 'receipt', 'reçu', 'ايصال', 'إيصال', 'وصل', 'tel', 'tél', 'phone',
     'fax', 'email', 'www', 'http', 'هاتف', 'الهاتف', 'جوال', 'adresse', 'address', 'العنوان', 'ticket',
     'original', 'copy', 'نسخة', 'سند']);
  for (var i = 0; i < Math.min(lines.length, 8); i++) {
    var l = lines[i].trim();
    if (parserLetters_(l) < 3) continue;
    if (parserHasKeyword_(l, skip)) continue;
    var digits = (Shared.normalizeDigits(l).match(/\d/g) || []).length;
    if (digits > l.length / 3) continue;
    return { value: l.replace(/\s+/g, ' ').slice(0, 120), confidence: 'low' };
  }
  return null;
}

function parserTaxId_(lines) {
  var found = parserFindLabeledValue_(lines, PARSER_KEYWORDS_.taxId, 30);
  if (!found) return null;
  var m = Shared.normalizeDigits(found.value).match(/[A-Za-z0-9][A-Za-z0-9 \-\/]{4,}/);
  return m ? { value: m[0].trim(), confidence: 'low' } : null;
}

/** Finds the printed totals. Lines are scanned bottom-up because totals sit at the end. */
function parserTotals_(lines) {
  var K = PARSER_KEYWORDS_;
  var res = {};
  var seenTotals = [];
  var adjustments = [];
  function amountAt(i) {
    var v = parserLastAmount_(lines[i]);
    if (v === null && lines[i + 1] && parserLetters_(parserTextPart_(lines[i + 1])) === 0) {
      v = parserLastAmount_(lines[i + 1]);
    }
    return v;
  }
  for (var i = lines.length - 1; i >= 0; i--) {
    var l = lines[i];
    if (parserHasKeyword_(l, K.change)) continue;
    var isSub = parserHasKeyword_(l, K.subtotal);
    var isTax = !isSub && parserHasKeyword_(l, K.tax) &&
      !/(ttc|toutes taxes|incl|شامل|بعد الضريبة|avec tva)/.test(parserFold_(l));
    var isDisc = parserHasKeyword_(l, K.discount);
    var isPaid = parserHasKeyword_(l, K.paid);
    var isTotal = parserHasKeyword_(l, K.total);
    var v = amountAt(i);
    if (v === null) continue;
    if (isSub) { if (res.subtotal === undefined) res.subtotal = v; continue; }
    if (isTax || isDisc) adjustments.push(i);
    if (isTax) {
      if (res.taxTotal === undefined) {
        // "TVA 19%" with no amount on the line: the only number is the rate.
        var nums = parserNumbers_(l).filter(function (t) { return !t.pct; });
        if (nums.length) res.taxTotal = v;
        var pct = parserPercent_(l);
        if (pct !== null && res.taxRate === undefined) res.taxRate = pct;
      }
      continue;
    }
    if (isDisc) { if (res.discountTotal === undefined) res.discountTotal = Math.abs(v); continue; }
    if (isPaid && !isTotal) { if (res.amountPaid === undefined) res.amountPaid = v; continue; }
    if (isTotal) {
      seenTotals.push({ value: v, index: i });
      // Keep the bottom-most total, but prefer an explicit "grand total / TTC / net".
      var strong = /(grand total|ttc|net a payer|total due|amount due|a payer|الاجمالي|المجموع الكلي|المستحق|الصافي|المطلوب)/
        .test(parserFold_(l));
      if (res.total === undefined || (strong && !res.totalStrong)) {
        res.total = v;
        res.totalStrong = strong;
        res.totalIndex = i;
      }
    }
  }
  // "المجموع 3540 / خصم 40 / الإجمالي 3500": a plain total printed above the
  // discount or tax lines is really the subtotal.
  if (res.subtotal === undefined && res.total !== undefined) {
    seenTotals.forEach(function (st) {
      if (res.subtotal === undefined && st.index < res.totalIndex && st.value !== res.total &&
          adjustments.some(function (a) { return a > st.index && a < res.totalIndex; })) {
        res.subtotal = st.value;
      }
    });
  }
  return res;
}

function parserPaymentMethod_(text) {
  var pm = PARSER_KEYWORDS_.paymentMethod;
  for (var key in pm) {
    if (parserHasKeyword_(text, pm[key])) return key;
  }
  return '';
}

/**
 * Main entry point: raw OCR text -> draft {header, items, confidence, rawText}.
 */
function parseInvoiceText(rawText) {
  var text = Shared.normalizeDigits(rawText || '');
  var lines = text.split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
    .filter(function (l) { return l.length > 0; });

  var conf = {};
  var header = {};
  function set(field, found) {
    if (found && found.value !== null && found.value !== undefined && found.value !== '') {
      header[field] = found.value;
      conf[field] = found.confidence || 'low';
    } else {
      header[field] = Shared.NUMERIC_HEADER_FIELDS.indexOf(field) >= 0 ? null : '';
      conf[field] = 'missing';
    }
  }

  var type = parserDetectType_(text);
  set('type', type);
  set('invoiceNumber', parserInvoiceNumber_(lines));
  set('date', parserDate_(lines));
  set('partyName', parserParty_(lines, type.value));
  set('partyTaxId', parserTaxId_(lines));
  var cur = parserDetectCurrency_(text);
  set('currency', cur ? { value: cur, confidence: 'low' } : null);

  var t = parserTotals_(lines);
  ['subtotal', 'discountTotal', 'taxTotal', 'total', 'amountPaid'].forEach(function (f) {
    set(f, t[f] !== undefined ? { value: t[f], confidence: 'low' } : null);
  });
  header.paymentMethod = parserPaymentMethod_(text);
  conf.paymentMethod = header.paymentMethod ? 'low' : 'missing';
  header.notes = '';

  // Payment receipts record an amount received, not a list of goods.
  var items = type.value === 'payment' ? [] : parserExtractItems_(lines);

  // Totals that agree with the item sum or with each other are more trustworthy.
  var sumLines = items.length && items.every(function (it) { return Shared.isNum(it.lineTotal); }) ?
    Shared.round2(items.reduce(function (a, it) { return a + it.lineTotal; }, 0)) : null;
  var disc = header.discountTotal || 0, tax = header.taxTotal || 0;
  if (Shared.isNum(header.subtotal) && Shared.isNum(header.total) &&
      [header.subtotal - disc + tax, header.subtotal + tax, header.subtotal - disc]
        .some(function (c) { return Shared.near(c, header.total); })) {
    conf.subtotal = conf.total = 'high';
    if (Shared.isNum(header.taxTotal)) conf.taxTotal = 'high';
    if (Shared.isNum(header.discountTotal)) conf.discountTotal = 'high';
  }
  if (sumLines !== null) {
    if (Shared.isNum(header.subtotal) && Shared.near(sumLines, header.subtotal)) conf.subtotal = 'high';
    if (Shared.isNum(header.total) && Shared.near(sumLines, header.total)) conf.total = 'high';
  }
  if (!Shared.isNum(header.total) && Shared.isNum(header.subtotal)) {
    header.total = Shared.round2(header.subtotal - disc + tax);
    conf.total = 'low';
  }

  var arabic = (text.match(/[؀-ۿ]/g) || []).length;
  var latin = (text.match(/[A-Za-z]/g) || []).length;
  header.language = arabic > latin ? 'ar' : (/(facture|montant|prix|qt[eé]|total ttc|tva)/i.test(text) ? 'fr' : 'en');

  return { header: header, items: items, confidence: conf, rawText: rawText || '' };
}
