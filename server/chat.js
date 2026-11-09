/* The chat answer service — the P13-T5 boundary, filled in.
 *
 * P13-T5 shipped the widget front end with exactly one function left hollow:
 * `requestAnswer()` in assets/behaviour/chat.js. This file is what that
 * function now calls. Nothing about the widget's markup, states or strings
 * changed to make it work; that was the point of the boundary.
 *
 * ===================================================================
 * SCOPE — FACTUAL ONLY. This is not a cautious default; it is the design.
 * ===================================================================
 * Owner's decision (31 Oct 2026): the bot answers from facts — product names,
 * SKUs, prices, availability, categories, where a page is, testing and
 * certification, shipping, how to get in touch. It answers NOTHING about
 * efficacy, dosage, symptoms, treating or preventing a condition, or taking a
 * product alongside medication. Those return `refusal` and route to WhatsApp.
 *
 * WHY, because the reason must outlive whoever next edits this file:
 *   - data/faq.json entry 2 is a dosing protocol and entry 5 answers "can I
 *     take this with my chemotherapy?" with "yes". Every product `desc` says
 *     something like "suitable for long-term adjuvant therapy". A static page
 *     carrying that is one thing; a bot that says it back to one person, in
 *     their language, reads as advice given to them.
 *   - BUILD_TASKS P13G-T2: "no health claim on the current pages can be
 *     presumed to be the client's own words." The claims review has not
 *     happened. docs/FINDINGS.md finding 26 is open and is a legal matter.
 *   - The widget's own owner-approved refusal string already promises this:
 *     "Questions about treating a condition can't be answered here... Help is
 *     available for products, ingredients, testing and ordering."
 * So the service is built to keep that promise rather than contradict it.
 *
 * ===================================================================
 * HOW THE PROMISE IS KEPT — three layers, because one is not a gate
 * ===================================================================
 * 1. STARVED CONTEXT. The model is handed a facts block built from an
 *    allowlist. Product `desc` is forbidden in code (FORBIDDEN_FIELDS) and
 *    cannot be re-enabled from data. FAQ entries are default-DENY: only ids
 *    named in data/site.json reach the model, so a new FAQ answer is excluded
 *    until someone decides otherwise. The model cannot ground a claim it was
 *    never shown.
 * 2. INPUT GUARD. `classify()` refuses clinical questions BEFORE the API call.
 *    No tokens are spent and no prompt can talk its way past it, because the
 *    request never happens.
 * 3. OUTPUT GUARD. `scrub()` reads the model's reply and downgrades anything
 *    carrying efficacy language to `refusal`. It fails CLOSED: a wrongly
 *    refused answer is a bad answer, an invented health claim is a liability.
 *
 * NOTHING IS STORED (owner, 31 Oct 2026). No transcript, no question log, no
 * analytics, no IP beyond the in-memory rate-limit counters, which hold a
 * timestamp and nothing else. This module does not require ./db and must not
 * start to: visitors type their health details into chat boxes, and HK PDPO
 * retention is a decision nobody has taken. scripts/test-chat.js asserts the
 * absence of a database import, so adding one fails the suite.
 *
 * THE KEY. process.env.OPENAI_API_KEY, from the gitignored .env. It is never
 * logged, never echoed in an error and never sent to the browser — the browser
 * only ever sees this endpoint. With no key set, the service returns
 * `unavailable`, which is the honest state the widget already renders.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

/* Model and endpoint are configurable so changing them is not a code edit.
   The default is deliberately a small cheap model: these are short factual
   answers over a context of a few hundred tokens, not reasoning work. */
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const MAX_QUESTION = 400;      /* characters; a real enquiry is far shorter */
const MAX_OUTPUT_TOKENS = 300;
const TIMEOUT_MS = 15000;

const LANGS = ['zh', 'en', 'de', 'es', 'fr', 'ja', 'ru'];

