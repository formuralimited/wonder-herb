/* The account page and the admin sign-in screen, in a real DOM, against a real
 * MongoDB-backed API. Uses a throwaway database, so your data is untouched.
 *
 *   node scripts/test-ui-auth.js
 */
process.env.MONGO_DB = process.env.MONGO_DB_TEST || 'wonderherb_test';
const PORT = 4114;
const API = 'http://localhost:' + PORT;

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* jsdom is a devDependency, so it never ships with the site. */
const { JSDOM, VirtualConsole } = require('jsdom');

const app = require('../server/index');
const authLib = require('../server/auth');
const { connect, close, COLLECTIONS, AUTH_COLLECTIONS, SALES_COLLECTIONS } = require('../server/db');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '   -> ' + extra : ''));
  if (!cond) fail++;
};
const settle = ms => new Promise(r => setTimeout(r, ms));

function makeFetch(apiUp) {
  return (url, opts) => {
    const u = String(url);
    if (/^https?:/.test(u)) {
      if (!apiUp()) return Promise.reject(new Error('connection refused'));
      return fetch(u, opts);
    }
    const name = u.split('/').pop();
    try {
      const body = fs.readFileSync(path.join(ROOT, 'data', name), 'utf8');
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body))
      });
    } catch (e) {
      return Promise.resolve({ ok: false, status: 404 });
    }
  };
}

function loadPage(file, url, apiUp, apiBase) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/navigation/.test(e.message)) console.log('  [page] ' + e.message.split('\n')[0]); });
  return new Promise(resolve => {
    const dom = new JSDOM(read(file), {
      url, runScripts: 'dangerously', virtualConsole: vc,
      beforeParse(w) {
        w.alert = m => { w.__lastAlert = m; };
        w.confirm = () => true;
        w.URL.createObjectURL = () => 'blob:stub';
        if (apiBase) w.WH_API_BASE = apiBase;
        w.fetch = makeFetch(apiUp);
      }
    });
    dom.window.addEventListener('load', () => setTimeout(() => resolve(dom), 60));
  });
}

