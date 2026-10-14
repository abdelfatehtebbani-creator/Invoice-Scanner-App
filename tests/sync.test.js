const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('app/js/shared.js matches src/Shared.js (run npm run sync)', () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'src', 'Shared.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app', 'js', 'shared.js'), 'utf8');
  assert.ok(app.endsWith(src));
});