const LANG_NAMES = {
  zh: 'Traditional Chinese (Hong Kong)', en: 'English', de: 'German',
  es: 'Spanish', fr: 'French', ja: 'Japanese', ru: 'Russian'
};

/* Product fields the model may see when data/site.json names none. `desc` is
   absent here AND forbidden below - the allowlist is the convenience, the
   forbidden list is the gate. */
const DEFAULT_FIELDS = ['sku', 'title', 'price', 'status', 'cat', 'link'];

/* Never reaches the model, whatever data/site.json says. Every product
   description on this site is efficacy copy. */
const FORBIDDEN_FIELDS = ['desc', 'description', 'desc_long', 'body'];

/* ------------------------------------------------------------- the data
 *
 * Read from data/, NOT from MongoDB. The visitor is looking at the published
 * page, so the bot must quote the published price and the published stock
 * state - not an unpublished edit sitting in the editing surface. It also
 * means chat does not need the database up, which keeps non-negotiable 1
 * ("a broken admin must never take the live site down") true for the widget.
 *
 * Cached on mtime so an export is picked up without a restart.
 */
const cache = new Map();

function readData(file) {
  const file_path = path.join(DATA, file);
  let stat;
  try { stat = fs.statSync(file_path); } catch (e) { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.value;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file_path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return null;                 /* malformed data starves the bot; it does not crash it */
  }
  cache.set(file, { mtime: stat.mtimeMs, value: value });
  return value;
}

function productList() {
  const raw = readData('products.json');
  if (Array.isArray(raw)) return raw;
  return (raw && Array.isArray(raw.products)) ? raw.products : [];
}

/* A per-language field falls back to zh, matching the rest of the project. */
function pick(value, lang) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  return String(value[lang] || value.zh || '');
}

/* ------------------------------------------------- the clinical deny-list
 *
 * Matched case-insensitively against the question with product names removed
 * first (see scrub-safe note in `stripNames`). Two lists, because what must
 * never be ASKED and what must never be SAID are not the same set: a question
 * says "can I take this with my medication", an answer says "clinically
 * proven to help".
 *
 * These are substrings, not words: Chinese has no spaces, and English
 * inflections ("treats", "treating", "dosages") must all match. The cost is
 * occasional over-refusal, which is the direction this has to fail in.
 */
const DENY_QUESTION = [
  /* zh — treating, curing, dosing */
  '治療', '治疗', '治癒', '治愈', '根治', '能治', '可以醫', '醫好', '療程', '疗程',
  '劑量', '剂量', '用量', '服法', '食法', '怎麼吃', '怎么吃', '怎樣吃', '怎样吃',
  '怎麼服', '如何服', '幾粒', '几粒', '多少粒', '每日幾', '空腹',
  /* zh — safety, interactions, states */
  '副作用', '禁忌', '懷孕', '怀孕', '孕婦', '孕妇', '哺乳', '餵奶',
  '化療', '化疗', '放療', '放疗', '西藥', '西药', '中藥', '中药', '藥物', '药物',
  '處方', '处方', '同時服', '一起吃', '一起服',
  /* zh — conditions */
  '血壓', '血压', '血糖', '糖尿', '膽固醇', '胆固醇', '癌', '腫瘤', '肿瘤',
  '肝炎', '肝病', '乙肝', '腎', '肾', '失眠', '症狀', '症状', '病症', '疾病', '病人',
  /* 乙肝 is here even though 乙肝清 is a product, because the product name is
     stripped before this list runs. That is what makes "乙肝清幾錢" a price
     question and "乙肝幾錢" a question about hepatitis B, and scripts/test-chat.js
     asserts both directions. */
  /* zh — efficacy */
  '免疫力', '增強免疫', '增强免疫', '提高免疫', '功效', '療效', '疗效',
  '有效嗎', '有效吗', '有用嗎', '有用吗', '適合我', '适合我', '我應該吃', '我应该吃',
  '可以醫治', '預防', '预防',
  /* en — treating, curing, dosing */
  'treat', 'cure', 'heal', 'remedy', 'therapy', 'therapeutic', 'dosage', 'dose',
  'dosing', 'how many capsules', 'how many pills', 'how much should i take',
  'how often should i', 'empty stomach',
  /* en — safety, interactions, states */
  'side effect', 'contraindicat', 'pregnan', 'breastfeed', 'nursing',
  'chemo', 'radiation', 'medication', 'prescription', 'interact', 'along with my',
  'together with my',
  /* en — conditions */
  'blood pressure', 'blood sugar', 'diabet', 'cholesterol', 'cancer', 'tumour',
  'tumor', 'hepatitis', 'liver disease', 'kidney', 'insomnia', 'symptom',
  'disease', 'illness', 'diagnos',
  /* en — efficacy */
  'immune', 'immunity', 'efficacy', 'does it work', 'is it safe for me',
  'can i take', 'should i take', 'good for me', 'help with my', 'prevent'
];