/* Fill a field the way a person does, so the page's own handlers see it. */
const type = (d, id, value) => { d.getElementById(id).value = value; };
const submitForm = (w, d, id) =>
  d.getElementById(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

const usersRow = (d, email) => {
  const row = Array.from(d.querySelectorAll('#usersBody tr'))
    .find(r => r.textContent.includes(email));
  return row ? row.textContent.replace(/\s+/g, ' ').trim() : '';
};

const PASS = 'lantern-street-12';

(async () => {
  const db = await connect();
  const users = db.collection(AUTH_COLLECTIONS.users);
  const sessions = db.collection(AUTH_COLLECTIONS.sessions);
  for (const c of Object.values(COLLECTIONS)) await db.collection(c).deleteMany({});
  await users.deleteMany({});
  await sessions.deleteMany({});
  for (const c of Object.values(SALES_COLLECTIONS)) await db.collection(c).deleteMany({});
  authLib.throttleReset();

  const server = app.listen(PORT);
  await new Promise(r => server.once('listening', r));
  let up = true;
  const apiUp = () => up;

  // ------------------------------------------------------------ account page
  console.log('\n=== account.html: creating an account ===\n');
  let dom = await loadPage('account.html', 'http://localhost:8747/account.html', apiUp, API);
  let w = dom.window, d = w.document;

  check('the sign-in and register panels are shown', !d.getElementById('accountPanels').hidden);
  check('the member panel is not', d.getElementById('accountMember').hidden);
  check('the offline notice is not shown while the API is up',
    d.getElementById('accountOffline').hidden);
  check('the header account link is visible',
    d.getElementById('whAccountLink').style.display !== 'none');
  check('the page is kept out of search results',
    /noindex/.test(d.querySelector('meta[name="robots"]').getAttribute('content')));

  type(d, 'signupName', 'Wing Lau');
  type(d, 'signupEmail', 'wing@example.com');
  type(d, 'signupPassword', PASS);
  type(d, 'signupConfirm', 'something-else');
  submitForm(w, d, 'signupForm');
  await settle(120);
  // the page is in Chinese here, so this checks the message it actually shows
  check('a mismatched confirmation is caught before anything is sent',
    d.getElementById('signupMsg').textContent === '兩次輸入的密碼不相同' &&
    await users.countDocuments() === 0, d.getElementById('signupMsg').textContent);

  type(d, 'signupConfirm', PASS);
  submitForm(w, d, 'signupForm');
  await settle(500);

  const stored = await users.findOne({ email: 'wing@example.com' });
  check('registering from the page creates the account in MongoDB', !!stored);
  check('with the name that was typed', stored && stored.name === 'Wing Lau');
  check('and the password stored only as a hash',
    stored && !JSON.stringify(stored).includes(PASS) && /^scrypt\$/.test(stored.passwordHash));
  check('the page switches to the member panel',
    !d.getElementById('accountMember').hidden && d.getElementById('accountPanels').hidden);
  check('it greets the new member by name',
    d.getElementById('memberWelcome').textContent.includes('Wing Lau'),
    d.getElementById('memberWelcome').textContent);
  check('and shows the address it registered', d.getElementById('memberEmail').textContent === 'wing@example.com');
  check('the browser keeps a session token', !!w.localStorage.getItem('wh_auth_token'));
  check('and that token belongs to a session in the database',
    !!(await sessions.findOne({ _id: authLib.tokenHash(w.localStorage.getItem('wh_auth_token')) })));
  check('the header link shows as signed in',
    d.getElementById('whAccountLink').classList.contains('is-signed-in'));

  console.log('\n=== account.html: the seven languages ===\n');
  w.setLanguage('en');
  await settle(30);
  check('switching language relabels the account screen',
    d.querySelector('#accountMember [data-wh-t="change_title"]').textContent === 'Change password',
    d.querySelector('#accountMember [data-wh-t="change_title"]').textContent);
  w.setLanguage('ja');
  await settle(30);
  check('and again in Japanese',
    d.querySelector('#accountMember [data-wh-t="logout_btn"]').textContent === 'ログアウト',
    d.querySelector('#accountMember [data-wh-t="logout_btn"]').textContent);
  w.setLanguage('zh');
  await settle(30);
  check('and back in Chinese',
    d.querySelector('#accountMember [data-wh-t="logout_btn"]').textContent === '登出');

  console.log('\n=== account.html: changing the password and signing out ===\n');
  type(d, 'currentPassword', 'not-my-password');
  type(d, 'newPassword', 'brand-new-password');
  submitForm(w, d, 'passwordForm');
  await settle(600);
  check('a wrong current password is refused, with the reason shown',
    /not right/i.test(d.getElementById('passwordMsg').textContent),
    d.getElementById('passwordMsg').textContent);

  type(d, 'currentPassword', PASS);
  type(d, 'newPassword', 'brand-new-password');
  submitForm(w, d, 'passwordForm');
  await settle(700);
  check('the right one goes through', /已更新|changed/i.test(d.getElementById('passwordMsg').textContent),
    d.getElementById('passwordMsg').textContent);
  const rehashed = await users.findOne({ email: 'wing@example.com' });
  check('and the stored hash actually changed', rehashed.passwordHash !== stored.passwordHash);

  d.getElementById('logoutBtn').dispatchEvent(new w.Event('click', { bubbles: true }));
  await settle(400);
  check('signing out clears the token from the browser', !w.localStorage.getItem('wh_auth_token'));
  check('and the session from the database',
    await sessions.countDocuments({ userId: rehashed._id }) === 0);
  check('the sign-in panels come back', !d.getElementById('accountPanels').hidden);
  check('the account itself is still there', await users.countDocuments({ email: 'wing@example.com' }) === 1);

  console.log('\n=== account.html: signing back in ===\n');
  type(d, 'loginEmail', 'wing@example.com');
  type(d, 'loginPassword', 'wrong-one');
  submitForm(w, d, 'loginForm');
  await settle(600);
  check('a wrong password is refused on the page',
    /Wrong email or password/i.test(d.getElementById('loginMsg').textContent),
    d.getElementById('loginMsg').textContent);
  check('and no session was created', await sessions.countDocuments({ userId: rehashed._id }) === 0);

  type(d, 'loginPassword', 'brand-new-password');
  submitForm(w, d, 'loginForm');
  await settle(600);
  check('the new password signs in', !d.getElementById('accountMember').hidden);
  check('the password field is not left filled in', d.getElementById('loginPassword').value === '');
  check('a session exists again', await sessions.countDocuments({ userId: rehashed._id }) === 1);

  console.log('\n=== account.html with no API (the published site) ===\n');
  const offline = await loadPage('account.html', 'https://www.wonder-herb.com/account.html', apiUp, null);
  await settle(120);
  check('the account link is hidden on the public site',
    offline.window.document.getElementById('whAccountLink').style.display === 'none');
  check('the forms are replaced by a plain notice',
    !offline.window.document.getElementById('accountOffline').hidden &&
    offline.window.document.getElementById('accountPanels').hidden);
  check('the notice says so in the visitor\'s language',
    /WhatsApp/.test(offline.window.document.getElementById('accountOffline').textContent));

  const shop = await loadPage('產品介紹.html', 'https://www.wonder-herb.com/產品介紹.html', apiUp, null);
  await settle(120);
  check('and the product page keeps the header it always had',
    shop.window.document.getElementById('whAccountLink').style.display === 'none');

  /* THE ADMIN CONSOLE TESTS ARE GONE - 106 checks across the Users screen,
     staff permissions, the Sales screen, remembered sessions and the
     database-down state. admin/index.html was deleted on 13 Nov 2026 (owner),
     so there is no console to drive.

     What they asserted is NOT lost, and that is why they could go: every rule
     they exercised lives in the API, not the form, and test-auth.js asserts it
     there - signup, login, sessions, logout, password change, login throttling,
     per-module privileges, "the console cannot be emptied of administrators",
     and the protected super-admin. The UI tests proved the form honoured those
     rules; with no form, the rules are still proved.

     The account.html tests above stay: that page is still published, still
     talks to this API, and is still the only account UI a visitor has. */

  server.close();
  for (const c of Object.values(COLLECTIONS)) await db.collection(c).deleteMany({});
  for (const c of Object.values(SALES_COLLECTIONS)) await db.collection(c).deleteMany({});
  await users.deleteMany({});
  await sessions.deleteMany({});
  await close();

  console.log('');
  console.log(fail === 0 ? '=== ALL CHECKS PASSED ===' : '=== ' + fail + ' CHECK(S) FAILED ===');
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('\nTest run failed:', err);
  process.exit(1);
});
