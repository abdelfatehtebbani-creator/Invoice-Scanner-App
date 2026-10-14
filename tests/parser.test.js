const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const load = require('./load');

const ctx = load(['Shared.js', 'Parser.js']);
const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');
const parse = (name) => ctx.parseInvoiceText(sample(name));
const plain = (o) => JSON.parse(JSON.stringify(o));

test('French invoice with spaced thousands and TVA', () => {
  const d = parse('fr_facture.txt');
  assert.equal(d.header.invoiceNumber, 'FA-2026/0153');
  assert.equal(d.header.date, '2026-10-12');
  assert.equal(d.header.currency, 'DZD');
  assert.equal(d.header.subtotal, 8273);
  assert.equal(d.header.taxTotal, 1571.87);
  assert.equal(d.header.total, 9844.87);
  assert.equal(d.items.length, 3);
  assert.deepEqual(plain(d.items.map(i => [i.quantity, i.unitPrice, i.lineTotal])),
    [[4, 1250, 5000], [10, 135, 1350], [6, 320.5, 1923]]);
  assert.equal(d.items[0].description, 'Huile Elio 5L');
  assert.equal(d.confidence.total, 'high');
  const v = ctx.Shared.validateDraft(d, { today: '2026-10-14' });
  assert.equal(v.errors, 0, JSON.stringify(v.issues));
});

test('Arabic invoice with Arabic-Indic digits and discount', () => {
  const d = parse('ar_invoice.txt');
  assert.equal(d.header.invoiceNumber, '2026/45');
  assert.equal(d.header.date, '2026-10-05');
  assert.equal(d.header.currency, 'DZD');
  assert.equal(d.header.subtotal, 3540);
  assert.equal(d.header.discountTotal, 40);
  assert.equal(d.header.total, 3500);
  assert.equal(d.header.language, 'ar');
  assert.equal(d.items.length, 3);
  assert.deepEqual(plain(d.items.map(i => [i.description, i.quantity, i.unitPrice, i.lineTotal])),
    [['أرز بسمتي', 5, 220, 1100], ['زيت زيتون', 2, 950, 1900], ['حليب', 12, 45, 540]]);
  const v = ctx.Shared.validateDraft(d, { today: '2026-10-14' });
  assert.equal(v.errors, 0, JSON.stringify(v.issues));
});

test('English receipt without table header', () => {
  const d = parse('en_receipt.txt');
  assert.equal(d.header.type, 'expense');
  assert.equal(d.header.invoiceNumber, '88213');
  assert.equal(d.header.date, '2026-10-01');
  assert.equal(d.header.partyName, 'FRESH MART');
  assert.equal(d.header.subtotal, 13.25);
  assert.equal(d.header.taxTotal, 1.06);
  assert.equal(d.header.total, 14.31);
  assert.equal(d.header.amountPaid, 20);
  assert.equal(d.items.length, 3);
  assert.deepEqual(plain(d.items.map(i => [i.description, i.lineTotal])),
    [['Coffee', 7], ['Bagel', 2.5], ['Orange Juice', 3.75]]);
  assert.equal(d.items[0].quantity, 2);
});

test('Table read column by column', () => {
  const d = parse('columnar.txt');
  assert.equal(d.header.invoiceNumber, 'INV-7781');
  assert.equal(d.header.date, '2026-10-03');
  assert.equal(d.header.currency, 'USD');
  assert.equal(d.items.length, 3);
  assert.deepEqual(plain(d.items.map(i => [i.description, i.quantity, i.unitPrice, i.lineTotal, i.confidence])),
    [['A4 Paper Ream', 10, 4.5, 45, 'high'], ['Whiteboard Marker', 24, 1.25, 30, 'high'], ['Stapler', 3, 12, 36, 'high']]);
  assert.equal(d.header.total, 116.55);
  const v = ctx.Shared.validateDraft(d, { today: '2026-10-14' });
  assert.equal(v.errors, 0, JSON.stringify(v.issues));
});

test('Arabic payment receipt', () => {
  const d = parse('payment.txt');
  assert.equal(d.header.type, 'payment');
  assert.equal(d.header.invoiceNumber, '1207');
  assert.equal(d.header.date, '2026-09-28');
  assert.equal(d.header.total, 15000);
  assert.equal(d.header.currency, 'DZD');
  assert.equal(d.header.partyName, 'محمد بن علي');
  assert.equal(d.items.length, 0);
});