/* Applied to the model's reply. Claim vocabulary, not question vocabulary. */
const DENY_ANSWER = DENY_QUESTION.concat([
  '證實', '证实', '臨床', '临床', '有助', '有助於', '有助于', '改善', '抑制',
  '增強', '增强', '提升身體', '輔助療程', '辅助疗程', '調節', '调节', '保健功效',
  'clinically', 'proven', 'scientifically shown', 'helps with', 'helps to',
  'reduces', 'relieve', 'inhibit', 'boost', 'strengthen', 'supports your',
  'improves your', 'adjuvant', 'immunomodulat',
  /* Dose INSTRUCTIONS, which a question-shaped list misses: nobody asked, the
     model volunteered it. Deliberately the instruction pattern and not the word
     "capsule" on its own - a pack size is a factual product spec and should
     stay answerable if one is ever added to the facts block. */
  '每日', '每次', '每天', '飯前', '飯後', '饭前', '饭后', '空腹', '睡前',
  'twice daily', 'three times a day', 'times a day', 'times daily', 'once daily',
  'per day', 'a day with', 'before meals', 'after meals', 'before bed',
  'on an empty stomach', 'capsules a day', 'capsules per day', 'capsules twice',
  'capsules daily', 'capsules each', 'take two', 'take three', 'take one'
]);

/* Product names are stripped before the deny-list runs, because some of them
   ARE condition words. "乙肝清" (a product) contains "乙肝" (hepatitis B), so
   "乙肝清幾錢" - "how much is Yikangqing" - is a price question and must be
   answered, not refused. Without this the bot would refuse to quote the price
   of two of the six products it sells. */
const NAME_EXTRAS = ['乙肝清', '憶活素', '忆活素', '雲芝糖肽', '云芝糖肽', '雲芝', '云芝',
                     'T3 配方', 'T3配方', 'PT3', 'T3', 'MemoProve', 'PSP', '糖肽'];

function stripNames(text) {
  let out = String(text || '');
  const products = productList();
  for (const product of products) {
    for (const lang of LANGS) {
      const title = product.title && product.title[lang];
      if (title) out = out.split(title).join(' ');
    }
    if (product.sku) out = out.split(product.sku).join(' ');
  }
  for (const word of NAME_EXTRAS) out = out.split(word).join(' ');
  return out;
}

function hits(text, list) {
  const haystack = String(text || '').toLowerCase();
  const found = [];
  for (const term of list) {
    if (haystack.indexOf(String(term).toLowerCase()) !== -1) found.push(term);
  }
  return found;
}

/* LAYER 2. Returns null when the question may be sent, or a result when it
   must not be. Exported so scripts/test-chat.js can assert it by effect. */
function classify(text) {
  const found = hits(stripNames(text), DENY_QUESTION);
  if (found.length) return { kind: 'refusal', why: 'question', terms: found };
  return null;
}

