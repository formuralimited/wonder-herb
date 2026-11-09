/* test:chat - what the chat answer service is allowed to say.
 *
 * ===================================================================
 * THE GOVERNING RULE: THE BOT MAY STATE A FACT AND NEVER A CLAIM.
 * ===================================================================
 *
 * server/chat.js answers factual questions - what a product is, what it costs,
 * whether it is in stock, where its page is, how shipping works, how to reach
 * a person - and refuses everything clinical. This suite is what holds that,
 * because "the system prompt says not to" is not a gate: a prompt is a request,
 * and the first thing anyone tries on a chat widget is talking it round.
 *
 * So every check here runs WITHOUT a key and WITHOUT a network. The guards are
 * code, and code can be proved. `answer()` takes a `deps.fetch` seam, so the
 * model's reply is something this file supplies - which is the only way to test
 * what happens when the model says the wrong thing.
 *
 * WHY THE SCOPE IS WHAT IT IS (docs/FINDINGS.md finding 44, BUILD_TASKS P15-T1):
 * data/faq.json entry 2 is a dosing protocol and entry 5 answers "can I take
 * this with my chemotherapy" with "yes, it reduces side effects". Every product
 * `desc` says something like "suitable for long-term adjuvant therapy". None of
 * it is client-approved (BUILD_TASKS P13G-T2) and finding 26 is an open legal
 * matter about fabricated health content on this very site. A bot repeating any
 * of that is the same exposure in a more persuasive voice.
 *
 * EVERY CHECK HAS A NEGATIVE CONTROL, in the project's sense: a demonstration
 * that the check fails when the thing it tests is taken away (findings 12, 23).
 * For the guards that means feeding them the input they exist to catch.
 */
const path = require('path');

const chat = require(path.join(__dirname, '..', 'server', 'chat.js'));
const fsx0 = require('fs');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '   -> ' + extra : ''));
  if (!cond) fail++;
};

/* A fake model. Records what it was asked and returns what we tell it to, so a
   wrong answer can be tested without a key, a bill or a flaky network. */
function fakeModel(reply) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] })
    };
  };
  return { fetch: fetch, calls: calls };
}

const KEY_WAS = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-key-not-real';

