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

test('first run: setup code from the sheet, then username + password sign-in', () => {
  const s = makeServer();
  const ping = s.call('ping', {});
  assert.equal(ping.data.setupNeeded, true);
  const code = s.setupCode();
  assert.match(code, /^\d{6}$/);
  assert.ok(s.logs.some((l) => l.message.includes(code)), 'code written to ProcessingLog');
  assert.equal(s.call('auth.setup', { setupCode: '000000', username: 'abdou', password: 'Secret#2026' }).error.code, 'setup_code_wrong');
  assert.equal(s.call('auth.setup', { setupCode: code, username: 'abdou', password: 'short' }).error.code, 'password_format');
  assert.equal(s.call('auth.setup', { setupCode: code, username: 'a b', password: 'Secret#2026' }).error.code, 'username_format');
  const ok = s.call('auth.setup', { setupCode: code, username: 'Abdou', password: 'Secret#2026' });
  assert.ok(ok.ok);
  assert.ok(s.call('invoices.list', {}, ok.data.token).ok);
  assert.equal(s.call('auth.setup', { setupCode: code, username: 'x', password: 'other-pass' }).error.code, 'already_setup');
  assert.equal(s.call('ping', {}).data.setupNeeded, false);
  assert.ok(!Object.values(s.props).some((v) => v.includes('Secret#2026')), 'password stored only as a hash');
  assert.ok(s.call('auth.login', { username: ' ABDOU ', password: 'Secret#2026' }).ok, 'username is case-insensitive');
  assert.equal(s.call('auth.login', { username: 'other', password: 'Secret#2026' }).error.code, 'login_wrong');
});

test('wrong passwords lock sign-in; changing the password invalidates old tokens', () => {
  const s = makeServer();
  s.call('ping', {});
  const t1 = s.call('auth.setup', { setupCode: s.setupCode(), username: 'abdou', password: 'Secret#2026' }).data.token;
  for (let i = 0; i < 5; i++) assert.equal(s.call('auth.login', { username: 'abdou', password: 'guess' + i }).error.code, 'login_wrong');
  assert.equal(s.call('auth.login', { username: 'abdou', password: 'Secret#2026' }).error.code, 'locked');
  delete s.props.LOCK_UNTIL;
  assert.equal(s.call('auth.changePassword', { currentPassword: 'nope', newPassword: 'New-pass-2026' }, t1).error.code, 'password_wrong');
  const t2 = s.call('auth.changePassword', { currentPassword: 'Secret#2026', newPassword: 'New-pass-2026' }, t1);
  assert.ok(t2.ok);
  // Tokens issued before the change stop working (same-millisecond tokens aside).
  s.props.PW_CHANGED_MS = String(Date.now() + 1);
  assert.equal(s.call('invoices.list', {}, t1).error.code, 'auth_expired');
  assert.ok(s.call('auth.login', { username: 'abdou', password: 'New-pass-2026' }).ok);
});
