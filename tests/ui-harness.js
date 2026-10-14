// Renders the real web-app page in a phone-sized Chromium with an in-memory
// fake of the Apps Script backend, then walks through the main user flows.
// Usage: node tests/ui-harness.js <outDir>
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(process.env.PW_MODULE || 'playwright');
const load = require('./load');

const APP = path.join(__dirname, '..', 'app');
const OUT = process.argv[2] || path.join(__dirname, 'ui-out');
fs.mkdirSync(OUT, { recursive: true });
const ctx = load(['Shared.js', 'Parser.js']);
const API = 'https://script.google.com/macros/s/AKfycbydRt_CBITfNIMCNqgBTq00KU-uJKU2XdXe7aSz8HRjd2PJbCWwKxtcJf-ymovyp7Of0w/exec';

// Static server for app/ (what GitHub Pages serves).
function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    let f = decodeURIComponent(req.url.split('?')[0]);
    if (f.endsWith('/')) f += 'index.html';
    const file = path.join(APP, f);
    if (!file.startsWith(APP) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---- fake backend ----
const db = { invoices: [], items: {}, saved: {} };
let sample = 'fr_facture.txt';
const auth = { pin: null, token: 'tok-1' };
const publicApi = {
  ping: () => ({ api: '2.0.0', setupNeeded: !auth.pin }),
  'auth.setup': (p) => { if (p.setupCode !== '123456') throw { code: 'setup_code_wrong' }; auth.pin = p.pin; return { token: auth.token }; },
  'auth.login': (p) => { if (p.pin !== auth.pin) throw { code: 'pin_wrong' }; return { token: auth.token }; }
};
const routes = {
  'app.bootstrap': () => api.apiBootstrap(), 'invoices.extract': (p) => api.apiExtract(p), 'invoices.save': (p) => api.apiSave(p),
  'invoices.list': (p) => api.apiList(p), 'invoices.get': (p) => api.apiGet(p.invoiceId), 'settings.save': (p) => api.apiSaveSettings(p)
};
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
  await page.route(API + '*', async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    let body;
    try {
      if (publicApi[req.action]) body = { ok: true, data: publicApi[req.action](req.payload) };
      else if (req.token !== auth.token) body = { ok: false, error: { code: 'auth_required' } };
      else body = { ok: true, data: routes[req.action](req.payload) };
    } catch (e) { body = { ok: false, error: { code: e.code || 'server_error', message: String(e.message || e) } }; }
    await new Promise((r) => setTimeout(r, 120));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  const server = await serve();
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  await page.waitForSelector('#screen-login:not(.hidden)');
  await page.waitForTimeout(300);
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const results = [];
  const check = (name, cond) => { results.push((cond ? 'PASS ' : 'FAIL ') + name); };
  check('first run asks for setup code', await page.locator('#setupFields:not(.hidden)').count() === 1);
  await shot('00-setup');
  await page.fill('#setupCode', '111111');
  await page.fill('#pinInput', '246810');
  await page.fill('#pin2Input', '246810');
  await page.click('#loginBtn');
  await page.waitForTimeout(400);
  check('wrong setup code rejected', await page.locator('#loginError:not(.hidden)').count() === 1 && !auth.pin);
  await page.fill('#setupCode', '123456');
  await page.fill('#pinInput', '246810');
  await page.fill('#pin2Input', '246810');
  await page.click('#loginBtn');
  await page.waitForSelector('#screen-home:not(.hidden)');
  await page.waitForTimeout(300);
  check('setup creates PIN and signs in', auth.pin === '246810');
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

  // Sign out, wrong PIN, then the right PIN.
  await page.click('.tabbar [data-nav="settings"]');
  await page.click('#mDiscard');
  await page.waitForSelector('#screen-settings:not(.hidden)');
  await shot('10-settings');
  await page.click('#signOutBtn');
  await page.waitForSelector('#screen-login:not(.hidden)');
  check('sign out returns to PIN screen', await page.locator('#setupFields.hidden').count() === 1);
  await page.fill('#pinInput', '000000');
  await page.click('#loginBtn');
  await page.waitForTimeout(400);
  check('wrong PIN rejected', await page.locator('#loginError:not(.hidden)').count() === 1);
  await shot('09-login-wrong-pin');
  await page.fill('#pinInput', '246810');
  await page.click('#loginBtn');
  await page.waitForSelector('#screen-home:not(.hidden)');
  check('right PIN signs in', true);
  const manifest = await page.evaluate(() => fetch('manifest.webmanifest').then((r) => r.json()));
  check('manifest has icons', manifest.icons.length === 3);

  check('no page errors', errors.length === 0);
  server.close();
  console.log(results.join('\n'));
  if (errors.length) console.log('Errors:\n' + errors.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
