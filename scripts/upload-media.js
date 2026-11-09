/* P10-T4 - the uploader.
 *
 * Moves every media asset the site references onto one bucket we own, and
 * writes down what it did. Scripted rather than done by dashboard because a
 * scripted upload is repeatable and verifiable and a manual one is not: this
 * file is the only record of WHERE each byte came from, and `check:media`
 * (P10-T3) is the only check that it arrived intact.
 *
 * Two commands, deliberately separate:
 *
 *     npm run media:gather     fetch/read every asset, decide its name, write
 *                              data/media-plan.json. Touches no bucket.
 *     npm run media:upload     PUT the staged bytes, write
 *                              data/media-manifest.json. Needs credentials.
 *
 * They are separate because gathering is the step that can be WRONG and the
 * step a human must read. Four of the six hosts we are leaving do not simply
 * hand over a file - they redirect, transform, or serve an HTML page where a
 * PDF should be (see RESOLVERS). The plan is the proposal; the manifest is the
 * record of what is actually on the bucket. Collapsing them would mean the
 * only chance to notice that Drive served a virus-scan interstitial instead of
 * a lab report is after it is public and cached `immutable` for a year.
 *
 * Naming is content-addressed with no exceptions: <readable>-<sha8>.<ext>,
 * sha8 being the first 8 hex of the sha256 OF THE BYTES. That is what makes
 * `immutable` safe and what lets check:media verify a URL against itself. The
 * readable half is DERIVED from where the reference sits in the data
 * (pages/index.json.sections[0].fields.slides[4].poster -> index-slides-4-
 * poster), never hand-typed: a hand-typed name is a second source of truth
 * that drifts, and 38 of them would drift silently.
 *
 * What it does NOT do: it does not edit the data. Repointing the references is
 * P10-T5 and must go through MongoDB, because the database is the source of
 * truth for anything in a page tree and `npm run export` does not merge
 * (finding 41). The manifest carries each asset's original URLs so that edit
 * is mechanical, but it is a separate task with its own owner gate.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, 'media', '.staging');
const PLAN = path.join(ROOT, 'data', 'media-plan.json');
const MANIFEST = path.join(ROOT, 'data', 'media-manifest.json');

const ARGS = process.argv.slice(2);
const has = f => ARGS.includes(f);
const DRY = has('--dry-run');

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const site = readJson(path.join(ROOT, 'data', 'site.json'));
const media = site.media || {};
const CACHE = 'public, max-age=' + (media.cacheMinSeconds || 31536000) + ', immutable';

let fail = 0;
const problem = msg => { fail++; console.log('  FAIL  ' + msg); };

/* ------------------------------------------------------------- the inventory

   The same scanner shape as check-media.js and test-media.js. It is repeated
   rather than shared on purpose: if one copy stops seeing a reference, the
   other two still do, and a disagreement between them is itself the signal.
   A shared helper would have made all three blind at once, which is how the
   five Drive document links were invisible to the first inventory (P10-T2). */

const MEDIA_EXT = /\.(jpe?g|png|webp|avif|gif|svg|mp4|webm|glb|gltf|pdf)(\?|#|$)/i;
const MEDIA_HINT = /(googleusercontent|wixstatic|drive\.google\.com\/(thumbnail|uc|file\/d\/)|\/media\/|\/img\/|\/video\/)/i;
const looksLikeMedia = v => typeof v === 'string' && /^https?:\/\//.test(v) &&
  (MEDIA_EXT.test(v) || MEDIA_HINT.test(v));

function references() {
  const out = [];
  const walk = (o, where, at) => {
    if (typeof o === 'string') { if (looksLikeMedia(o)) out.push({ url: o, where: where + at }); return; }
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, where, at + '[' + i + ']'));
    if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => walk(v, where, at + '.' + k));
  };
  fs.readdirSync(path.join(ROOT, 'data/pages')).filter(f => f.endsWith('.json')).forEach(f =>
    walk(readJson(path.join(ROOT, 'data/pages', f)), 'pages/' + f, ''));
  ['products.json', 'cases.json', 'faq.json', 'homepage.json', 'site.json'].forEach(f => {
    const p = path.join(ROOT, 'data', f);
    if (fs.existsSync(p)) walk(readJson(p), f, '');
  });
  const seen = new Set();
  return out.filter(r => (seen.has(r.url) ? false : seen.add(r.url)));
}