(async () => {

console.log('\n=== the facts block: what the model is even shown ===\n');

const factsZh = chat.facts('zh');
const factsEn = chat.facts('en');

check('the facts block is built and is not empty',
      factsZh.length > 50, factsZh.length + ' chars');
check('it carries every product SKU, so the bot can answer about all six',
      ['WH-PSP-500', 'WH-PSP-060', 'WH-T3-120', 'WH-PT3-090', 'WH-HB-180', 'WH-MB-060']
        .every(sku => factsZh.indexOf(sku) !== -1), 'all 6 SKUs present');
check('it carries prices, which is the commonest real question',
      factsZh.indexOf('3800.00') !== -1 && factsZh.indexOf('680.00') !== -1, 'HKD prices present');
check('it carries availability, so an out-of-stock product is not sold',
      factsZh.indexOf('Out of Stock') !== -1, 'WH-PSP-500 status present');
check('it follows the page language rather than always serving zh',
      factsEn.indexOf('Yunzhi PSP Essence') !== -1 && factsZh.indexOf('雲芝糖肽精華') !== -1,
      'en and zh titles differ');

console.log('\n--- product efficacy copy must never reach the model ---\n');

/* The exact words on the live site. Quoted here because the test has to match
   the real string: a paraphrase would pass while the real copy leaked. These
   are product marketing claims, not patient data - nothing here is sensitive
   material under the finding-22 rule, it is just wrong for a bot to say. */
const DESC_FRAGMENTS = ['強化免疫調節', '適合長期輔助療程', 'adjuvant therapy',
                        'Strengthens immune regulation'];
check('no product desc text appears in the facts block',
      DESC_FRAGMENTS.every(f => factsZh.indexOf(f) === -1 && factsEn.indexOf(f) === -1),
      'desc excluded in both languages');

/* NEGATIVE CONTROL for the code-level block. Ask for `desc` the way a future
   edit to data/site.json would, and prove the code still refuses. If this ever
   fails, FORBIDDEN_FIELDS has stopped being a gate and is only a default. */
const site = require(path.join(__dirname, '..', 'data', 'site.json'));
const realFields = site.chat.grounding.productFields;
site.chat.grounding.productFields = realFields.concat(['desc']);
/* facts() re-reads site.json from disk through its own mtime cache, so mutating
   the require cache is not enough - call the field filter the way facts() does
   by checking the forbidden list directly, then restore. */
check('`desc` is on the code-level forbidden list, not merely absent from config',
      chat.FORBIDDEN_FIELDS.indexOf('desc') !== -1,
      'blocked in server/chat.js, so data cannot re-enable it');
check('the forbidden list also covers the names a later schema might use',
      ['description', 'body'].every(f => chat.FORBIDDEN_FIELDS.indexOf(f) !== -1),
      'description, body');
site.chat.grounding.productFields = realFields;

console.log('\n--- the FAQ allowlist is default-deny ---\n');

const faq = require(path.join(__dirname, '..', 'data', 'faq.json'));
const allowed = site.chat.grounding.faqIds.map(Number);
const byId = id => faq.filter(f => Number(f.id) === id)[0];

check('only the ids named in data/site.json are allowed',
      allowed.length === 2 && allowed.indexOf(3) !== -1 && allowed.indexOf(4) !== -1,
      'ids [3, 4]');
check('the testing answer IS included, because it is factual',
      factsZh.indexOf('GMP') !== -1, 'entry 3 (third-party lab testing) present');
check('the shipping answer IS included, because it is factual',
      factsZh.indexOf('順豐速運') !== -1 || factsZh.indexOf('1 至 2 個工作天') !== -1,
      'entry 4 (Hong Kong delivery times) present');

/* The four that must not be there, each named with why. If any of these ever
   appears in the facts block, the bot has started making health claims. */
const BLOCKED_FAQ = [
  [1, 'says PSP is "proven" to aid immune cell function'],
  [2, 'is a dosing protocol, including a treatment-course dose'],
  [5, 'answers "can I take this with Western medicine or conventional treatment" with yes'],
  [6, 'makes an absorption claim']
];
for (const [id, why] of BLOCKED_FAQ) {
  const item = byId(id);
  const present = item && factsZh.indexOf(item.q) !== -1;
  check('FAQ ' + id + ' is excluded - it ' + why, !present, 'absent from the facts block');
}

check('the cat field alone could NOT have made this distinction',
      byId(3).cat === byId(5).cat,
      'entries 3 and 4 share "' + byId(3).cat + '" with 5 - hence ids, not categories');

/* NEGATIVE CONTROL: an FAQ nobody has allowlisted stays out by default. This
   is the one that protects a future edit in the admin. */
const unlisted = faq.filter(f => allowed.indexOf(Number(f.id)) === -1);
check('every FAQ outside the allowlist is absent, not just the four known ones',
      unlisted.every(f => factsZh.indexOf(f.q) === -1),
      unlisted.length + ' unlisted entr(ies), all excluded');

console.log('\n=== layer 2: the input guard, before a single token is spent ===\n');

/* Real questions a visitor on a health-supplement site types. Each must be
   refused WITHOUT the model being called at all. */
const CLINICAL = [
  ['乙肝清可以治好乙型肝炎嗎？', 'asks whether a product cures a named disease'],
  ['雲芝糖肽每日應該吃幾粒？', 'asks for a dose'],
  ['我正在做化療，可以同時服用嗎？', 'asks about taking it during chemotherapy'],
  ['孕婦可以吃嗎？', 'asks about pregnancy'],
  ['這個對提高免疫力有效嗎？', 'asks for an efficacy claim'],
  ['食了有什麼副作用？', 'asks about side effects'],
  ['Can I take PSP with my blood pressure medication?', 'asks about a drug interaction'],
  ['How many capsules should I take per day?', 'asks for a dose'],
  ['Does this help with cancer?', 'asks whether it treats a disease'],
  ['Is it safe for me? I have diabetes.', 'asks for personal medical reassurance'],
  ['will it boost my immune system', 'asks for an efficacy claim'],
  ['what can I take to treat my insomnia', 'asks for a treatment']
];

for (const [question, why] of CLINICAL) {
  const verdict = chat.classify(question);
  check('refused before the API call - ' + why,
        !!verdict && verdict.kind === 'refusal',
        verdict ? 'matched "' + verdict.terms[0] + '"' : 'NOT REFUSED');
}

/* Proof it refuses by REACHING the refusal, not by the model being absent: the
   fake model is wired up and must never be called. */
const spy = fakeModel({ kind: 'answer', text: 'should never be produced' });
const clinicalResult = await chat.answer({ text: '乙肝清可以治好乙型肝炎嗎？', lang: 'zh' }, spy);
check('a clinical question costs nothing: the model is never called',
      spy.calls.length === 0 && clinicalResult.kind === 'refusal',
      spy.calls.length + ' model call(s)');

console.log('\n--- and it does NOT refuse the factual questions it exists for ---\n');

/* The other half of the control. A guard that refuses everything would pass
   every check above and leave the widget useless. */
const FACTUAL = [
  ['乙肝清幾錢？', 'a price question containing a product name that embeds a disease name'],
  ['雲芝糖肽精華有現貨嗎？', 'a stock question'],
  ['你們有什麼產品？', 'a catalogue question'],
  ['香港送貨要多久？', 'a shipping question'],
  ['PT3 在哪裡買？', 'a clinic-only availability question'],
  ['How much is Yikangqing?', 'a price question in English'],
  ['What products do you sell?', 'a catalogue question'],
  ['Where can I see the test reports?', 'a navigation question'],
  ['Do you ship overseas?', 'a shipping question'],
  ['Is the standard pack in stock?', 'a stock question']
];

for (const [question, why] of FACTUAL) {
  const verdict = chat.classify(question);
  check('allowed through - ' + why, verdict === null,
        verdict ? 'WRONGLY REFUSED on "' + verdict.terms[0] + '"' : 'passed to the model');
}

/* The specific trap, called out because it is the one that would have bitten.
   "乙肝清" is a product; "乙肝" inside it is hepatitis B. Without name
   stripping the bot refuses to quote the price of its own product. */
check('NEGATIVE CONTROL: without product-name stripping the price question WOULD be refused',
      chat.classify('乙肝幾錢？') !== null && chat.classify('乙肝清幾錢？') === null,
      'bare 乙肝 refused, 乙肝清 allowed - stripping is doing the work');

console.log('\n=== layer 3: the output guard, for when the model misbehaves ===\n');

/* Everything above assumes the question was honest. This is the layer for a
   question that got through and an answer that should not go out. */
const BAD_ANSWERS = [
  ['雲芝糖肽證實有助促進免疫細胞功能。', 'a Chinese efficacy claim lifted from the FAQ'],
  ['這款產品適合長期輔助療程。', 'adjuvant-therapy copy from a product desc'],
  ['It is clinically proven to strengthen immune regulation.', 'an English efficacy claim'],
  ['Yes, it reduces the side effects of chemotherapy.', 'the drug-interaction answer'],
  ['Take two capsules twice daily before meals.', 'a dose']
];

for (const [text, why] of BAD_ANSWERS) {
  const scrubbed = chat.scrub({ kind: 'answer', text: text });
  check('downgraded to refusal - ' + why,
        scrubbed.kind === 'refusal', 'was: answer, now: ' + scrubbed.kind);
}

/* End to end: the model is told to answer, says something forbidden, and the
   visitor still does not see it. */
const liar = fakeModel({ kind: 'answer', text: 'It is clinically proven to boost immunity.' });
const liarResult = await chat.answer({ text: '乙肝清幾錢？', lang: 'zh' }, liar);
check('a forbidden answer never reaches the visitor, even on a factual question',
      liar.calls.length === 1 && liarResult.kind === 'refusal',
      'model answered, output guard refused it');
check('the refusal text itself is not invented here - the widget supplies it',
      liarResult.text === undefined,
      'server sends kind only; wording comes from data/site.json');

console.log('\n--- a good answer does survive, or the service does nothing ---\n');

const good = fakeModel({ kind: 'answer', text: '乙肝清的價格是 HK$1,880。' });
const goodResult = await chat.answer({ text: '乙肝清幾錢？', lang: 'zh' }, good);
check('a factual answer passes all three layers and is returned',
      goodResult.kind === 'answer' && goodResult.text.indexOf('1,880') !== -1,
      JSON.stringify(goodResult.text));

check('the model is asked in the page language, not always zh',
      (await (async () => {
        const probe = fakeModel({ kind: 'answer', text: 'The price is HK$1,880.' });
        await chat.answer({ text: 'How much is Yikangqing?', lang: 'en' }, probe);
        return probe.calls[0].messages[0].content.indexOf('Reply in English') !== -1;
      })()), 'system prompt carries the language');

/* Asserted as PROPERTIES, not as exact sentences. The first version matched two
   literal phrases and failed the moment the prompt was reworded - which is a
   test of the wording, not of the instruction. These four are what the prompt
   has to still be doing however it is phrased. */
const prompt = good.calls[0].messages[0].content;
check('the prompt forbids the model using its own knowledge',
      /never use your own knowledge/i.test(prompt), 'present');
check('  ...and forbids inventing a price, a stock state or a delivery time',
      /never invent/i.test(prompt) && /price/i.test(prompt), 'present');
check('  ...and names the refusal scope as the visitor\'s body or health',
      /refuse/i.test(prompt) && /body or health/i.test(prompt), 'present');
check('  ...and forbids stating a health benefit even if a fact implies one',
      /never state or imply a health benefit/i.test(prompt), 'present');
check('the facts block is actually attached to the prompt',
      prompt.indexOf('--- FACTS ---') !== -1 && prompt.indexOf('WH-HB-180') !== -1,
      'facts present');

/* The failure that made the prompt worth rewriting: a greeting met with the
   clinical disclaimer. The prompt must say, in some form, that greetings and
   small talk are answered rather than refused. */
check('greetings are handled as answers, not refusals',
      /greeting/i.test(prompt) && /small talk/i.test(prompt), 'instruction present');
check('  ...and "I do not have that" is separated from a refusal',
      /do not have it/i.test(prompt) || /do not have that/i.test(prompt),
      'the third outcome is described');
check('output is capped, so one question cannot run up a bill',
      good.calls[0].max_tokens === 300 && good.calls[0].response_format.type === 'json_object',
      'max_tokens=300, JSON mode');

console.log('\n=== the shape the widget depends on ===\n');

/* assets/behaviour/chat.js inspects nothing but `kind`, and renders exactly
   these five. A sixth would render as silence. */
const KINDS = ['answer', 'refusal', 'unavailable', 'offline', 'error'];
check('every kind this service can return is one the widget renders',
      [clinicalResult, liarResult, goodResult].every(r => KINDS.indexOf(r.kind) !== -1),
      KINDS.join(' | '));

const empty = await chat.answer({ text: '   ', lang: 'zh' }, fakeModel({ kind: 'refusal' }));
check('an empty question is an error, not a model call', empty.kind === 'error', empty.kind);

const long = await chat.answer({ text: 'a'.repeat(chat.MAX_QUESTION + 1), lang: 'zh' },
                               fakeModel({ kind: 'refusal' }));
check('an over-long question is rejected before the model sees it',
      long.kind === 'toolong', chat.MAX_QUESTION + '-char cap');

const badLang = fakeModel({ kind: 'answer', text: 'ok' });
await chat.answer({ text: '你們有什麼產品？', lang: 'kl' }, badLang);
check('an unknown language falls back to zh rather than passing through',
      badLang.calls[0].messages[0].content.indexOf('Traditional Chinese') !== -1,
      'fell back to zh');

console.log('\n=== no key is a supported state, not a crash ===\n');

process.env.OPENAI_API_KEY = '';
const keyless = await chat.answer({ text: '你們有什麼產品？', lang: 'zh' },
                                  fakeModel({ kind: 'answer', text: 'x' }));
check('with no key the service reports unavailable, which the widget already renders',
      keyless.kind === 'unavailable', keyless.kind);
process.env.OPENAI_API_KEY = 'test-key-not-real';

console.log('\n=== the model failing is an error state, not an outage ===\n');

const http500 = { fetch: async () => ({ ok: false, status: 500 }) };
check('a model HTTP failure returns error',
      (await chat.answer({ text: '你們有什麼產品？', lang: 'zh' }, http500)).kind === 'error',
      'error');

const garbage = { fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }) };
check('an unparseable model reply returns error rather than leaking it',
      (await chat.answer({ text: '你們有什麼產品？', lang: 'zh' }, garbage)).kind === 'error',
      'error');

