/* Generate sitemap.xml from the page trees.
 *
 * WHY IT IS GENERATED NOW. It was maintained by hand, and when Phase 14 added
 * English it listed 15 Chinese URLs, no English ones and no hreflang
 * alternates - so every English page was invisible to search engines, which is
 * most of the reason for translating them. Nothing caught that, because
 * nothing had ever read this file.
 *
 * It is the same rule P13G-T2 states for llms.txt: regenerate from the trees
 * rather than maintain by hand, so it cannot drift from what is published.
 *
 * WHAT IT EMITS. One <url> per tree per language in LANGS_IN_SCOPE, each
 * carrying xhtml:link alternates for every language that page exists in, plus
 * x-default pointing at the primary. That is the reciprocal form Google asks
 * for: an alternate set where every URL lists every URL, itself included.
 *
 * LASTMOD. Preserved per URL from the existing sitemap where the URL is
 * already listed, because a page's content did not change just because this
 * file is now generated - bumping every date to today would tell crawlers 18
 * pages changed when none did. New URLs get the tree's own updatedAt, or
 * today if it has none.
 *
 *   node scripts/build-sitemap.js           # write it
 *   node scripts/build-sitemap.js --check   # fail if it is out of date
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'sitemap.xml');
const CHECK = process.argv.includes('--check');

const { pageUrl } = require(path.join(ROOT, 'renderer', 'head.js'));
const { LANGS_IN_SCOPE, PRIMARY, publishedTrees, loadTree } =
  require(path.join(ROOT, 'renderer', 'render.js'));
const { HREFLANG } = require(path.join(ROOT, 'renderer', 'head.js'));

/* Keep the dates the hand-written file already carried. */
function existingLastmod() {
  const out = new Map();
  let xml = '';
  try { xml = fs.readFileSync(FILE, 'utf8'); } catch (e) { return out; }
  const re = /<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g;
  let m;
  while ((m = re.exec(xml))) out.set(m[1], m[2]);
  return out;
}

function build() {
  const previous = existingLastmod();
  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">'
  ];

  for (const file of publishedTrees()) {
    const tree = loadTree(file);
    /* The alternate set is the same for every language of one page, and every
       member lists every member - including itself. A set where one URL omits
       another is not reciprocal, and Google ignores the lot. */
    const alternates = LANGS_IN_SCOPE.map(lang => ({
      hreflang: HREFLANG[lang] || lang,
      href: pageUrl(tree, lang)
    }));
    alternates.push({ hreflang: 'x-default', href: pageUrl(tree, PRIMARY) });

    for (const lang of LANGS_IN_SCOPE) {
      const loc = encodeURI(pageUrl(tree, lang));
      const lastmod = previous.get(loc) ||
        (tree.updatedAt ? String(tree.updatedAt).slice(0, 10) : today);
      lines.push('  <url>');
      lines.push('    <loc>' + loc + '</loc>');
      lines.push('    <lastmod>' + lastmod + '</lastmod>');
      for (const alt of alternates) {
        lines.push('    <xhtml:link rel="alternate" hreflang="' + alt.hreflang +
                   '" href="' + encodeURI(alt.href) + '"/>');
      }
      lines.push('  </url>');
    }
  }

  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

const wanted = build();
let current = '';
try { current = fs.readFileSync(FILE, 'utf8'); } catch (e) { /* first run */ }

if (CHECK) {
  if (current === wanted) {
    console.log('sitemap.xml is up to date');
    process.exit(0);
  }
  console.error('sitemap.xml is STALE - run `npm run sitemap`');
  process.exit(1);
}

if (current === wanted) {
  console.log('sitemap.xml unchanged');
} else {
  fs.writeFileSync(FILE, wanted);
  const urls = (wanted.match(/<loc>/g) || []).length;
  console.log('sitemap.xml written: ' + urls + ' URL(s), languages ' +
              LANGS_IN_SCOPE.join(', '));
}