/* The locally-hosted assets are not in that scan, because they are referenced
   by RELATIVE path and a relative path is not a host we are leaving. They are
   still part of the payload: the four models are 72 MB of Git history and the
   videos are 14 MB, both committed under the stated exception that the bucket
   did not exist yet (P10-T6, P10-T9).

   This is driven by the REFERENCES, exactly like the external scan, and not by
   reading the directory. The first draft did read the directory and ask
   `tree.includes(filename)` of each file, which pulled in the unreferenced
   PT3.glb - because `PT3.glb` is a substring of the referenced
   `bottle_PT3.glb`. It would have uploaded, and paid to serve, a model no page
   names. Three unreferenced .glb are committed and P10-T6 DELETES them; a
   scanner that cannot tell "referenced" from "present" cannot tell those two
   groups apart either. */

const LOCAL_MEDIA = /^(?!https?:|\/\/|data:)[^\s"']*\.(jpe?g|png|webp|avif|gif|svg|mp4|webm|glb|gltf|pdf)$/i;

function localAssets() {
  const out = [];
  const seen = new Set();
  const walk = (o, where, at) => {
    if (typeof o === 'string') {
      if (!LOCAL_MEDIA.test(o)) return;
      const rel = o.replace(/^\.\//, '');
      if (seen.has(rel)) return;
      seen.add(rel);
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) {
        problem(where + at + '\n          references ' + rel + ', which is not in the working' +
                ' tree. A reference to a file that' + '\n          does not exist cannot be' +
                ' re-hosted; fix the tree or the file.');
        return;
      }
      out.push({ url: rel, where: 'local:' + rel, local: abs });
      return;
    }
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, where, at + '[' + i + ']'));
    if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => walk(v, where, at + '.' + k));
  };
  fs.readdirSync(path.join(ROOT, 'data/pages')).filter(f => f.endsWith('.json')).forEach(f =>
    walk(readJson(path.join(ROOT, 'data/pages', f)), 'pages/' + f, ''));
  return out;
}

/* ------------------------------------------------------------- the resolvers

   Every host hands over its bytes a different way and three of them lie about
   it. This table is the whole reason gathering is a reviewable step.

   Unlike check-media.js, the gatherer DOES follow redirects: the point here is
   to copy what a browser gets from these hosts today. The contract that
   forbids redirects applies to the bucket we are moving TO. */

const RESOLVERS = [
  {
    host: 'drive.google.com',
    when: u => u.pathname === '/thumbnail',
    /* A transform endpoint. 302s to a googleusercontent host and serves a
       resized JPEG. We copy the resized result, not the original, because the
       resized result is what the page shows today and the diff must not move
       (P10-T5's HARD STOP). */
    to: u => u.href,
    note: 'Drive thumbnail transform; follows a 302 and yields the resized bytes'
  },
  {
    host: 'drive.google.com',
    when: u => /^\/file\/d\/[^/]+\/view/.test(u.pathname),
    /* THE TRAP. This URL is a viewer PAGE, not the file. Fetching it verbatim
       yields HTML, and uploading that HTML under a .pdf name would serve a
       broken download for a year behind `immutable`. Rewritten to the direct
       endpoint - and sniff() below is what actually catches the failure,
       because Drive ALSO serves an HTML interstitial from the direct endpoint
       for files it wants to virus-scan first. A rewrite is not a guarantee. */
    to: u => 'https://drive.google.com/uc?export=download&id=' + u.pathname.split('/')[3],
    note: 'Drive viewer page rewritten to the direct-download endpoint'
  },
  {
    host: 'lh3.googleusercontent.com',
    when: () => true,
    /* No extension anywhere in the URL. The extension comes from the bytes. */
    to: u => u.href,
    note: 'Drive-hosted image, no extension in the URL; type comes from the bytes'
  },
  {
    host: 'static.wixstatic.com',
    when: u => u.pathname.includes('/v1/fill/'),
    /* A Wix transform. These are the six host-resized images P10-T5 calls the
       risk: their bytes are being REGENERATED by a host we are leaving, at
       dimensions baked into the path. We copy the transform's output as-is so
       the dimensions come from the host that has been serving them, not from
       our own guess at what they should be. */
    to: u => u.href,
    note: 'Wix transform; bytes copied as served, at the dimensions in the path'
  }
];

