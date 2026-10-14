// Copies the shared validation library from the server (src/Shared.js) to the
// app (app/js/shared.js). Run after editing src/Shared.js: npm run sync
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'Shared.js'), 'utf8');
fs.writeFileSync(path.join(root, 'app', 'js', 'shared.js'), '// Generated from src/Shared.js by scripts/sync-shared.js. Do not edit.\n' + src);
console.log('app/js/shared.js updated');
