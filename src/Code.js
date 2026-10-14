/**
 * Web app entry point and the functions the page calls with google.script.run.
 * The web app is deployed "Execute as: me" and "Who has access: only myself",
 * and every API call re-checks that the caller is the owner.
 */

function doGet() {
  ensureSetup_();
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    // HtmlService only allows a few meta tags (viewport, *-web-app-capable, site verification).
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Source of the shared validation library, injected into the page. */
function sharedSource_() {
  return 'var Shared = (' + SharedLib_.toString() + ')();';
}

function assertOwner_() {
  var active = Session.getActiveUser().getEmail();
  var owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) throw new Error('Access denied.');
}

/** Wraps an API call: owner check, timing and error logging. */
function api_(stage, req, fn) {
  var started = Date.now();
  try {
    assertOwner_();
    return fn();
  } catch (e) {
    logEvent_({
      requestId: req && req.requestId, stage: stage, status: 'FAILED',
      durationMs: Date.now() - started, message: e && e.stack ? e.stack : String(e)
    });
    throw new Error(e && e.message ? e.message : String(e));
  }
}

function apiBootstrap() {
  return api_('bootstrap', null, function () {
    var s = ensureSetup_();
    cleanupPendingImages_();
    var props = PropertiesService.getScriptProperties();
    return {
      email: Session.getActiveUser().getEmail(),
      geminiConfigured: geminiConfigured_(),
      geminiModel: props.getProperty('GEMINI_MODEL') || CONFIG.GEMINI_MODEL,
      ownerBusinessName: props.getProperty('OWNER_BUSINESS_NAME') || '',
      spreadsheetUrl: s.spreadsheet.getUrl(),
      folderUrl: s.folder.getUrl(),
      today: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'),
      timeZone: tz_()
    };
  });
}

/**
 * Step 1: store the image in Drive, run OCR and return a draft for review.
 * req: {requestId, data (base64), mimeType, fileName, langHint, engine}
 */