/* Wix negotiates on Accept: the same URL serves AVIF or JPEG depending on what
   the client says it takes. Pinned here rather than left to the Node version's
   default, because the bytes decide the content hash and the hash decides the
   FILENAME - so an unpinned header makes the name unreproducible. */
const ACCEPT = 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8';

function resolve(ref) {
  if (ref.local) return { fetchUrl: null, note: 'read from the working tree' };
  const u = new URL(ref.url);
  for (const r of RESOLVERS) {
    if (r.host === u.host && r.when(u)) return { fetchUrl: r.to(u), note: r.note };
  }
  return { fetchUrl: ref.url, note: 'fetched as written' };
}

/* -------------------------------------------------------------- the sniffer

   The content type is decided by the BYTES, never by the URL, because half
   these URLs have no extension and two of the hosts serve HTML where a
   document should be. The server's own Content-Type is read too, and a
   DISAGREEMENT is a hard failure rather than a preference: if Drive says
   text/html and the magic numbers say PDF, something is wrong in a way no
   default resolves safely. */

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const MAGIC = [
  { ext: 'jpg',  type: 'image/jpeg',        test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'png',  type: 'image/png',         test: b => b.slice(0, 8).equals(PNG_MAGIC) },
  { ext: 'gif',  type: 'image/gif',         test: b => b.slice(0, 3).toString() === 'GIF' },
  { ext: 'pdf',  type: 'application/pdf',   test: b => b.slice(0, 5).toString() === '%PDF-' },
  { ext: 'glb',  type: 'model/gltf-binary', test: b => b.slice(0, 4).toString() === 'glTF' },
  { ext: 'webp', type: 'image/webp',        test: b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  /* avif before mp4: both are ISO-BMFF and both carry `ftyp` at offset 4, so
     an mp4 rule placed first would claim every AVIF on the site. */
  { ext: 'avif', type: 'image/avif',        test: b => b.slice(4, 8).toString() === 'ftyp' && /avif|avis/.test(b.slice(8, 12).toString()) },
  { ext: 'mp4',  type: 'video/mp4',         test: b => b.slice(4, 8).toString() === 'ftyp' },
  { ext: 'webm', type: 'video/webm',        test: b => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
  /* SVG and HTML are both text. SVG is matched on its root element; HTML is in
     this table precisely so it can be REJECTED with a reason, which is why its
     ext is null. */
  { ext: 'svg',  type: 'image/svg+xml',     test: b => /^\s*(<\?xml|<!DOCTYPE svg|<svg)/i.test(b.slice(0, 200).toString('utf8')) },
  { ext: null,   type: 'text/html',         test: b => /^\s*(<!DOCTYPE html|<html|<head|<body)/i.test(b.slice(0, 200).toString('utf8')) }
];

function sniff(body) {
  for (const m of MAGIC) {
    try { if (m.test(body)) return m; } catch (e) { /* body shorter than the probe */ }
  }
  return null;
}

/* -------------------------------------------------------------- the namer */

const slug = s => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/* pages/index.json.sections[0].fields.slides[4].poster -> index-0-slides-4-poster
   site.json.chrome.flags.zh                            -> site-flags-zh
   local:assets/video/case-testimony-1-d68fc7d5.mp4     -> case-testimony-1

   The noise words are dropped because every reference has them and they carry
   no information; the indices are kept because they are the only thing telling
   two sibling slides apart. The result is not guaranteed unique - the sha8 is
   what guarantees that - so a collision in the readable half is harmless. */

const NOISE = /^(json|sections|fields|seo|items|cards|slides|images|videos|jsonld|chrome)$/;

function readable(where) {
  if (where.startsWith('local:')) {
    const base = path.basename(where.slice(6)).replace(/\.[a-z0-9]+$/i, '');
    /* The video encodes are ALREADY content-addressed. Strip the old hash so
       the name does not end up carrying two of them. */
    return slug(base.replace(/-[0-9a-f]{8}$/i, ''));
  }
  const parts = where
    .replace(/^pages\//, '')
    /* Only the TREE FILE's extension, which is why this is anchored and not
       global. A global /\.json/ ate the middle of `.jsonld` too, and named the
       homepage's five product images `index-seold-N-image`. */
    .replace(/^([^.]+)\.json\./, '$1.')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(p => p && !NOISE.test(p));
  return slug(parts.join('-')) || 'asset';
}

/* ------------------------------------------------------------------ fetching */

async function get(url) {
  const t = Date.now();
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'accept': ACCEPT, 'user-agent': 'wonder-herb-media-gather/1.0' }
    });
    const body = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type'),
             body, ms: Date.now() - t, finalUrl: r.url };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, ms: Date.now() - t };
  }
}

