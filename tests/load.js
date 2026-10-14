// Loads the Apps Script files into a Node VM so their pure logic can be tested.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function load(files) {
  const ctx = vm.createContext({ console });
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
};