/* LAYER 3. Takes what the model said and returns what the visitor may see. */
function scrub(result) {
  if (!result || result.kind !== 'answer') return result;
  /* stripNames FIRST, for the same reason classify() does it: without it the
     answer "乙肝清的價格是 HK$1,880" is refused on the 乙肝 inside its own
     product name, and the bot can never quote the price of two of the six
     things it sells. Caught by scripts/test-chat.js, which had the input guard
     right and the output guard wrong. */
  const found = hits(stripNames(result.text), DENY_ANSWER);
  if (found.length) return { kind: 'refusal', why: 'answer', terms: found };
  return result;
}

/* ----------------------------------------------------------- the facts
 *
 * LAYER 1. Everything the model is allowed to know, and nothing else.
 */
function facts(lang) {
  const site = readData('site.json') || {};
  const config = (site.chat && site.chat.grounding) || {};

  const requested = Array.isArray(config.productFields) && config.productFields.length
    ? config.productFields : DEFAULT_FIELDS;
  const fields = requested.filter(f => FORBIDDEN_FIELDS.indexOf(f) === -1);

  const lines = [];

  const products = productList();
  if (products.length) {
    lines.push('PRODUCTS (prices in HKD):');
    for (const product of products) {
      const parts = [];
      for (const field of fields) {
        const value = pick(product[field], lang);
        if (value) parts.push(field + '=' + value);
      }
      if (parts.length) lines.push('- ' + parts.join('; '));
    }
  }

  /* Default-DENY. Only the ids data/site.json names are included, so adding an
     FAQ in the admin does not silently widen what the bot will say. */
  const allowed = Array.isArray(config.faqIds) ? config.faqIds.map(Number) : [];
  const faq = readData('faq.json');
  if (allowed.length && Array.isArray(faq)) {
    const chosen = faq.filter(item => allowed.indexOf(Number(item.id)) !== -1);
    if (chosen.length) {
      lines.push('', 'FREQUENTLY ASKED (answer only from these, verbatim in meaning):');
      /* pick(), not item.q directly: the FAQ became per-language at P14-T1
         (q and a are {zh, en, ...} objects now), and reading them raw would
         hand the model "[object Object]" as its only grounding. Plain strings
         still pass through unchanged, so an older faq.json keeps working. */
      for (const item of chosen) {
        lines.push('- Q: ' + pick(item.q, lang), '  A: ' + pick(item.a, lang));
      }
    }
  }

  /* Free-form factual notes the client can edit without a code change:
     opening hours, where to find a page, how to order. Per language. */
  const notes = Array.isArray(config.facts) ? config.facts : [];
  const written = notes.map(note => pick(note, lang)).filter(Boolean);
  if (written.length) {
    lines.push('', 'SITE FACTS:');
    for (const note of written) lines.push('- ' + note);
  }

  const handoff = (site.chat && site.chat.handoffHref) || '';
  if (handoff) lines.push('', 'To reach a person: WhatsApp ' + handoff);

  return lines.join('\n');
}

/* THE PROMPT IS THE WEAKEST OF THE THREE LAYERS and is written accordingly:
 * it shapes TONE and handles the ordinary cases, while the two code guards
 * decide what may actually be said. It earns its length from one failure -
 * the first version made `refusal` the model's default for anything it could
 * not answer from the facts, so "hi", "你好" and "你們是做什麼的？" were each met
 * with the full clinical disclaimer about symptoms and medication. A greeting
 * is not a medical question, and answering one that way reads as broken.
 *
 * So the prompt now separates three outcomes that were collapsed into two:
 * answer it, say you do not know it (still an ANSWER - warm, with a way to
 * reach a person), and refuse it (reserved for the body and health). */