/* ------------------------------------------------------------------- gather */

async function gather() {
  const refs = references().concat(localAssets());
  console.log('\n=== gather: ' + refs.length + ' reference(s) ===\n');

  fs.mkdirSync(STAGING, { recursive: true });

  /* Keyed by content hash, so bytes referenced twice are uploaded once. */
  const assets = new Map();

  for (const ref of refs) {
    const { fetchUrl, note } = resolve(ref);
    let body, serverType;

    if (ref.local) {
      body = fs.readFileSync(ref.local);
      serverType = null;
    } else {
      const r = await get(fetchUrl);
      if (!r.ok || !r.body || !r.body.length) {
        problem(ref.where + '\n          ' + (r.error || 'HTTP ' + r.status) + '  ' + fetchUrl);
        continue;
      }
      body = r.body;
      serverType = String(r.type || '').split(';')[0].trim().toLowerCase();
    }

    const m = sniff(body);
    if (!m) {
      problem(ref.where + '\n          bytes match no known type (' + body.length +
              ' bytes, starts ' + JSON.stringify(body.slice(0, 16).toString('latin1')) + ')');
      continue;
    }
    if (!m.ext) {
      /* The Drive interstitial, or a viewer page that slipped the rewrite. */
      problem(ref.where + '\n          served HTML, not a file (' + body.length + ' bytes).' +
              ' This host is serving a page where the' +
              '\n          asset should be - most likely Drive’s virus-scan interstitial.' +
              '\n          Fetch it by hand into media/.staging/ or fix the resolver.  ' + fetchUrl);
      continue;
    }
    /* A disagreement between the bytes and the server is not resolved by
       preferring one - it is reported. The bytes would win for the upload, but
       the mismatch still fails, because it means a host is mislabelling and we
       are one step from copying the label onto our own bucket.

       application/octet-stream is NOT a disagreement. It is the absence of a
       claim, and it is what Drive's direct-download endpoint says about every
       file it serves - all three lab-report PDFs came back that way on the
       first run. Treating "I don't know" as "I say it is not a PDF" failed
       three real assets whose bytes begin %PDF- unambiguously. This does not
       reopen the HTML hole: an interstitial is caught by ext === null above,
       which never consults the server's type at all. */
    const noClaim = !serverType || serverType === 'application/octet-stream' ||
                    serverType === 'binary/octet-stream';
    if (!noClaim && serverType !== m.type && !(m.ext === 'jpg' && serverType === 'image/jpg')) {
      problem(ref.where + '\n          the host says ' + serverType + ', the bytes are ' +
              m.type + ' (.' + m.ext + '). Resolve by hand rather than guess.');
      continue;
    }

    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const key = readable(ref.where) + '-' + sha.slice(0, 8) + '.' + m.ext;

    if (assets.has(sha)) {
      /* Same bytes, second reference. One object, two referrers - and the
         FIRST reference's name wins, so the key depends on iteration order no
         more than it has to. */
      const a = assets.get(sha);
      a.refs.push({ url: ref.url, where: ref.where });
      console.log('  SAME  ' + ref.where.padEnd(58) + '-> ' + a.key);
      continue;
    }

    fs.writeFileSync(path.join(STAGING, key), body);
    assets.set(sha, {
      key, bytes: body.length, type: m.type, sha256: sha,
      refs: [{ url: ref.url, where: ref.where }],
      fetchedFrom: fetchUrl, note
    });
    console.log('   ok   ' + ref.where.padEnd(58) + '-> ' + key +
                '  ' + (body.length / 1024).toFixed(0) + ' KB');
  }

  const list = [...assets.values()].sort((a, b) => a.key.localeCompare(b.key));
  const total = list.reduce((n, a) => n + a.bytes, 0);

  if (fail) {
    console.log('\n=== ' + fail + ' reference(s) could not be gathered ===');
    console.log('\n  No plan written. A partial plan is worse than none: the upload would');
    console.log('  succeed, check:media would pass on what IS there, and the missing');
    console.log('  assets would surface only as broken images on the live site.\n');
    process.exit(1);
  }

  fs.writeFileSync(PLAN, JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    note: 'P10-T4 gather. The PROPOSAL: what would be uploaded, and where each byte came ' +
          'from. data/media-manifest.json is the record of what actually IS on the bucket. ' +
          'Regenerate with: npm run media:gather',
    cacheControl: CACHE,
    assets: list
  }, null, 2) + '\n');

  console.log('\n  ' + list.length + ' asset(s), ' + (total / 1048576).toFixed(1) + ' MB');
  console.log('  staged in media/.staging/, planned in data/media-plan.json');
  console.log('\n  Read the plan before uploading - in particular the `note` on every Drive');
  console.log('  and Wix asset, because those are the ones a host resolved for us.\n');
}

