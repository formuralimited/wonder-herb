/* The admin and the site talking to a real MongoDB-backed API in a real DOM.
 * Uses a throwaway database, so your working data is untouched.
 */
process.env.MONGO_DB = process.env.MONGO_DB_TEST || 'wonderherb_test';
const PORT = 4112;
const API = 'http://localhost:' + PORT;

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
/* jsdom is a devDependency, so it never ships with the site. */
const { JSDOM, VirtualConsole } = require('jsdom');

const app = require('../server/index');
const { connect, close, COLLECTIONS, AUTH_COLLECTIONS } = require('../server/db');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '   -> ' + extra : ''));
  if (!cond) fail++;
};
const settle = ms => new Promise(r => setTimeout(r, ms));

/* Real fetch for the API, disk for the page's own relative files. */
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
    dom.window.addEventListener('load', () => setTimeout(() => resolve(dom), 40));
  });
}

(async () => {
  const db = await connect();
  for (const c of Object.values(COLLECTIONS)) await db.collection(c).deleteMany({});
  await db.collection('homepage').deleteMany({});

  await db.collection(COLLECTIONS.products).insertMany([
    { pos: 0, id: 1, sku: 'WH-DB-1', title: 'Database Product One', price: '500.00',
      status: 'In Stock', stock: 25, reorder: 10, desc: 'from mongo', cat: 'special' },
    { pos: 1, id: 2, sku: 'WH-DB-2', title: 'Database Product Two', price: '900.00',
      status: 'In Stock', stock: 3, reorder: 10, desc: 'nearly gone', cat: 'special' }
  ]);
  await db.collection(COLLECTIONS.cases).insertOne({ pos: 0, zh: { title: '資料庫病例' }, en: { title: 'DB case' } });
  await db.collection(COLLECTIONS.faq).insertOne({ pos: 0, id: 1, cat: 'General', q: 'From Mongo?', a: 'Yes.' });

  await db.collection(AUTH_COLLECTIONS.users).deleteMany({});
  await db.collection(AUTH_COLLECTIONS.sessions).deleteMany({});

  const server = app.listen(PORT);
  await new Promise(r => server.once('listening', r));

  /* Saving needs a signed-in account with editing rights, so the suite creates
     an administrator and drives the console as that person. */
  const adminToken = await fetch(API + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'UI Admin', email: 'ui-admin@example.com',
                           password: 'ui-suite-password', asAdmin: true })
  }).then(r => r.json()).then(d => d.token);
  let up = true;
  const apiUp = () => up;

  /* THE ADMIN CONSOLE IS GONE. admin/index.html was deleted on 13 Nov 2026
     (owner), so the checks that drove its chip, its inventory table and its
     toast have nothing to drive. The WRITES they performed are kept and done
     through the API instead, because that is now the only way into the
     database - and because the publish section below asserts the stock state
     those writes produce. Deleting them would have left it asserting nothing
     while still passing, which is the finding-23 shape exactly.

     Everything still checked here is checked against MongoDB itself, not
     against a screen: the write lands, the movement is logged with its note,
     and an edit does not lose the stock it was not shown (finding 25). */
  console.log('\n=== A stock change is written to MongoDB ===\n');

  const authed = (path, body) => fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify(body)
  });

  const adjusted = await authed('/api/stock/WH-DB-1/adjust',
    { type: 'sale', qty: 25, note: 'Sold at the clinic' });
  check('the API accepts the stock adjustment', adjusted.ok, 'HTTP ' + adjusted.status);

  const inDb = await db.collection(COLLECTIONS.products).findOne({ sku: 'WH-DB-1' });
  check('the new count is in MongoDB', inDb.stock === 0, String(inDb.stock));
  check('MongoDB marked it Out of Stock', inDb.status === 'Out of Stock', inDb.status);
  const move = await db.collection(COLLECTIONS.movements).findOne({ sku: 'WH-DB-1' });
  check('the movement is stored server-side with its note',
    move && move.note === 'Sold at the clinic' && move.delta === -25);

  console.log('\n=== Editing a product writes through ===\n');
  const rows = await (await fetch(API + '/api/cms?type=products')).json();
  const next = rows.map(r => r.sku === 'WH-DB-2' ? Object.assign({}, r, { price: '999.00' }) : r);
  const saved = await authed('/api/cms?type=products', next);
  check('the API accepts the product edit', saved.ok, 'HTTP ' + saved.status);

  const edited = await db.collection(COLLECTIONS.products).findOne({ sku: 'WH-DB-2' });
  check('the edited price is in MongoDB', edited.price === '999.00', edited.price);
  check('its stock was not lost by the edit', edited.stock === 3, String(edited.stock));

  // ------------------------------------------------------------ the site
  /* RETARGETED AT P9-T1. 產品介紹 is now pre-rendered: its old hand-coded
     version (legacy/) read MongoDB in the browser; the page GitHub Pages serves
     has its catalogue baked in at PUBLISH. So "the site reads the same database"
     now means: what the API returns is exactly what the publish renders - the
     accepted behaviour change that a stock edit goes live at publish, not
     instantly (BUILD_TASKS P9-T1). The cart's refusal of an out-of-stock card is
     proven by effect in test:behaviour; this suite proves the database reaches
     the card. product.html is still client-side, so its live check stays. */
  console.log('\n=== The database reaches the site at publish ===\n');
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'renderer', 'build-sections.js')], { cwd: ROOT, stdio: 'pipe' });
  const renderer = require('../renderer/render');
  const tree = renderer.loadTree(path.join(ROOT, 'data', 'pages', 'products.json'));
  const apiRows = await (await fetch(API + '/api/cms?type=products')).json();
  const published = renderer.renderPage(tree, 'zh', Object.assign(renderer.loadData(), { products: apiRows }),
    { chrome: renderer.loadChrome(tree.assets.chromeFrom) });
  const pd = new JSDOM(published).window.document;
  const card = sku => pd.querySelector('.product-card[data-sku="' + sku + '"]');
  check('a product that exists only in MongoDB is on the published catalogue', !!card('WH-DB-1'), 'WH-DB-1 card');
  check('with the stock state just written through the API (Out of Stock)',
    card('WH-DB-1') && card('WH-DB-1').getAttribute('data-status') === 'Out of Stock',
    card('WH-DB-1') && card('WH-DB-1').getAttribute('data-status'));
  check('and a price edited through the API is the price the published cart charges',
    card('WH-DB-2') && card('WH-DB-2').getAttribute('data-price') === '999',
    card('WH-DB-2') && card('WH-DB-2').getAttribute('data-price'));

  const det = await loadPage('product.html',
    'http://localhost:8000/product.html?sku=WH-DB-1', apiUp, API);
  await settle(300);
  const btn = det.window.document.getElementById('detailAddBtn');
  check('the product page disables Add to Cart', !!btn && btn.hasAttribute('disabled'));

  // ------------------------------------------------------------ fallback
  console.log('\n=== With MongoDB stopped, nothing breaks ===\n');
  up = false;
  /* The three checks that stood here drove admin/index.html's offline chip and
     its demo-mode fallback. The file is gone (13 Nov 2026, owner), and with no
     admin there is nothing left to degrade gracefully - which is why they are
     not replaced rather than rewritten.
     What hard rule 1 actually protects is below and is unchanged: the PUBLIC
     site must not depend on the API being up. That is the half that always
     mattered, and it is the half a visitor sees. */

  /* The committed, pre-rendered 產品介紹 needs neither MongoDB nor scripts: the
     catalogue is IN the file, one card per committed product. */
  const committed = new JSDOM(read('產品介紹.html')).window.document;      // no runScripts: nothing executes
  const committedCards = committed.querySelectorAll('.product-card').length;
  check('the catalogue is in the committed page itself - no database, no scripts',
    committedCards > 0 && committedCards === JSON.parse(read('data/products.json')).length,
    committedCards + ' cards, ' + JSON.parse(read('data/products.json')).length + ' committed products');

  // ------------------------------------------------------------ published site
  console.log('\n=== The published site never calls localhost ===\n');
  let calledApi = false;
  const vc = new VirtualConsole();
  const pub = new JSDOM(read('產品介紹.html'), {
    url: 'https://www.wonder-herb.com/%E7%94%A2%E5%93%81%E4%BB%8B%E7%B4%B9.html',
    runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.alert = () => {};
      w.fetch = (url) => {
        if (/localhost|127\.0\.0\.1/.test(String(url))) calledApi = true;
        const name = String(url).split('/').pop();
        try {
          const body = fs.readFileSync(path.join(ROOT, 'data', name), 'utf8');
          return Promise.resolve({ ok: true, status: 200,
            text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
        } catch (e) { return Promise.resolve({ ok: false, status: 404 }); }
      };
    }
  });
  await new Promise(r => pub.window.addEventListener('load', () => setTimeout(r, 200)));
  check('no request to a local API from the live domain', calledApi === false);
  check('the live page still renders its catalogue',
    pub.window.document.querySelectorAll('.product-card').length > 0);
  /* jsdom does not load the page's external behaviour scripts, so read them.
   *
   * WHAT THIS ASSERTS, AND WHY IT CHANGED AT P15-T1. It used to say the
   * behaviour files make no network call AT ALL. That rule was never actually
   * true of the site: assets/behaviour/home-hero.js fetches the homepage's
   * .glb models, and the check only passed because it read the scripts on
   * 產品介紹, which does not carry it. So it was a page-specific accident, and
   * it broke the moment a second file legitimately called out - the chat
   * widget, whose whole purpose is to ask an answer service a question.
   *
   * THE REAL INVARIANT, which is stronger and now stated: no behaviour file
   * may NAME A HOST. Every fetch target is built from the DOM - home-hero
   * reads `data-model`, chat reads `data-api` - so where the site talks to is
   * data, re-pointable by a data edit and a re-render, and the published site
   * can never be found pointing at a developer's machine. That is the rule
   * BUILD_TASKS already states for media ("a behaviour file never names a
   * file: it reads data-model from the DOM"); this is the same rule for
   * origins. It is checked across EVERY behaviour file rather than the ones
   * one page happens to load, which is what closes the original blind spot.
   *
   * It does not weaken the guarantee that matters - a page must render without
   * the API. That is held by the scripts-off sweep and test:behaviour, which
   * drive these pages with no API running at all. */
  const allBehaviour = ['assets/site.js'].concat(
    fs.readdirSync(path.join(ROOT, 'assets', 'behaviour'))
      .filter(f => f.endsWith('.js')).map(f => 'assets/behaviour/' + f));

  /* Comments are stripped first. The check is about what the CODE reaches for,
     not what a comment mentions - assets/site.js explains in prose why it must
     not follow an hreflang to www.wonder-herb.com, and an unstripped match
     read that explanation as the offence it warns about. Line comments are
     matched only when not preceded by ':', so the // in https:// survives to
     be caught. */
  const stripComments = src => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const namesHost = allBehaviour.filter(
    f => /https?:\/\/|localhost|127\.0\.0\.1/.test(stripComments(read(f))));
  check('no behaviour file names a host: every fetch target comes from the DOM',
    allBehaviour.length >= 8 && namesHost.length === 0,
    allBehaviour.length + ' file(s) checked' +
    (namesHost.length ? '   NAMES A HOST: ' + namesHost.join(', ') : ''));

  /* And the published pages must not be carrying a configured API either: the
     one that would matter is a local one left in data/site.json by accident. */
  const apiAttr = (read('產品介紹.html').match(/data-api="([^"]*)"/) || [])[1];
  check('the published page carries no local API in its chat config',
    apiAttr !== undefined && !/localhost|127\.0\.0\.1/.test(apiAttr),
    'data-api=' + JSON.stringify(apiAttr));

  server.close();
  for (const c of Object.values(COLLECTIONS)) await db.collection(c).deleteMany({});
  await db.collection('homepage').deleteMany({});
  await db.collection(AUTH_COLLECTIONS.users).deleteMany({});
  await db.collection(AUTH_COLLECTIONS.sessions).deleteMany({});
  await close();

  console.log('');
  console.log(fail === 0 ? '=== ALL CHECKS PASSED ===' : '=== ' + fail + ' CHECK(S) FAILED ===');
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('\nTest run failed:', err);
  process.exit(1);
});