function systemPrompt(lang) {
  const name = LANG_NAMES[lang] || LANG_NAMES.zh;
  return [
    'You are the enquiry assistant on the website of 康草堂 Wonder Herb, a Hong Kong herbal',
    'supplement retailer. You are a shop assistant, not a clinician and not a search box.',
    '',
    'TONE. Warm, natural and conversational, the way a helpful person on a shop floor speaks.',
    'Write full sentences. Do not list raw field names or dump the catalogue as data. Two or three',
    'sentences is usually plenty. Prices are in HKD. Reply in ' + name + '.',
    '',
    'THERE ARE THREE THINGS YOU CAN DO. Choose carefully - most messages are the first.',
    '',
    '1. ANSWER IT, from the facts below. Products, prices, stock and availability, pack sizes,',
    '   which products are clinic-only, delivery and shipping times, how to order, where to find a',
    '   page, testing and certification, how to get in touch.',
    '',
    '   GREETINGS AND SMALL TALK ARE ALSO THIS. "hi", "hello", "你好", "thanks", "What?",',
    '   "what do you do?", "can you help me?" - greet them back in one friendly sentence and say',
    '   what you can help with. Never answer a greeting with a disclaimer.',
    '',
    '2. SAY YOU DO NOT HAVE IT. If the question is ordinary and harmless but the facts below do',
    '   not cover it - opening hours, a refund, an order already placed, anything else - say plainly',
    '   that you do not have that detail here and invite them to message on WhatsApp. This is still',
    '   an "answer": be apologetic and useful, never use the refusal for it.',
    '',
    '   Never invent a price, a stock state, a delivery time or a fact that is not below.',
    '   Never use your own knowledge of herbs, supplements, health or medicine.',
    '',
    '3. REFUSE, with {"kind":"refusal"} and nothing else. ONLY for the visitor\'s body or health:',
    '   treating, curing, preventing or managing a condition or symptom; what a product does inside',
    '   the body; whether a product will help them; how many capsules to swallow and how often;',
    '   combining a product with medication or medical treatment; pregnancy or breastfeeding.',
    '',
    '   Refuse on the SUBJECT of the message, never on a word it happens to contain. "Take" in',
    '   "how long does delivery take" is ordinary English, not a dosage question.',
    '',
    'WHATEVER YOU DO, never state or imply a health benefit, an efficacy or a scientific finding -',
    'even if a fact below appears to contain one. Say what a product IS, never what it DOES to a',
    'person. If answering properly would require making such a claim, refuse instead.',
    '',
    'Reply with JSON only, in one of these two shapes:',
    '  {"kind":"answer","text":"..."}',
    '  {"kind":"refusal"}',
    '',
    '--- FACTS ---',
    facts(lang)
  ].join('\n');
}

/* ------------------------------------------------------------ the request */