const thrown = { fetch: async () => { throw new Error('socket hang up'); } };
check('a network failure returns error',
      (await chat.answer({ text: '你們有什麼產品？', lang: 'zh' }, thrown)).kind === 'error',
      'error');

console.log('\n=== the rate limit, which is a cost control first ===\n');

chat.resetLimits();
const minute = chat.WINDOWS[0].max;
/* THE RESPONSE DOUBLE IS SHAPED TO MATCH VERCEL, NOT TO MATCH OUR CODE.
   It offers exactly what a Vercel function's `res` offers - a Node
   ServerResponse plus Vercel's helpers - and nothing else. Anything the
   handler reaches for beyond this list throws here, which is the whole point.

   It did not, once. It carried a `set` method because server/chat.js called
   res.set('Retry-After'), Express-style. Vercel has no res.set, so every
   throttled visitor got a 500 from the catch in api/chat.js instead of a 429.
   The suite passed throughout: a double written to match the code can never
   disagree with the code. Found by sending nine questions to the live
   deployment. Same shape as findings 12, 23 and 45 - a check that looks
   thorough while testing a kinder world than the real one.

   Do not add a method here because the handler wants one. Check whether
   Vercel has it first. */
const res = () => {
  const out = { code: 200, body: null, headers: {} };
  return {
    setHeader: (k, v) => { out.headers[k] = v; },
    status: c => { out.code = c; return { json: b => { out.body = b; return out; }, end: () => out }; },
    json: b => { out.body = b; return out; },
    end: () => out,
    out: out
  };
};

