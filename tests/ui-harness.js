// Renders the real web-app page in a phone-sized Chromium with an in-memory
// fake of the Apps Script backend, then walks through the main user flows.
// Usage: node tests/ui-harness.js <outDir>
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW_MODULE || 'playwright');
const load = require('./load');

const SRC = path.join(__dirname, '..', 'src');
const OUT = process.argv[2] || path.join(__dirname, 'ui-out');
fs.mkdirSync(OUT, { recursive: true });
const ctx = load(['Shared.js', 'Parser.js']);
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

function buildPage() {
  let html = read('Index.html');
  html = html.replace("<?!= include_('Styles') ?>", read('Styles.html'));
  html = html.replace("<?!= include_('App') ?>", read('App.html'));
  html = html.replace('<?!= sharedSource_() ?>', 'var Shared = (' + ctx.SharedLib_.toString() + ')();');
  const mock = `<script>
    window.google = { script: { get run() {
      let ok = () => {}, fail = () => {};
      const runner = new Proxy({}, { get(_, name) {
        if (name === 'withSuccessHandler') return (f) => { ok = f; return runner; };
        if (name === 'withFailureHandler') return (f) => { fail = f; return runner; };
        return (arg) => window.__api(name, JSON.stringify(arg === undefined ? null : arg))
          .then((r) => ok(JSON.parse(r)), (e) => fail(new Error(e.message)));
      } });
      return runner;
    } } };
  </script>`;
  // HtmlService adds this meta tag from doGet().
  return html.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">' + mock);
}

