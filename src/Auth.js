/**
 * Owner sign-in for the PWA.
 *
 * The web app must accept anonymous requests so the app hosted on GitHub Pages
 * can call it, so every data action requires a signed session token:
 *
 * - First run: the server writes a one-time setup code into the ProcessingLog
 *   sheet of the owner's private spreadsheet. Only someone who can open that
 *   spreadsheet can read it and choose the PIN.
 * - Sign-in: PIN (6-8 digits). Five wrong PINs lock sign-in for 15 minutes.
 * - Token: "<issuedMs>.<expiresMs>.<HMAC-SHA256>", signed with a random secret
 *   kept in Script Properties. Changing the PIN invalidates older tokens.
 * Nothing secret is stored in the app's code.
 */
var AUTH = {
  TOKEN_DAYS: 90,
  MAX_TRIES: 5,
  LOCK_MINUTES: 15,
  SETUP_CODE_MINUTES: 60
};

function AuthError_(code) {
  var e = new Error(code);
  e.name = 'AuthError';
  e.code = code;
  return e;
}

function authProps_() {
  return PropertiesService.getScriptProperties();
}

function authSecret_() {
  var p = authProps_();
  var s = p.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function authSign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, authSecret_())).replace(/=+$/, '');
}

function authHashPin_(pin, salt) {
  return authSign_('pin|' + salt + '|' + pin);
}

function authSetupNeeded_() {
  return !authProps_().getProperty('PIN_HASH');
}

/**
 * Creates (or reuses) the one-time setup code and writes it to ProcessingLog,
 * so the owner can read it in their own spreadsheet.
 */
function authIssueSetupCode_() {
  var p = authProps_();
  var code = p.getProperty('SETUP_CODE');
  var at = Number(p.getProperty('SETUP_CODE_AT') || 0);
  if (code && Date.now() - at < AUTH.SETUP_CODE_MINUTES * 60000) return;
  code = String(Math.floor(100000 + Math.random() * 900000));
  p.setProperty('SETUP_CODE', code);
  p.setProperty('SETUP_CODE_AT', String(Date.now()));
  logEvent_({ stage: 'setup-code', status: 'OK',
    message: 'Invoice Scanner setup code: ' + code + ' (valid ' + AUTH.SETUP_CODE_MINUTES + ' minutes)' });
}

function authCheckLock_() {
  var until = Number(authProps_().getProperty('LOCK_UNTIL') || 0);
  if (until > Date.now()) throw AuthError_('locked');
}

function authFailed_() {
  var p = authProps_();
  var tries = Number(p.getProperty('FAILED_TRIES') || 0) + 1;
  if (tries >= AUTH.MAX_TRIES) {
    p.setProperty('LOCK_UNTIL', String(Date.now() + AUTH.LOCK_MINUTES * 60000));
    tries = 0;
    logEvent_({ stage: 'login', status: 'LOCKED', message: 'Too many wrong PINs, sign-in locked' });
  }
  p.setProperty('FAILED_TRIES', String(tries));
}

function authCheckPinFormat_(pin) {
  if (!/^\d{6,8}$/.test(String(pin || ''))) throw AuthError_('pin_format');
}

function authIssueToken_() {
  var now = Date.now();
  var body = now + '.' + (now + AUTH.TOKEN_DAYS * 86400000);
  return body + '.' + authSign_('token|' + body);
}

function authSetPin_(pin) {
  var p = authProps_();
  var salt = Utilities.getUuid();
  p.setProperties({ PIN_SALT: salt, PIN_HASH: authHashPin_(pin, salt), PIN_CHANGED_MS: String(Date.now()) });
  p.deleteProperty('FAILED_TRIES');
}

/** First run: setup code from the spreadsheet + new PIN. */
function authSetup_(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!authSetupNeeded_()) throw AuthError_('already_setup');
    authCheckLock_();
    authCheckPinFormat_(payload.pin);
    var p = authProps_();
    var code = p.getProperty('SETUP_CODE');
    var at = Number(p.getProperty('SETUP_CODE_AT') || 0);
    if (!code || Date.now() - at > AUTH.SETUP_CODE_MINUTES * 60000) {
      authIssueSetupCode_();
      throw AuthError_('setup_code_expired');
    }
    if (String(payload.setupCode || '').trim() !== code) {
      authFailed_();
      throw AuthError_('setup_code_wrong');
    }
    authSetPin_(String(payload.pin));
    p.deleteProperty('SETUP_CODE');
    p.deleteProperty('SETUP_CODE_AT');
    logEvent_({ stage: 'setup', status: 'OK', message: 'PIN created' });
    return { token: authIssueToken_() };
  } finally {
    lock.releaseLock();
  }
}

function authLogin_(payload) {
  if (authSetupNeeded_()) throw AuthError_('setup_needed');
  authCheckLock_();
  var p = authProps_();
  if (authHashPin_(String(payload.pin || ''), p.getProperty('PIN_SALT')) !== p.getProperty('PIN_HASH')) {
    authFailed_();
    throw AuthError_('pin_wrong');
  }
  p.deleteProperty('FAILED_TRIES');
  return { token: authIssueToken_() };
}

function authVerify_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) throw AuthError_('auth_required');
  var body = parts[0] + '.' + parts[1];
  if (authSign_('token|' + body) !== parts[2]) throw AuthError_('auth_required');
  if (Number(parts[1]) < Date.now()) throw AuthError_('auth_expired');
  var changed = Number(authProps_().getProperty('PIN_CHANGED_MS') || 0);
  if (Number(parts[0]) < changed) throw AuthError_('auth_expired');
  return true;
}

function authChangePin_(payload) {
  var p = authProps_();
  if (authHashPin_(String(payload.currentPin || ''), p.getProperty('PIN_SALT')) !== p.getProperty('PIN_HASH')) {
    authFailed_();
    throw AuthError_('pin_wrong');
  }
  authCheckPinFormat_(payload.newPin);
  authSetPin_(String(payload.newPin));
  logEvent_({ stage: 'settings', status: 'OK', message: 'PIN changed' });
  return { token: authIssueToken_() };
}

/**
 * Run from the Apps Script editor if the PIN is forgotten: removes the PIN so
 * the app asks for a new setup code (written to ProcessingLog) on next open.
 */
function resetPin() {
  var p = authProps_();
  ['PIN_HASH', 'PIN_SALT', 'SETUP_CODE', 'SETUP_CODE_AT', 'LOCK_UNTIL', 'FAILED_TRIES'].forEach(function (k) {
    p.deleteProperty(k);
  });
  p.setProperty('PIN_CHANGED_MS', String(Date.now()));
  Logger.log('PIN removed. Open the app to set a new one.');
}