function apiExtract(req) {
  return api_('extract', req, function () {
    var started = Date.now();
    if (!req || !req.requestId || !req.data) throw new Error('No image received.');
    var cache = CacheService.getScriptCache();
    var cached = cache.get('ext:' + req.requestId);
    if (cached) return JSON.parse(cached);

    var mime = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/.test(req.mimeType) ? req.mimeType : 'image/jpeg';
    var bytes = Utilities.base64Decode(req.data);
    if (bytes.length > CONFIG.MAX_IMAGE_BYTES) throw new Error('The image is too large.');
    var hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
    var ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg');
    var stamp = Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd-HHmmss');
    var blob = Utilities.newBlob(bytes, mime, CONFIG.PENDING_PREFIX + stamp + '_' + hash.slice(0, 8) + '.' + ext);

    var folder = ensureSetup_().folder;
    var file = folder.createFile(blob);
    file.setDescription('Invoice Scanner upload, request ' + req.requestId + ', not saved yet.');

    var warnings = [];
    var engine = chooseEngine_(req.engine);
    var draft;
    if (engine === 'gemini') {
      try {
        draft = geminiExtract_(blob);
      } catch (e) {
        warnings.push('gemini_failed');
        logEvent_({ requestId: req.requestId, stage: 'extract', status: 'WARNING', engine: 'gemini',
          imageFileId: file.getId(), message: 'Falling back to Drive OCR: ' + e.message });
        engine = 'drive';
      }
    }
    if (engine === 'drive') {
      var text = driveOcr_(blob, req.langHint);
      draft = parseInvoiceText(text);
      if (!text.trim()) warnings.push('no_text');
    }
    if (!draft.header.type) draft.header.type = 'purchase';
    var validation = Shared.validateDraft(draft, { today: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd') });
    var duplicates = findDuplicates_({ imageHash: hash, header: draft.header });

    var result = {
      requestId: req.requestId,
      imageFileId: file.getId(),
      imageUrl: file.getUrl(),
      imageHash: hash,
      engine: engine,
      draft: draft,
      validation: validation,
      duplicates: duplicates,
      warnings: warnings
    };
    logEvent_({
      requestId: req.requestId, stage: 'extract', status: 'OK', engine: engine,
      imageFileId: file.getId(), imageHash: hash, durationMs: Date.now() - started,
      message: draft.items.length + ' items, ' + validation.errors + ' errors, ' +
        validation.warnings + ' warnings' + (duplicates.length ? ', possible duplicate of ' +
        duplicates.map(function (d) { return d.invoiceId; }).join(' ') : '')
    });
    var json = JSON.stringify(result);
    if (json.length < 90000) cache.put('ext:' + req.requestId, json, 21600);
    return result;
  });
}

/**
 * Step 2: save the reviewed invoice.
 * req: {requestId, invoiceId?, draft, imageFileId, imageHash, engine,
 *       confirmIssues, confirmDuplicate}
 * The same requestId always produces at most one invoice, however many times
 * the button is pressed or the request retried.
 */
function apiSave(req) {
  return api_('save', req, function () {
    var started = Date.now();
    if (!req || !req.requestId || !req.draft) throw new Error('Nothing to save.');
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('The app is busy, please try again.');
    try {
      var already = findSavedRequest_(req.requestId);
      if (already) {
        logEvent_({ requestId: req.requestId, stage: 'save', status: 'DUPLICATE_REQUEST', invoiceId: already,
          message: 'Repeated save ignored' });
        return { saved: true, alreadySaved: true, invoiceId: already };
      }

      var draft = req.draft;
      var today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
      var validation = Shared.validateDraft(draft, { today: today });
      var h = draft.header;
      var isUpdate = !!req.invoiceId;

      if (!req.confirmDuplicate) {
        var dups = findDuplicates_({
          imageHash: isUpdate ? null : req.imageHash, header: h, excludeId: req.invoiceId
        });
        if (dups.length) {
          logEvent_({ requestId: req.requestId, stage: 'save', status: 'BLOCKED_DUPLICATE',
            imageHash: req.imageHash, message: 'Matches ' + dups.map(function (d) { return d.invoiceId; }).join(' ') });
          return { saved: false, duplicates: dups };
        }
      }

      var status = validation.issues.length === 0 ? REVIEW_STATUS.VERIFIED :
        (req.confirmIssues ? REVIEW_STATUS.CONFIRMED_WITH_ISSUES : REVIEW_STATUS.NEEDS_REVIEW);
      var invoiceId = isUpdate ? req.invoiceId : newInvoiceId_();
      var uncertain = Object.keys(draft.confidence || {}).filter(function (k) {
        return draft.confidence[k] === 'low';
      });

      var image = null;
      var imageFileId = req.imageFileId || '';
      if (imageFileId) {
        image = DriveApp.getFileById(imageFileId);
        var safe = function (s) {
          return String(s || '').replace(/[\\\/:*?"<>|#]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 40);
        };
        var name = image.getName();
        var ext = name.indexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '.jpg';
        image.setName([h.date || today, safe(h.partyName) || 'unknown', safe(h.invoiceNumber), invoiceId]
          .filter(String).join('_') + ext);
        image.setDescription('Invoice Scanner ' + invoiceId);
      }

      var issuesForSheet = validation.issues.map(function (i) {
        return { level: i.level, code: i.code, field: i.field, item: i.item, params: i.params };
      });
      var record = {
        Type: h.type,
        InvoiceNumber: h.invoiceNumber || '',
        InvoiceDate: isoToDate_(h.date),
        PartyName: h.partyName || '',
        PartyTaxID: h.partyTaxId || '',
        Currency: (h.currency || '').toUpperCase(),
        Subtotal: h.subtotal,
        DiscountTotal: h.discountTotal,
        TaxTotal: h.taxTotal,
        Total: h.total,
        AmountPaid: h.amountPaid,
        PaymentMethod: h.paymentMethod || '',
        ItemCount: draft.items.length,
        ItemsSum: validation.computed.itemsSum,
        ReviewStatus: status,
        ProcessingStatus: 'Saved',
        Issues: JSON.stringify(issuesForSheet),
        UncertainFields: uncertain.join(', '),
        OcrEngine: req.engine || '',
        Language: h.language || '',
        ImageFileID: imageFileId,
        ImageURL: image ? image.getUrl() : '',
        ImageHash: req.imageHash || '',
        BusinessKey: Shared.businessKey(h),
        RequestID: req.requestId,
        Notes: h.notes || ''
      };
      if (isUpdate) {
        // Keep the original image link and hash when editing an invoice.
        var existing = getInvoice_(invoiceId);
        if (!imageFileId) {
          record.ImageFileID = existing.imageFileId;
          record.ImageURL = existing.imageUrl;
          delete record.ImageHash;
          var t = readTable_(SHEETS.INVOICES);
          t.rows.forEach(function (r) {
            if (String(r[t.idx.InvoiceID]) === invoiceId) record.ImageHash = String(r[t.idx.ImageHash]);
          });
        }
        if (!record.OcrEngine) record.OcrEngine = existing.engine;
      }
      var itemFlags = {};
      validation.issues.forEach(function (i) {
        if (i.item !== undefined) (itemFlags[i.item] = itemFlags[i.item] || []).push(i.code);
      });
      draft.items.forEach(function (it, n) { it.flags = itemFlags[n] || []; });

      writeInvoice_(invoiceId, record, draft.items, isUpdate);
      CacheService.getScriptCache().put('save:' + req.requestId, invoiceId, 21600);
      logEvent_({
        requestId: req.requestId, stage: 'save', status: 'OK', invoiceId: invoiceId,
        imageFileId: imageFileId, imageHash: req.imageHash, engine: req.engine,
        durationMs: Date.now() - started,
        message: (isUpdate ? 'Updated' : 'Saved') + ' with status "' + status + '", ' +
          draft.items.length + ' items' + (req.confirmDuplicate ? ', duplicate confirmed by user' : '')
      });
      return { saved: true, invoiceId: invoiceId, reviewStatus: status, issues: validation.issues };
    } finally {
      lock.releaseLock();
    }
  });
}

/** filter: {q, type, status, from, to, limit} */
function apiList(filter) {
  return api_('list', null, function () { return listInvoices_(filter); });
}

function apiGet(invoiceId) {
  return api_('get', null, function () {
    var inv = getInvoice_(String(invoiceId));
    inv.thumbnail = '';
    if (inv.imageFileId) {
      try {
        var thumb = DriveApp.getFileById(inv.imageFileId).getThumbnail();
        if (thumb) inv.thumbnail = 'data:' + thumb.getContentType() + ';base64,' + Utilities.base64Encode(thumb.getBytes());
      } catch (e) {
        inv.thumbnail = '';
      }
    }
    return inv;
  });
}

/**
 * Stores or clears the optional Gemini key. The key is kept in Script
 * Properties on the server and is never sent back to the browser.
 */
function apiSaveSettings(s) {
  return api_('settings', null, function () {
    var props = PropertiesService.getScriptProperties();
    if (s.clearGeminiKey) props.deleteProperty('GEMINI_API_KEY');
    if (s.geminiApiKey) {
      var key = String(s.geminiApiKey).trim();
      if (!/^[A-Za-z0-9_\-]{30,60}$/.test(key)) throw new Error('This does not look like a Gemini API key.');
      props.setProperty('GEMINI_API_KEY', key);
    }
    if (s.ownerBusinessName !== undefined) props.setProperty('OWNER_BUSINESS_NAME', String(s.ownerBusinessName).slice(0, 120));
    logEvent_({ stage: 'settings', status: 'OK', message: 'Gemini ' + (geminiConfigured_() ? 'enabled' : 'disabled') });
    return { geminiConfigured: geminiConfigured_() };
  });
}

/** Moves uploads that were never saved (older than a week) to the trash. */
function cleanupPendingImages_() {
  try {
    var folder = ensureSetup_().folder;
    var cutoff = Date.now() - CONFIG.PENDING_MAX_AGE_DAYS * 86400000;
    var it = folder.searchFiles('title contains "' + CONFIG.PENDING_PREFIX + '" and trashed = false');
    var n = 0;
    while (it.hasNext() && n < 20) {
      var f = it.next();
      if (f.getName().indexOf(CONFIG.PENDING_PREFIX) === 0 && f.getDateCreated().getTime() < cutoff) {
        f.setTrashed(true);
        n++;
      }
    }
    if (n) logEvent_({ stage: 'cleanup', status: 'OK', message: 'Trashed ' + n + ' unsaved uploads' });
  } catch (e) {
    console.warn('Cleanup skipped: ' + e.message);
  }
}