// ---- fake backend ----
const db = { invoices: [], items: {}, saved: {} };
let sample = 'fr_facture.txt';
const api = {
  apiBootstrap: () => ({ email: 'owner@example.com', geminiConfigured: false, spreadsheetUrl: '#', folderUrl: '#', today: '2026-10-14' }),
  apiExtract: (req) => {
    const draft = ctx.parseInvoiceText(fs.readFileSync(path.join(__dirname, 'samples', sample), 'utf8'));
    const validation = ctx.Shared.validateDraft(JSON.parse(JSON.stringify(draft)), { today: '2026-10-14' });
    const hash = 'h' + req.data.length;
    const duplicates = db.invoices.filter((i) => i.imageHash === hash || i.key === ctx.Shared.businessKey(draft.header))
      .map((i) => ({ invoiceId: i.invoiceId, reason: i.imageHash === hash ? 'same_image' : 'same_details', invoiceNumber: i.header.invoiceNumber, partyName: i.header.partyName, date: i.header.date, total: i.header.total, currency: i.header.currency }));
    return { requestId: req.requestId, imageFileId: 'file1', imageUrl: 'https://drive.google.com/file/d/file1/view', imageHash: hash, engine: 'drive', draft, validation, duplicates, warnings: [] };
  },
  apiSave: (req) => {
    if (db.saved[req.requestId]) return { saved: true, alreadySaved: true, invoiceId: db.saved[req.requestId] };
    const d = req.draft;
    const v = ctx.Shared.validateDraft(d, { today: '2026-10-14' });
    const key = ctx.Shared.businessKey(d.header);
    const dups = db.invoices.filter((i) => i.invoiceId !== req.invoiceId && (i.key === key || (!req.invoiceId && i.imageHash === req.imageHash)));
    if (dups.length && !req.confirmDuplicate) {
      return { saved: false, duplicates: dups.map((i) => ({ invoiceId: i.invoiceId, reason: 'same_details', invoiceNumber: i.header.invoiceNumber, partyName: i.header.partyName, date: i.header.date, total: i.header.total, currency: i.header.currency })) };
    }
    const status = v.issues.length === 0 ? 'Verified' : (req.confirmIssues ? 'Confirmed with issues' : 'Needs review');
    const id = req.invoiceId || 'INV-20261014-' + (db.invoices.length + 1);
    const uncertainFields = Object.keys(d.confidence || {}).filter((k) => d.confidence[k] === 'low');
    const rec = { uncertainFields, invoiceId: id, header: d.header, items: d.items, issues: v.issues, reviewStatus: status, key, imageHash: req.imageHash, engine: req.engine, imageUrl: 'https://drive.google.com/file/d/file1/view', createdAt: '2026-10-14T10:00:00' };
    db.invoices = db.invoices.filter((i) => i.invoiceId !== id).concat([rec]);
    db.saved[req.requestId] = id;
    api.saveCalls = (api.saveCalls || 0) + 1;
    return { saved: true, invoiceId: id, reviewStatus: status, issues: v.issues };
  },
  apiList: (f) => {
    f = f || {};
    let list = db.invoices.map((i) => ({ invoiceId: i.invoiceId, type: i.header.type, invoiceNumber: i.header.invoiceNumber, date: i.header.date, partyName: i.header.partyName, currency: i.header.currency, total: i.header.total, reviewStatus: i.reviewStatus }));
    if (f.q) list = list.filter((i) => JSON.stringify(i).toLowerCase().includes(f.q.toLowerCase()));
    if (f.type) list = list.filter((i) => i.type === f.type);
    return { invoices: list.slice(0, f.limit || 200), total: list.length };
  },
  apiGet: (id) => { const i = db.invoices.find((x) => x.invoiceId === id); return Object.assign({ thumbnail: '', imageFileId: 'file1' }, i); },
  apiSaveSettings: () => ({ geminiConfigured: true })
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__api', async (name, arg) => {
    await new Promise((r) => setTimeout(r, 150));
    return JSON.stringify(api[name](JSON.parse(arg)));
  });
  const htmlPath = path.join(OUT, 'page.html');
  fs.writeFileSync(htmlPath, buildPage());
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(500);
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const results = [];
  const check = (name, cond) => { results.push((cond ? 'PASS ' : 'FAIL ') + name); };

  await shot('01-home-ar');
  // A tiny real image for the file input.
  const img = path.join(OUT, 'invoice.png');
  await page.screenshot({ path: img, clip: { x: 0, y: 0, width: 300, height: 200 } });

  await page.setInputFiles('#fileInput', img);
  await page.waitForSelector('#screen-review:not(.hidden)');
  await page.waitForTimeout(400);
  await shot('02-review-ar');
  check('review shows 3 items', (await page.locator('#itemsTable tbody tr').count()) === 3);
  check('date marked uncertain', await page.locator('#fld-date.conf-low').count() === 1);
  check('confirm checkbox visible when issues exist', await page.locator('#confirmWrap:not(.hidden)').count() === 1);

  // Break a line total: the row must turn red and an issue must appear.
  await page.fill('[data-i="1"][data-c="lineTotal"]', '1400');
  await page.waitForTimeout(400);
  check('edited mismatch flagged', await page.locator('tr[data-row="1"].bad').count() === 1);
  await shot('03-review-mismatch');
  await page.fill('[data-i="1"][data-c="lineTotal"]', '1 350,00');
  await page.waitForTimeout(400);
  check('mismatch cleared after fix (French number format)', await page.locator('tr.bad').count() === 0);

  // Double-click save: only one invoice may be stored.
  await page.locator('#saveBtn').dblclick();
  await page.waitForSelector('#screen-details:not(.hidden)');
  await page.waitForTimeout(600);
  check('saved once despite double click', db.invoices.length === 1 && api.saveCalls === 1);
  check('unconfirmed issues => Needs review', db.invoices[0].reviewStatus === 'Needs review');
  await shot('04-details');

  // Same image again: duplicate warning, and save is blocked until confirmed.
  await page.click('.tabbar [data-nav="home"]');
  await page.setInputFiles('#fileInput', img);
  await page.waitForSelector('#screen-review:not(.hidden)');
  await page.waitForTimeout(300);
  check('duplicate banner shown at review', await page.locator('#dupBox .banner').count() === 1);
  await page.click('#saveBtn');
  await page.waitForSelector('#modalBack:not(.hidden)');
  check('save blocked by duplicate dialog', db.invoices.length === 1);
  await shot('05-duplicate-dialog');
  await page.click('#mCancel');

  // Confirm flagged values -> "Confirmed with issues" (edit mode on the existing invoice).
  await page.click('#cancelReviewBtn');
  await page.click('#mDiscard');
  await page.click('.tabbar [data-nav="history"]');
  await page.waitForTimeout(500);
  await shot('06-history');
  check('history lists the invoice', await page.locator('#historyList .inv').count() === 1);
  await page.fill('#fQ', 'nothing-matches');
  await page.waitForTimeout(800);
  check('search filters', await page.locator('#historyList .inv').count() === 0);
  await page.fill('#fQ', 'FA-2026');
  await page.waitForTimeout(800);
  await page.click('#historyList .inv');
  await page.waitForSelector('#editBtn');
  await page.click('#editBtn');
  await page.waitForSelector('#screen-review:not(.hidden)');
  await page.check('#confirmIssues');
  await page.click('#saveBtn');
  await page.waitForTimeout(800);
  check('edit keeps one invoice', db.invoices.length === 1);
  check('explicit confirmation => Confirmed with issues', db.invoices[0].reviewStatus === 'Confirmed with issues');

  // English / LTR rendering of the Arabic sample.
  sample = 'ar_invoice.txt';
  await page.click('#langBtn');
  await page.click('.tabbar [data-nav="home"]');
  await page.setInputFiles('#fileInput', img);
  await page.waitForSelector('#screen-review:not(.hidden)');
  await page.waitForTimeout(300);
  await shot('07-review-en-arabic-invoice');
  check('dir switches to ltr', await page.evaluate(() => document.documentElement.dir) === 'ltr');
  await page.click('#langBtn');
  await page.waitForTimeout(200);
  await shot('08-review-ar-arabic-invoice');

  check('no page errors', errors.length === 0);
  console.log(results.join('\n'));
  if (errors.length) console.log('Errors:\n' + errors.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