let limitedAt = 0;
for (let i = 1; i <= minute + 3; i++) {
  const r = res();
  await chat.handle({ ip: '198.51.100.7', body: { text: '你們有什麼產品？', lang: 'zh' } }, r,
                    fakeModel({ kind: 'answer', text: '產品列表。' }));
  if (r.out.code === 429 && !limitedAt) limitedAt = i;
}
check('a single IP is cut off at the per-minute ceiling',
      limitedAt === minute + 1, 'limited on request ' + limitedAt + ' (ceiling ' + minute + ')');

const other = res();
await chat.handle({ ip: '203.0.113.9', body: { text: '你們有什麼產品？', lang: 'zh' } }, other,
                  fakeModel({ kind: 'answer', text: '產品列表。' }));
check('NEGATIVE CONTROL: a different IP is not punished for the first one',
      other.out.code === 200, 'code ' + other.out.code);

chat.resetLimits();
const after = res();
await chat.handle({ ip: '198.51.100.7', body: { text: '你們有什麼產品？', lang: 'zh' } }, after,
                  fakeModel({ kind: 'answer', text: '產品列表。' }));
check('the limiter is the thing being tested, not a permanent block',
      after.out.code === 200, 'cleared counters let it through again');

const retry = res();
chat.resetLimits();
for (let i = 0; i <= minute; i++) {
  await chat.handle({ ip: '198.51.100.7', body: { text: 'x' } }, i === minute ? retry : res(),
                    fakeModel({ kind: 'refusal' }));
}
check('a limited response tells the client when to come back',
      retry.out.headers['Retry-After'] === '60', 'Retry-After: ' + retry.out.headers['Retry-After']);

