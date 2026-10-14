const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./load');
const { Shared } = load(['Shared.js']);

test('parseNumber handles international formats', () => {
  const cases = [
    ['1,234.56', 1234.56], ['1.234,56', 1234.56], ['1 234,56', 1234.56], ['1234,5', 1234.5],
    ['١٢٣٤٫٥٦', 1234.56], ['(12.00)', -12], ['1,500', 1500], ['12.5', 12.5], ['abc', null],
    ['1.234.567', 1234567], ['DA 9 844,87', 9844.87], [7, 7], ['', null]
  ];
  for (const [input, expected] of cases) assert.equal(Shared.parseNumber(input), expected, input);
});

test('validateDraft flags inconsistent totals and never passes them silently', () => {
  const draft = {
    header: { type: 'purchase', invoiceNumber: 'A1', date: '2026-10-01', partyName: 'X', currency: 'DZD',
      subtotal: '100', taxTotal: '19', total: '130' },
    items: [{ description: 'a', quantity: '2', unitPrice: '30', lineTotal: '60' },
            { description: 'b', quantity: '1', unitPrice: '40', lineTotal: '45' }],
    confidence: { partyName: 'low' }
  };
  const v = Shared.validateDraft(draft, { today: '2026-10-14' });
  const codes = JSON.parse(JSON.stringify(v.issues.map(i => i.code).sort()));
  assert.deepEqual(codes, ['item_total_mismatch', 'items_vs_subtotal', 'totals_mismatch', 'uncertain']);
});

test('validateDraft accepts a consistent invoice', () => {
  const draft = {
    header: { type: 'sales', invoiceNumber: '7', date: '2026-10-01', partyName: 'Client', currency: 'EUR',
      subtotal: 100, discountTotal: 10, taxTotal: 18, total: 108 },
    items: [{ description: 'a', quantity: 4, unitPrice: 25, lineTotal: 100, taxRate: 20 }],
    confidence: {}
  };
  const v = Shared.validateDraft(draft, { today: '2026-10-14' });
  assert.equal(v.issues.length, 0, JSON.stringify(v.issues));
});

test('businessKey ignores formatting differences', () => {
  const a = Shared.businessKey({ type: 'purchase', partyName: 'El Baraka ', invoiceNumber: 'FA-2026/0153', date: '2026-10-12', total: 9844.87 });
  const b = Shared.businessKey({ type: 'purchase', partyName: 'el baraka', invoiceNumber: 'FA 2026 0153', date: '2026-10-12', total: 9844.870 });
  assert.equal(a, b);
});