async function callModel(question, lang, deps) {
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch;
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return { kind: 'unavailable' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(lang) },
          { role: 'user', content: question }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      /* Status only. The body of an auth failure can echo request detail, and
         nothing from this call belongs in a log on a machine we do not own. */
      console.error('[chat] model request failed, status ' + response.status);
      return { kind: 'error' };
    }

    const payload = await response.json();
    const content = payload && payload.choices && payload.choices[0] &&
                    payload.choices[0].message && payload.choices[0].message.content;
    if (!content) return { kind: 'error' };

    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { return { kind: 'error' }; }

    if (!parsed || parsed.kind === 'refusal') return { kind: 'refusal', why: 'model' };
    const text = String(parsed.text || '').trim();
    if (!text) return { kind: 'error' };
    return { kind: 'answer', text: text };
  } catch (e) {
    /* An abort lands here too: a timeout is an error state, not a hang. */
    console.error('[chat] model request error: ' + (e && e.name));
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------- the rate limit
 *
 * A public endpoint with a metered key behind it is a billing denial-of-service
 * waiting to happen, so this is a cost control first and an abuse control
 * second. Per-IP windows plus a hard daily ceiling.
 *
 * In-memory, therefore per-process and reset by a restart. That is honest for
 * one Express process and NOT enough once the API is hosted behind more than
 * one: Phase 17 owns real rate limiting. Written here rather than deferred
 * because "we will add limits later" is how a key gets drained.
 */
const WINDOWS = [{ ms: 60 * 1000, max: 8 }, { ms: 60 * 60 * 1000, max: 40 }];
const DAILY_MAX = parseInt(process.env.CHAT_DAILY_MAX, 10) || 1000;

const seen = new Map();       /* ip -> timestamps; nothing else is kept */
let dayCount = 0;
let dayStamp = '';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rateLimited(ip) {
  const now = Date.now();

  if (dayStamp !== today()) { dayStamp = today(); dayCount = 0; }
  if (dayCount >= DAILY_MAX) return 'daily';
  const longest = WINDOWS[WINDOWS.length - 1].ms;

  const stamps = (seen.get(ip) || []).filter(t => now - t < longest);
  for (const window of WINDOWS) {
    const recent = stamps.filter(t => now - t < window.ms).length;
    if (recent >= window.max) { seen.set(ip, stamps); return 'ip'; }
  }

  stamps.push(now);
  seen.set(ip, stamps);
  dayCount += 1;

  /* Keep the map from growing without bound on a long-running process. */
  if (seen.size > 5000) {
    for (const [key, value] of seen) {
      if (!value.length || now - value[value.length - 1] > longest) seen.delete(key);
    }
  }
  return null;
}

/* Exported for the tests, which must be able to start from a clean counter
   rather than depending on the order suites happen to run in. */
function resetLimits() {
  seen.clear();
  dayCount = 0;
  dayStamp = '';
}

/* ------------------------------------------------------------- the answer */

/* The whole decision, with no Express in it, so it can be tested directly.
   `deps.fetch` is a seam for the tests: the guards must be provable without a
   key, a network or a bill. */
async function answer(opts, deps) {
  const text = String((opts && opts.text) || '').trim();
  const raw = String((opts && opts.lang) || 'zh').toLowerCase();
  const lang = LANGS.indexOf(raw) !== -1 ? raw : 'zh';

  if (!text) return { kind: 'error' };
  if (text.length > MAX_QUESTION) return { kind: 'toolong' };

  const refused = classify(text);
  if (refused) return refused;                 /* layer 2: no API call happens */

  const result = await callModel(text, lang, deps);
  return scrub(result);                        /* layer 3 */
}

/* The Express handler. Deliberately UNAUTHENTICATED - it is the only public
   write-shaped route on this server, which is exactly why the limits above
   are not optional. It reads no cookie and sets none. */
async function handle(req, res, deps) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

  const limit = rateLimited(ip);
  if (limit) {
    /* setHeader, NOT Express's res.set. This runs on Vercel, where res is a
       Node ServerResponse with Vercel's own helpers bolted on - status, json,
       send, setHeader - and no `set`. res.set threw there, the catch in
       api/chat.js turned it into a 500, and a throttled visitor got a generic
       error instead of a 429 with a retry hint. setHeader exists on both,
       because Express's response inherits from ServerResponse.

       Found in production, on the live deployment, by sending nine questions
       in a row - not by the suite, whose res double had been written with a
       `set` method because the code called one. A double shaped to match the
       code cannot contradict the code. It is shaped to match Vercel now. */
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ kind: 'error' });
  }

  const result = await answer({
    text: req.body && req.body.text,
    lang: req.body && req.body.lang
  }, deps);

  if (result.kind === 'toolong') return res.status(400).json({ kind: 'error' });

  /* Only `kind` and, for an answer, `text` cross to the browser. `why` and
     `terms` are diagnostics: telling a visitor which word tripped the filter
     is a map of how to get around it. */
  const body = { kind: result.kind };
  if (result.kind === 'answer') body.text = result.text;
  return res.json(body);
}

module.exports = {
  handle: handle,
  answer: answer,
  classify: classify,
  scrub: scrub,
  facts: facts,
  systemPrompt: systemPrompt,
  resetLimits: resetLimits,
  FORBIDDEN_FIELDS: FORBIDDEN_FIELDS,
  MAX_QUESTION: MAX_QUESTION,
  WINDOWS: WINDOWS
};