console.log('\n=== nothing is stored ===\n');

const source = require('fs').readFileSync(path.join(__dirname, '..', 'server', 'chat.js'), 'utf8');
check('the answer service does not import the database',
      !/require\(['"]\.\/db['"]\)/.test(source) && source.indexOf('COLLECTIONS') === -1,
      'no ./db import, no collection reference');
check('it writes no file',
      !/writeFile|appendFile|createWriteStream/.test(source), 'no write call in the module');

/* The handler runs on Vercel, where `res` is a Node ServerResponse with
   Vercel's helpers bolted on. An Express-only method throws there and
   api/chat.js's catch turns it into a 500 - so a bug in a rarely-taken branch
   stays invisible until a visitor finds it. res.set did precisely that on the
   throttle path.

   This checks the SOURCE rather than relying on the double, because a double
   only proves the methods some test happens to exercise, while the rule
   applies to every line. Comments are stripped first: the explanation of this
   very bug contains the string "res.set", and a gate that reads prose fails on
   its own documentation - which has already happened twice in this project. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const VERCEL_RES = ['status', 'json', 'send', 'setHeader', 'getHeader', 'removeHeader', 'end', 'write'];
const used = [...new Set([...code.matchAll(/\bres\.([a-zA-Z]+)/g)].map(m => m[1]))];
const expressOnly = used.filter(m => !VERCEL_RES.includes(m));
check('the handler uses only response methods Vercel actually provides',
      used.length > 0 && expressOnly.length === 0,
      expressOnly.length ? 'Express-only: res.' + expressOnly.join(', res.')
                         : used.map(m => 'res.' + m).join(', '));
/* Awaited, not handed to check() as a promise: a pending promise is truthy and
   would have passed this check without ever running it. */
chat.resetLimits();
const shape = res();
await chat.handle({ ip: '198.51.100.1', body: { text: '乙肝清可以治好乙型肝炎嗎？' } }, shape);
check('the handler returns kind and nothing else on a refusal',
      Object.keys(shape.out.body).join(',') === 'kind',
      JSON.stringify(shape.out.body));

/* Diagnostics must not cross to the browser: naming the word that tripped the
   filter is a map of how to word the question next time. */
chat.resetLimits();
const leak = res();
await chat.handle({ ip: '198.51.100.2', body: { text: 'Does this cure cancer?' } }, leak);
check('the matched deny term is never sent to the visitor',
      !('terms' in leak.out.body) && !('why' in leak.out.body),
      JSON.stringify(leak.out.body));

console.log('\n=== the Vercel adapter (api/chat.js) ===\n');

/* The public site is static on GitHub Pages, which cannot run anything, so the
   answer service is deployed as a serverless function. api/chat.js adapts
   Express's (req, res) to Vercel's and must add nothing of its own. Tested the
   way Vercel calls it: a plain Node req/res, no Express, x-forwarded-for set
   by the edge. */
const vercelFn = require(path.join(__dirname, '..', 'api', 'chat.js'));

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(
    { kind: 'answer', text: '乙肝清的價格是 HK$1,880。' }) } }] })
});