/* ------------------------------------------------------------------- upload */

function credentials() {
  const need = ['OSS_BUCKET', 'OSS_REGION', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) {
    console.log('\n  Missing: ' + missing.join(', '));
    console.log('\n  Put them in .env, which is gitignored - .env.example says what each one');
    console.log('  is and how to get it. Then: npm run media:upload\n');
    process.exit(1);
  }
  const region = process.env.OSS_REGION.replace(/^oss-/, '');
  return {
    bucket: process.env.OSS_BUCKET,
    region,
    id: process.env.OSS_ACCESS_KEY_ID,
    secret: process.env.OSS_ACCESS_KEY_SECRET,
    /* Alibaba's own bucket domain, not a custom one: a custom domain is Phase
       18's job and, because every reference is a tree field, costs a data edit
       and a re-render rather than a migration. */
    endpoint: process.env.OSS_ENDPOINT ||
      'https://' + process.env.OSS_BUCKET + '.oss-' + region + '.aliyuncs.com',
    prefix: process.env.OSS_PREFIX || 'media/'
  };
}

async function upload() {
  if (!fs.existsSync(PLAN)) {
    console.log('\n  No data/media-plan.json. Run `npm run media:gather` first: the upload');
    console.log('  sends what the plan lists, precisely so a human can read it beforehand.\n');
    process.exit(1);
  }
  const plan = readJson(PLAN);
  const c = credentials();
  const { AwsClient } = require('aws4fetch');

  /* OSS speaks SigV4 under the `s3` service name, with the BARE region
     (cn-hongkong, not oss-cn-hongkong) in the credential scope, and wants
     x-oss-s3-compat on the request. aws4fetch is a plain SigV4 signer with no
     chunked encoding, which is the reason it was chosen: OSS does not accept
     chunked transfers, and SDKs whose SigV4 is welded to chunking fail here. */
  const aws = new AwsClient({
    accessKeyId: c.id, secretAccessKey: c.secret, service: 's3', region: c.region
  });

  console.log('\n=== upload: ' + plan.assets.length + ' asset(s) ===\n');
  console.log('        bucket     ' + c.bucket);
  console.log('        endpoint   ' + c.endpoint);
  console.log('        prefix     ' + c.prefix);
  console.log('        region     ' + c.region + ' (signing scope)');
  console.log('        cache      ' + CACHE);
  console.log('        mode       ' + (DRY ? '--dry-run: NOTHING IS SENT' : 'LIVE') + '\n');

  const done = [];
  for (const a of plan.assets) {
    const staged = path.join(STAGING, a.key);
    if (!fs.existsSync(staged)) {
      problem(a.key + ' is in the plan but not staged. Re-run media:gather.');
      continue;
    }
    const body = fs.readFileSync(staged);

    /* Re-verify the hash HERE, not only at gather. Staging is an ordinary
       folder on an ordinary disk and the plan may be days old; the name is a
       promise about the bytes, and this is the last moment that promise can be
       checked before it is cached `immutable` for a year. */
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    if (sha !== a.sha256) {
      problem(a.key + ': staged bytes hash ' + sha.slice(0, 8) + ', plan says ' +
              a.sha256.slice(0, 8) + '. Re-run media:gather.');
      continue;
    }

    const url = c.endpoint.replace(/\/+$/, '') + '/' + c.prefix + a.key;
    if (DRY) {
      console.log('   dry  ' + a.key.padEnd(52) + String((a.bytes / 1024).toFixed(0)).padStart(6) +
                  ' KB  -> ' + url.replace(/^https?:\/\//, ''));
      done.push(a);
      continue;
    }

    const r = await aws.fetch(url, {
      method: 'PUT',
      body,
      headers: {
        'content-type': a.type,
        'cache-control': CACHE,
        'x-oss-s3-compat': 'true',
        'x-oss-object-acl': 'public-read'
      }
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      problem(a.key + ': PUT ' + r.status + ' ' + text.slice(0, 300));
      continue;
    }
    console.log('   put  ' + a.key.padEnd(52) +
                String((a.bytes / 1024).toFixed(0)).padStart(6) + ' KB');
    done.push(a);
  }

  if (fail) {
    console.log('\n=== ' + fail + ' asset(s) failed; no manifest written ===');
    console.log('\n  The manifest is the claim that the bucket holds these bytes. Writing a');
    console.log('  partial one would make check:media verify a lie by omission.\n');
    process.exit(1);
  }

  if (DRY) {
    console.log('\n  --dry-run: ' + done.length + ' asset(s) would be sent. No manifest written.\n');
    return;
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(done.map(a => ({
    key: a.key, bytes: a.bytes, type: a.type, sha256: a.sha256,
    was: a.refs.map(r => r.url), where: a.refs.map(r => r.where)
  })), null, 2) + '\n');

  console.log('\n  ' + done.length + ' asset(s) uploaded, data/media-manifest.json written.');
  console.log('\n  Next, and in this order:');
  console.log('    1. set media.base in data/site.json to ' +
              c.endpoint.replace(/\/+$/, '') + '/' + c.prefix);
  console.log('    2. npm run check:media        <- the owner’s HARD GATE');
  console.log('    3. P10-T5: repoint the references IN MONGODB, export, render, re-diff');
  console.log('\n  Nothing leaves the repo (P10-T6) until step 2 is green.\n');
}

/* --------------------------------------------------------------------- main */

(async () => {
  if (has('--gather')) return gather();
  if (has('--upload')) return upload();
  console.log('\n  usage:');
  console.log('    npm run media:gather               fetch every asset, write data/media-plan.json');
  console.log('    npm run media:upload -- --dry-run  sign and report, send nothing');
  console.log('    npm run media:upload               PUT the plan, write data/media-manifest.json\n');
  process.exit(1);
})();
