/**
 * Extraction engines.
 *
 * - "drive":  Google Drive's built-in OCR (free, included with the Google
 *             account). Returns plain text, which Parser.js turns into fields
 *             and line items.
 * - "gemini": Google Gemini reads the image directly and returns structured
 *             JSON, which is far better at tables. Only used when the owner has
 *             stored a GEMINI_API_KEY script property (see README for costs).
 */

function geminiConfigured_() {
  return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

function chooseEngine_(requested) {
  if (requested === 'drive') return 'drive';
  if (requested === 'gemini') return geminiConfigured_() ? 'gemini' : 'drive';
  return geminiConfigured_() ? 'gemini' : 'drive';
}

/**
 * Runs Drive OCR on an image or PDF blob and returns the recognised text.
 * The temporary Google Doc created for the conversion is deleted afterwards.
 */
function driveOcr_(blob, langHint) {
  var token = ScriptApp.getOAuthToken();
  var boundary = 'invoicescanner' + Utilities.getUuid().replace(/-/g, '');
  var metadata = {
    name: 'ocr-temp-' + Date.now(),
    mimeType: 'application/vnd.google-apps.document'
  };
  var head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: ' + blob.getContentType() + '\r\n\r\n';
  var tail = '\r\n--' + boundary + '--';
  var payload = Utilities.newBlob(head).getBytes().concat(blob.getBytes()).concat(Utilities.newBlob(tail).getBytes());
  var url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id' +
    (langHint && langHint !== 'auto' ? '&ocrLanguage=' + encodeURIComponent(langHint) : '');
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: payload,
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Drive OCR failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
  var docId = JSON.parse(res.getContentText()).id;
  try {
    var exp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + docId +
      '/export?mimeType=text%2Fplain', {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (exp.getResponseCode() >= 300) {
      throw new Error('Drive OCR export failed (' + exp.getResponseCode() + ')');
    }
    // The export starts with a byte-order mark and a separator line.
    return exp.getContentText('UTF-8').replace(/^﻿/, '').replace(/^_{5,}\s*/, '');
  } finally {
    UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + docId, {
      method: 'delete',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
  }
}

var GEMINI_PROMPT_ = [
  'You are extracting data from a photo of an invoice or receipt. The document may be in Arabic,',
  'French or English, and may mix them. Return ONLY a JSON object with this shape:',
  '{',
  '  "document_type": "purchase" | "sales" | "expense" | "payment",',
  '  "invoice_number": string|null, "date": "YYYY-MM-DD"|null,',
  '  "issuer_name": string|null, "customer_name": string|null, "party_tax_id": string|null,',
  '  "currency": ISO 4217 code|null,',
  '  "subtotal": number|null, "discount_total": number|null, "tax_total": number|null,',
  '  "total": number|null, "amount_paid": number|null,',
  '  "payment_method": "cash"|"card"|"transfer"|"cheque"|null,',
  '  "items": [{"description": string, "quantity": number|null, "unit": string|null,',
  '             "unit_price": number|null, "discount": number|null, "tax_rate": number|null,',
  '             "tax_amount": number|null, "line_total": number|null, "uncertain": boolean}],',
  '  "uncertain_fields": [names of top-level fields you are not sure about],',
  '  "notes": string|null',
  '}',
  'Rules:',
  '- Copy values exactly as printed. Never invent or calculate a value that is not printed; use null.',
  '- Numbers are plain JSON numbers with "." as decimal separator and no thousands separators.',
  '  Convert Arabic-Indic digits to Western digits.',
  '- tax_rate is a percentage (19 for 19%).',
  '- Keep item descriptions in their original language and script.',
  '- Include every line item of the table, in order. A receipt for a payment has no items.',
  '- Dates on Arabic and French documents are usually day/month/year.',
  '- document_type: "payment" for a payment/cash receipt (سند قبض, reçu de paiement), "expense" for',
  '  a shop or till receipt, "sales" if the document is issued BY the customer named below',
  '  (the owner), otherwise "purchase".',
  '- Mark a field or item uncertain when it is blurred, cut off, handwritten or ambiguous.'
].join('\n');

function geminiExtract_(blob) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  var model = props.getProperty('GEMINI_MODEL') || CONFIG.GEMINI_MODEL;
  var ownerName = props.getProperty('OWNER_BUSINESS_NAME') || '';
  var prompt = GEMINI_PROMPT_ + (ownerName ? '\nThe owner of this app is: ' + ownerName : '');
  var body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    throw new Error('Gemini request failed (' + code + '): ' + res.getContentText().slice(0, 300));
  }
  var json = JSON.parse(res.getContentText());
  var parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('');
  text = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  return geminiToDraft_(JSON.parse(text));
}

/** Maps Gemini's JSON onto the app's draft structure. */
function geminiToDraft_(g) {
  var type = Shared.INVOICE_TYPES.indexOf(g.document_type) >= 0 ? g.document_type : 'purchase';
  var party = type === 'sales' || type === 'payment' ? (g.customer_name || '') : (g.issuer_name || '');
  var uncertain = (g.uncertain_fields || []).map(function (f) {
    return {
      document_type: 'type', invoice_number: 'invoiceNumber', date: 'date', issuer_name: 'partyName',
      customer_name: 'partyName', party_tax_id: 'partyTaxId', currency: 'currency', subtotal: 'subtotal',
      discount_total: 'discountTotal', tax_total: 'taxTotal', total: 'total', amount_paid: 'amountPaid',
      payment_method: 'paymentMethod'
    }[f] || f;
  });
  var header = {
    type: type,
    invoiceNumber: g.invoice_number || '',
    date: Shared.isValidIsoDate(g.date) ? g.date : '',
    partyName: party,
    partyTaxId: g.party_tax_id || '',
    currency: (g.currency || '').toUpperCase(),
    subtotal: Shared.parseNumber(g.subtotal),
    discountTotal: Shared.parseNumber(g.discount_total),
    taxTotal: Shared.parseNumber(g.tax_total),
    total: Shared.parseNumber(g.total),
    amountPaid: Shared.parseNumber(g.amount_paid),
    paymentMethod: g.payment_method || '',
    notes: g.notes || ''
  };
  var confidence = {};
  Shared.HEADER_FIELDS.forEach(function (f) {
    var v = header[f];
    confidence[f] = v === '' || v === null || v === undefined ? 'missing' :
      (uncertain.indexOf(f) >= 0 ? 'low' : 'high');
  });
  if (g.date && !header.date) confidence.date = 'missing';
  var items = (g.items || []).map(function (it) {
    return {
      description: it.description || '',
      quantity: Shared.parseNumber(it.quantity),
      unit: it.unit || '',
      unitPrice: Shared.parseNumber(it.unit_price),
      discount: Shared.parseNumber(it.discount),
      taxRate: Shared.parseNumber(it.tax_rate),
      taxAmount: Shared.parseNumber(it.tax_amount),
      lineTotal: Shared.parseNumber(it.line_total),
      confidence: it.uncertain ? 'low' : 'high'
    };
  });
  return { header: header, items: items, confidence: confidence, rawText: '' };
}