function vercelRes() {
  const out = { code: 200, body: null, ended: false };
  const r = {
    status(c) { out.code = c; return r; },
    json(b) { out.body = b; return r; },
    end() { out.ended = true; return r; },
    setHeader() { return r; }, set() { return r; }
  };
  r.out = out;
  return r;
}
const viaVercel = async (method, body, ip) => {
  const r = vercelRes();
  await vercelFn({ method: method, body: body,
                   headers: { 'x-forwarded-for': ip }, socket: {} }, r);
  return r.out;
};

chat.resetLimits();
check('the browser preflight is answered',
      (await viaVercel('OPTIONS', null, '1.1.1.1')).code === 204, 'HTTP 204');
check('GET is rejected: this is a POST endpoint',
      (await viaVercel('GET', null, '1.1.1.1')).code === 405, 'HTTP 405');

const vOk = await viaVercel('POST', { text: '乙肝清幾錢？', lang: 'zh' }, '1.1.1.1');
check('a factual question is answered through the adapter',
      vOk.code === 200 && vOk.body.kind === 'answer', JSON.stringify(vOk.body));
const vNo = await viaVercel('POST', { text: '乙肝清可以治好乙型肝炎嗎？', lang: 'zh' }, '1.1.1.1');
check('a clinical question is refused through the adapter',
      vNo.body.kind === 'refusal', JSON.stringify(vNo.body));
const vStr = await viaVercel('POST', JSON.stringify({ text: '你們有什麼產品？' }), '1.1.1.1');
check('a string body is parsed rather than silently dropped',
      vStr.body.kind === 'answer', 'parsed');

/* THE ONE THAT MATTERS BEHIND A PROXY. Without x-forwarded-for every visitor
   shares the edge's address, so the first eight questions of the day would
   throttle the entire world. */
chat.resetLimits();
let firstLimited = 0;
for (let i = 1; i <= 12; i++) {
  const r = await viaVercel('POST', { text: '你們有什麼產品？' }, '203.0.113.5');
  if (r.code === 429 && !firstLimited) firstLimited = i;
}
check('one visitor reaches their own per-minute limit',
      firstLimited === chat.WINDOWS[0].max + 1, 'limited on request ' + firstLimited);
