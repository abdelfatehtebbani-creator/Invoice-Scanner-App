/**
 * Owner sign-in for the PWA (username + password).
 *
 * The web app must accept anonymous requests so the app hosted on GitHub Pages
 * can call it, so every data action requires a signed session token:
 *
 * - First run: the server writes a one-time setup code into the ProcessingLog
 *   sheet of the owner's private spreadsheet. Only someone who can open that
 *   spreadsheet can read it and create the username and password.
 * - Sign-in: username + password (8+ characters), stored only as a salted
 *   HMAC-SHA256 hash. Five wrong attempts lock sign-in for 15 minutes.
 * - Token: "<issuedMs>.<expiresMs>.<HMAC-SHA256>", signed with a random secret
 *   kept in Script Properties. Changing the password invalidates older tokens.
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

function authHashPassword_(password, salt) {
  return authSign_('pw|' + salt + '|' + password);
}

function authNormUser_(u) {
  return String(u || '').trim().toLowerCase();
}

function authSetupNeeded_() {
  return !authProps_().getProperty('PW_HASH');
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
    logEvent_({ stage: 'login', status: 'LOCKED', message: 'Too many wrong sign-in attempts, sign-in locked' });
  }
  p.setProperty('FAILED_TRIES', String(tries));
}

function authCheckCredentialsFormat_(username, password) {
  if (!/^[a-z0-9._@-]{3,40}$/.test(authNormUser_(username))) throw AuthError_('username_format');
  if (String(password || '').length < 8) throw AuthError_('password_format');
}

function authIssueToken_() {
  var now = Date.now();
  var body = now + '.' + (now + AUTH.TOKEN_DAYS * 86400000);
  return body + '.' + authSign_('token|' + body);
}

function authSetPassword_(username, password) {
  var p = authProps_();
  var salt = Utilities.getUuid();
  p.setProperties({
    USERNAME: authNormUser_(username), PW_SALT: salt, PW_HASH: authHashPassword_(password, salt),
    PW_CHANGED_MS: String(Date.now())
  });
  p.deleteProperty('FAILED_TRIES');
}

function authCredentialsOk_(username, password) {
  var p = authProps_();
  return authNormUser_(username) === p.getProperty('USERNAME') &&
    authHashPassword_(String(password || ''), p.getProperty('PW_SALT')) === p.getProperty('PW_HASH');
}

/** First run: setup code from the spreadsheet + new username and password. */
function authSetup_(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!authSetupNeeded_()) throw AuthError_('already_setup');
    authCheckLock_();
    authCheckCredentialsFormat_(payload.username, payload.password);
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
    authSetPassword_(payload.username, String(payload.password));
    p.deleteProperty('SETUP_CODE');
    p.deleteProperty('SETUP_CODE_AT');
    logEvent_({ stage: 'setup', status: 'OK', message: 'Account created for ' + authNormUser_(payload.username) });
    return { token: authIssueToken_() };
  } finally {
    lock.releaseLock();
  }
}

function authLogin_(payload) {
  if (authSetupNeeded_()) throw AuthError_('setup_needed');
  authCheckLock_();
  if (!authCredentialsOk_(payload.username, payload.password)) {
    authFailed_();
    throw AuthError_('login_wrong');
  }
  authProps_().deleteProperty('FAILED_TRIES');
  return { token: authIssueToken_(), username: authProps_().getProperty('USERNAME') };
}

function authVerify_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) throw AuthError_('auth_required');
  var body = parts[0] + '.' + parts[1];
  if (authSign_('token|' + body) !== parts[2]) throw AuthError_('auth_required');
  if (Number(parts[1]) < Date.now()) throw AuthError_('auth_expired');
  var changed = Number(authProps_().getProperty('PW_CHANGED_MS') || 0);
  if (Number(parts[0]) < changed) throw AuthError_('auth_expired');
  return true;
}

function authChangePassword_(payload) {
  authCheckLock_();
  var p = authProps_();
  if (!authCredentialsOk_(p.getProperty('USERNAME'), payload.currentPassword)) {
    authFailed_();
    throw AuthError_('password_wrong');
  }
  var username = payload.newUsername ? payload.newUsername : p.getProperty('USERNAME');
  authCheckCredentialsFormat_(username, payload.newPassword);
  authSetPassword_(username, String(payload.newPassword));
  logEvent_({ stage: 'settings', status: 'OK', message: 'Password changed' });
  return { token: authIssueToken_(), username: authNormUser_(username) };
}

/**
 * Run from the Apps Script editor if the password is forgotten: removes the
 * account so the app asks for a new setup code (written to ProcessingLog).
 */
function resetLogin() {
  var p = authProps_();
  ['USERNAME', 'PW_HASH', 'PW_SALT', 'SETUP_CODE', 'SETUP_CODE_AT', 'LOCK_UNTIL', 'FAILED_TRIES'].forEach(function (k) {
    p.deleteProperty(k);
  });
  p.setProperty('PW_CHANGED_MS', String(Date.now()));
  Logger.log('Login removed. Open the app to create a new username and password.');
}
