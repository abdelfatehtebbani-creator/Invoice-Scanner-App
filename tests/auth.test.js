// Runs the real Auth.js + Code.js request router against in-memory stand-ins
// for the Apps Script services.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeServer() {
  const props = {};
  const logs = [];
  const ctx = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      setProperties: (o) => Object.assign(props, o),
      deleteProperty: (k) => { delete props[k]; }
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()],
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url')
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {},
    Logger: { log() {} }
  });
  for (const f of ['Shared.js', 'Config.js', 'Auth.js', 'Code.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  ctx.logEvent_ = (e) => logs.push(e);
  ctx.ensureSetup_ = () => ({});
  ctx.apiList = () => ({ invoices: [], total: 0 });
  const call = (action, payload, token) =>
    JSON.parse(JSON.stringify(ctx.handleRequest_(JSON.stringify({ action, payload, token }))));
  const setupCode = () => props.SETUP_CODE;
  return { call, props, logs, setupCode };
}

test('data actions need a token', () => {
  const s = makeServer();
  assert.equal(s.call('invoices.list', {}).error.code, 'auth_required');
  assert.equal(s.call('invoices.list', {}, '1.2.forged').error.code, 'auth_required');
});

test('first run: setup code from the sheet, then PIN sign-in', () => {
  const s = makeServer();
  const ping = s.call('ping', {});
  assert.equal(ping.data.setupNeeded, true);
  const code = s.setupCode();
  assert.match(code, /^\d{6}$/);
  assert.ok(s.logs.some((l) => l.message.includes(code)), 'code written to ProcessingLog');
  assert.equal(s.call('auth.setup', { setupCode: '000000', pin: '246810' }).error.code, 'setup_code_wrong');
  assert.equal(s.call('auth.setup', { setupCode: code, pin: '12' }).error.code, 'pin_format');
  const ok = s.call('auth.setup', { setupCode: code, pin: '246810' });
  assert.ok(ok.ok);
  assert.ok(s.call('invoices.list', {}, ok.data.token).ok);
  assert.equal(s.call('auth.setup', { setupCode: code, pin: '999999' }).error.code, 'already_setup');
  assert.equal(s.call('ping', {}).data.setupNeeded, false);
  assert.ok(!('PIN' in s.props) && !Object.values(s.props).includes('246810'), 'PIN stored only as a hash');
});

test('wrong PINs lock sign-in; changing the PIN invalidates old tokens', () => {
  const s = makeServer();
  s.call('ping', {});
  const t1 = s.call('auth.setup', { setupCode: s.setupCode(), pin: '246810' }).data.token;
  assert.ok(s.call('auth.login', { pin: '246810' }).ok);
  for (let i = 0; i < 5; i++) assert.equal(s.call('auth.login', { pin: '000000' }).error.code, 'pin_wrong');
  assert.equal(s.call('auth.login', { pin: '246810' }).error.code, 'locked');
  delete s.props.LOCK_UNTIL;
  const t2 = s.call('auth.changePin', { currentPin: '246810', newPin: '13579135' }, t1);
  assert.ok(t2.ok);
  // Tokens issued before the change stop working (same-millisecond tokens aside).
  s.props.PIN_CHANGED_MS = String(Date.now() + 1);
  assert.equal(s.call('invoices.list', {}, t1).error.code, 'auth_expired');
  assert.ok(s.call('auth.login', { pin: '13579135' }).ok);
});