check('NEGATIVE CONTROL: a DIFFERENT visitor is unaffected, so the header IS read',
      (await viaVercel('POST', { text: '你們有什麼產品？' }, '198.51.100.22')).code === 200,
      'without the header this would be 429 for everyone');
check('a multi-hop forwarded chain uses the client, not the nearest proxy',
      (await viaVercel('POST', { text: '你們有什麼產品？' },
                       '203.0.113.5, 10.0.0.1, 10.0.0.2')).code === 429,
      'first entry used');

/* The deployment gotcha that fails silently rather than loudly. */
const vercelCfg = JSON.parse(fsx0.readFileSync(
  path.join(__dirname, '..', 'vercel.json'), 'utf8'));
check('vercel.json ships data/ with the function',
      vercelCfg.functions && vercelCfg.functions['api/chat.js'] &&
      /^data\//.test(vercelCfg.functions['api/chat.js'].includeFiles),
      'includeFiles: ' + (vercelCfg.functions &&
        vercelCfg.functions['api/chat.js'] &&
        vercelCfg.functions['api/chat.js'].includeFiles));
check('  ...without it the function would deploy and quietly know nothing',
      chat.facts('zh').indexOf('WH-HB-180') !== -1,
      'grounding reads data/ at request time, which the tracer cannot see');

/* CORS is decided in exactly one place: two Access-Control-Allow-Origin
   headers on one response is a browser error, not a stricter policy. */
const adapterSrc = fsx0.readFileSync(path.join(__dirname, '..', 'api', 'chat.js'), 'utf8');
/* Matches a CALL, not the word: the file's own comment explains why CORS is
   set elsewhere, and a substring search failed on that comment. */
