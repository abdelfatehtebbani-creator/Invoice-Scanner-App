/**
 * Verifies (and if needed creates) the spreadsheet, its three sheets and the
 * Drive image folder. Safe to run many times: existing resources are reused,
 * missing columns are appended, nothing is deleted or duplicated.
 */

/** Run once from the Apps Script editor to authorize and verify everything. */
function setup() {
  var r = ensureSetup_(true);
  Logger.log('Spreadsheet: %s', r.spreadsheet.getUrl());
  Logger.log('Image folder: %s', r.folder.getUrl());
  Logger.log('Sheets: %s', r.spreadsheet.getSheets().map(function (s) { return s.getName(); }).join(', '));
  return { spreadsheetUrl: r.spreadsheet.getUrl(), folderUrl: r.folder.getUrl(), report: r.report };
}

var SETUP_CACHE_ = null;

function ensureSetup_(force) {
  if (SETUP_CACHE_ && !force) return SETUP_CACHE_;
  var props = PropertiesService.getScriptProperties();
  var report = [];
  var ss = openSpreadsheet_(props, report);
  var folder = openFolder_(props, report);

  if (force || props.getProperty('SETUP_VERSION') !== CONFIG.SETUP_VERSION) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      [SHEETS.INVOICES, SHEETS.ITEMS, SHEETS.LOG].forEach(function (def) {
        ensureSheet_(ss, def, report);
      });
      props.setProperty('SETUP_VERSION', CONFIG.SETUP_VERSION);
    } finally {
      lock.releaseLock();
    }
  }
  SETUP_CACHE_ = { spreadsheet: ss, folder: folder, report: report };
  return SETUP_CACHE_;
}

function openSpreadsheet_(props, report) {
  var ids = [props.getProperty('SPREADSHEET_ID'), CONFIG.DEFAULT_SPREADSHEET_ID];
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    try {
      var ss = SpreadsheetApp.openById(ids[i]);
      if (props.getProperty('SPREADSHEET_ID') !== ids[i]) props.setProperty('SPREADSHEET_ID', ids[i]);
      return ss;
    } catch (e) {
      report.push('Could not open spreadsheet ' + ids[i] + ': ' + e.message);
    }
  }
  var files = DriveApp.getFilesByName(CONFIG.SPREADSHEET_NAME);
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS && !f.isTrashed()) {
      props.setProperty('SPREADSHEET_ID', f.getId());
      report.push('Reusing existing spreadsheet found by name');
      return SpreadsheetApp.openById(f.getId());
    }
  }
  var created = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
  props.setProperty('SPREADSHEET_ID', created.getId());
  report.push('Created spreadsheet ' + CONFIG.SPREADSHEET_NAME);
  return created;
}

function openFolder_(props, report) {
  var ids = [props.getProperty('FOLDER_ID'), CONFIG.DEFAULT_FOLDER_ID];
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    try {
      var folder = DriveApp.getFolderById(ids[i]);
      if (folder.isTrashed()) throw new Error('folder is in the trash');
      if (props.getProperty('FOLDER_ID') !== ids[i]) props.setProperty('FOLDER_ID', ids[i]);
      return folder;
    } catch (e) {
      report.push('Could not open folder ' + ids[i] + ': ' + e.message);
    }
  }
  var it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) {
      props.setProperty('FOLDER_ID', f.getId());
      report.push('Reusing existing folder found by name');
      return f;
    }
  }
  var created = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', created.getId());
  report.push('Created folder ' + CONFIG.FOLDER_NAME);
  return created;
}

function ensureSheet_(ss, def, report) {
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    // Reuse the spreadsheet's untouched default sheet ("Sheet1", "Feuille 1"...) once.
    var sheets = ss.getSheets();
    var known = [SHEETS.INVOICES.name, SHEETS.ITEMS.name, SHEETS.LOG.name];
    var blank = sheets.filter(function (s) {
      return known.indexOf(s.getName()) < 0 && s.getLastRow() === 0 && s.getLastColumn() === 0;
    })[0];
    if (blank && sheets.length === 1) {
      report.push('Renamed empty sheet "' + blank.getName() + '" to ' + def.name);
      sheet = blank.setName(def.name);
    } else {
      sheet = ss.insertSheet(def.name);
      report.push('Created sheet ' + def.name);
    }
  }
  var lastCol = sheet.getLastColumn();
  var existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  var missing = def.headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    report.push(def.name + ': added columns ' + missing.join(', '));
  }
  var headers = existing.concat(missing);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8eef7');
  var rows = sheet.getMaxRows() - 1;
  if (rows > 0) {
    headers.forEach(function (h, i) {
      var range = sheet.getRange(2, i + 1, rows, 1);
      if (def.textColumns.indexOf(h) >= 0) range.setNumberFormat('@');
      else if (def.dateColumns.indexOf(h) >= 0) range.setNumberFormat('yyyy-mm-dd');
      else if (def.timestampColumns.indexOf(h) >= 0) range.setNumberFormat('yyyy-mm-dd hh:mm:ss');
      else if (def.moneyColumns.indexOf(h) >= 0) range.setNumberFormat('#,##0.00');
    });
  }
  return sheet;
}
