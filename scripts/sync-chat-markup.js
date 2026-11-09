/* Write the chat widget's markup into the three hand-coded pages.
 *
 * product.html, 購物車.html and account.html are out of Phase 9 scope (owner,
 * 16 Sep 2026) and stay hand-coded, so they do not go through the renderer and
 * do not get renderer/chrome/chat.html for free. At P13-T5 the block was
 * therefore COPIED into each of them by hand.
 *
 * WHY THIS SCRIPT EXISTS. That copy drifted, and it drifted on the worst
 * string. renderer/chrome/chat.html's own comment claims "there is ONE copy of
 * every string, in data/site.json"; in fact there were four, and three of them
 * carried a superseded refusal - the one string that carries the health
 * disclaimer, reading "本對話無法解答" where data/site.json says "此處不提供解答".
 * The wording was changed centrally (17b4e49) and the three copies were not,
 * which is also how they came to use the first-person phrasing the owner had
 * explicitly rejected (BUILD_TASKS P13-T5, "impersonal by owner decision").
 *
 * Nothing noticed for a fortnight, because nothing could: no gate compared
 * them. Policing four copies with a test only tells you they have diverged.
 * So these three pages are now GENERATED from the same partial the renderer
 * uses, and scripts/test-chat.js asserts they still match it - a gate that can
 * be satisfied by running this, rather than by hand-editing three files.
 *
 * Run it after editing renderer/chrome/chat.html or data/site.json's `chat`
 * block. It is idempotent: an unchanged run leaves git clean.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { fillChat, siteData } = require(path.join(ROOT, 'renderer', 'chrome.js'));

/* The three pages, and the language they are in. They are zh-only and carry
   noindex; there is no per-language variant to keep in step. */
const PAGES = ['product.html', '購物車.html', 'account.html'];
const LANG = 'zh';

/* The region replaced: from the launcher button to just before the behaviour
   script that follows the panel. Anchored on both ends so a partial match
   cannot eat the rest of the document. */
const START = '<button type="button" class="wh-chat-launcher"';
const END = '<script src="assets/behaviour/chat.js"';

function block() {
  const partial = fs.readFileSync(
    path.join(ROOT, 'renderer', 'chrome', 'chat.html'), 'utf8');
  const filled = fillChat(partial, siteData(), LANG);
  /* The partial's leading comment is about the renderer's token syntax, which
     means nothing in a hand-coded page. Everything from the launcher on is the
     markup itself. */
  const from = filled.indexOf(START);
  if (from === -1) throw new Error('renderer/chrome/chat.html: no launcher found');
  return filled.slice(from).trimEnd() + '\n';
}

/* Exported so scripts/test-chat.js can assert the pages match WITHOUT this
   script having to run first - the gate must be able to fail. */
function expected() {
  return block();
}

function sync() {
  const wanted = block();
  const changed = [];
  const missing = [];

  for (const page of PAGES) {
    const file = path.join(ROOT, page);
    let html;
    try { html = fs.readFileSync(file, 'utf8'); }
    catch (e) { missing.push(page); continue; }

    const from = html.indexOf(START);
    const to = html.indexOf(END);
    if (from === -1 || to === -1 || to < from) { missing.push(page); continue; }

    const next = html.slice(0, from) + wanted + html.slice(to);
    if (next === html) { console.log('  unchanged  ' + page); continue; }

    fs.writeFileSync(file, next);
    changed.push(page);
    console.log('  written    ' + page);
  }

  if (missing.length) {
    console.error('\n  COULD NOT PATCH: ' + missing.join(', '));
    console.error('  Expected the launcher button and the chat.js script tag in each.');
  }
  return { changed: changed, missing: missing };
}

module.exports = { expected: expected, sync: sync, PAGES: PAGES, START: START, END: END };

if (require.main === module) {
  console.log('\nchat markup -> the three hand-coded pages\n');
  const result = sync();
  console.log('\n' + (result.missing.length
    ? '=== ' + result.missing.length + ' PAGE(S) COULD NOT BE PATCHED ==='
    : result.changed.length + ' page(s) updated, ' +
      (PAGES.length - result.changed.length) + ' already current'));
  process.exit(result.missing.length ? 1 : 0);
}