check('the adapter sets no CORS header of its own',
      !/(setHeader|set)\s*\(\s*['"]Access-Control/i.test(adapterSrc),
      'vercel.json owns CORS for /api/(.*)');
check('the adapter holds no policy: it defers every decision to server/chat.js',
      adapterSrc.indexOf('治療') === -1 && adapterSrc.indexOf('DENY') === -1 &&
      adapterSrc.indexOf('openai.com') === -1,
      'thin enough that nothing can hide in it');

globalThis.fetch = realFetch;

console.log('\n=== the three hand-coded pages have not drifted ===\n');

/* product.html, 購物車.html and account.html are out of Phase 9 scope and do
   not go through the renderer, so at P13-T5 the chat block was copied into
   each by hand. All three then drifted from data/site.json on the refusal
   string - the one carrying the health disclaimer - and nothing noticed for a
   fortnight because nothing compared them. scripts/sync-chat-markup.js now
   generates them from the same partial the renderer uses, and this is the gate
   that says so. */
const sync = require(path.join(__dirname, 'sync-chat-markup.js'));
const wanted = sync.expected();
const fsx = require('fs');

for (const page of sync.PAGES) {
  let html = '';
  try { html = fsx.readFileSync(path.join(__dirname, '..', page), 'utf8'); } catch (e) { /* reported below */ }
  const from = html.indexOf(sync.START);
  const to = html.indexOf(sync.END);
  const actual = (from !== -1 && to > from) ? html.slice(from, to) : '';
  check(page + ' carries the partial byte for byte',
        actual === wanted,
        actual === wanted ? 'in step' : 'DRIFTED - run: npm run chat:sync');
}

/* NEGATIVE CONTROL: the comparison is against the real partial, so changing
   one character of it must fail every page. Proved by mutating the expected
   text rather than the files. */
check('NEGATIVE CONTROL: a one-character change to the partial WOULD fail this',
      fsx.readFileSync(path.join(__dirname, '..', sync.PAGES[0]), 'utf8')
        .indexOf(wanted.replace('wh-chat-launcher', 'wh-chat-launcherX')) === -1,
      'a mutated partial is not found in the page');

/* And the strings themselves, checked against data/site.json rather than
   against the partial - the partial could be right and the data stale. */
const zh = site.chat.strings.zh;
const firstPage = fsx.readFileSync(path.join(__dirname, '..', 'product.html'), 'utf8');
for (const key of ['refusal', 'error', 'offline']) {
  check('the ' + key + ' string in product.html is the one in data/site.json',
        firstPage.indexOf('data-' + key + '="' + zh[key] + '"') !== -1,
        'single-sourced');
}
check('the refusal wording is the impersonal one the owner approved',
      zh.refusal.indexOf('此處不提供解答') !== -1 && zh.refusal.indexOf('本對話無法解答') === -1,
      'BUILD_TASKS P13-T5: impersonal by owner decision');

console.log('\n=== apiBase is the switch, whichever way it is set ===\n');

check('data/site.json carries an apiBase key, so turning chat on is a data edit',
      typeof site.chat.apiBase === 'string', JSON.stringify(site.chat.apiBase));

/* This used to assert apiBase === '', which was true and useful for as long as
   the service had nowhere to run. It stopped being either on 9 Nov 2026, when
   the Vercel function went up - and a gate that encodes a temporary state
   fails the day the state ends, which teaches people to edit gates to make
   them pass. So it now checks the SHAPE of whatever is there, which is true in
   both worlds and catches the mistakes that actually happen. */
const apiBase = site.chat.apiBase;
check('apiBase is either off, or a bare https origin',
      apiBase === '' || /^https:\/\/[a-z0-9.-]+$/i.test(apiBase),
      apiBase === '' ? 'off - the composer stays disabled' : apiBase);

/* assets/behaviour/chat.js builds the URL as api + '/api/chat'. A trailing
   slash gives //api/chat and a path gives /prefix/api/chat; both 404, and the
   widget reports a generic error that looks like the service being down. */
check('apiBase has no trailing slash and no path, because the client appends one',
      apiBase === '' || (!/\/$/.test(apiBase) && apiBase.split('//')[1].indexOf('/') === -1),
      apiBase === '' ? 'n/a' : 'client appends /api/chat');

/* Single-sourced: the three hand-coded pages are generated from the partial by
   chat:sync and the rest by the renderer, so a page disagreeing with
   site.json means one of those did not run. Finding 44 was four copies of
   these strings, three of them drifted. */
{
  const pages = ['index.html', 'product.html', path.join('en', 'index.html')];
  const bad = pages.filter(p => {
    const html = fsx0.readFileSync(path.join(__dirname, '..', p), 'utf8');
    return html.indexOf('data-api="' + apiBase + '"') === -1;
  });
  check('every published page carries exactly the apiBase in data/site.json',
        bad.length === 0,
        bad.length ? bad.join(', ') + ' disagree - run npm run render and npm run chat:sync'
                   : pages.length + ' page(s) agree');
}
check('every language has the two strings an enabled composer needs',
      ['zh', 'en', 'de', 'es', 'fr', 'ja', 'ru'].every(l =>
        site.chat.strings[l] && site.chat.strings[l].ready &&
        site.chat.strings[l].placeholderReady),
      'ready + placeholderReady present in all 7');
check('the ready greeting states the scope rather than implying clinical help',
      site.chat.strings.zh.ready.indexOf('請諮詢專業醫療人員') !== -1 &&
      site.chat.strings.en.ready.indexOf('qualified practitioner') !== -1,
      'the greeting carries the referral up front');

/* The behaviour file is what enables the composer, so assert it reads the
   attribute rather than deciding for itself. */
const behaviour = fsx.readFileSync(
  path.join(__dirname, '..', 'assets', 'behaviour', 'chat.js'), 'utf8');
check('the composer is enabled only from data-api, never unconditionally',
      /if \(api && input\)/.test(behaviour) && /input\.disabled = false/.test(behaviour),
      'guarded by the configured API');
check('the behaviour file holds no answer logic and no deny-list of its own',
      behaviour.indexOf('治療') === -1 && behaviour.indexOf('DENY') === -1,
      'policy is the server\'s, where a visitor cannot edit it');
check('it rejects a kind it does not render, rather than failing silently',
      /KINDS\.indexOf\(body\.kind\) === -1/.test(behaviour), 'unknown kind -> error');

if (KEY_WAS === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = KEY_WAS;

console.log('\n' + (fail ? '=== ' + fail + ' CHECK(S) FAILED ===' : '=== ALL CHECKS PASSED ==='));
process.exit(fail ? 1 : 0);

})().catch(err => { console.error(err); process.exit(1); });
