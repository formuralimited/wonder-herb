/* The chat answer service as a Vercel serverless function.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM server/index.js. The public site is
 * static HTML on GitHub Pages, which serves files and cannot run anything -
 * a POST to it answers 405. The widget therefore needs its answer service on
 * a host that runs code, and this is the smallest possible one.
 *
 * It is deliberately NOT the whole API. server/chat.js imports no database by
 * design (scripts/test-chat.js asserts the absence), so the chat can be hosted
 * on its own without first answering the Phase 11 question of where MongoDB
 * and the admin live. Nothing else from server/ is deployed here.
 *
 * All the behaviour, and every guard, is in server/chat.js. This file only
 * adapts Express's (req, res) to Vercel's, and exists to be thin enough that
 * nothing can hide in it.
 *
 * THE KEY lives in the Vercel project's environment variables, NOT in this
 * repo, which is public. With OPENAI_API_KEY unset the service returns
 * `unavailable` and the widget renders the honest state it already ships with.
 *
 * CORS is set in vercel.json for /api/(.*) and deliberately not set here:
 * two Access-Control-Allow-Origin headers on one response is an error in the
 * browser, so there is exactly one place that decides it.
 */
const chat = require('../server/chat.js');

module.exports = async (req, res) => {
  /* The browser's preflight. vercel.json supplies the headers; this just has
     to answer it. */
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ kind: 'error' });

  /* THE RATE LIMIT NEEDS THE VISITOR'S IP, NOT THE PROXY'S. Behind Vercel,
     req.socket.remoteAddress is the edge, so every visitor on earth would
     share one bucket and the first eight questions of the day would throttle
     everyone. x-forwarded-for's FIRST entry is the client; the rest are
     proxies. server/chat.js reads req.ip, so set it here. */
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  req.ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';

  /* Vercel parses a JSON body for us, but not if the content-type is off. */
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch (e) { req.body = {}; }
  }
  if (!req.body || typeof req.body !== 'object') req.body = {};

  try {
    return await chat.handle(req, res);
  } catch (e) {
    /* Never let the message out: an exception from a request carrying an
       Authorization header can echo it back. Status only, in the log. */
    console.error('[chat] handler threw: ' + (e && e.name));
    return res.status(500).json({ kind: 'error' });
  }
};
