// Text-scoring model chain, tried in order. Each Groq model has its OWN daily/
// per-minute quota (confirmed from the account's Limits page 2026-09-19: both
// openai/gpt-oss-120b and openai/gpt-oss-20b are separately capped at 1,000
// requests/day, 8,000 tokens/minute, 200,000 tokens/day) -- so when the primary
// model's quota is genuinely exhausted (not just a short burst the retry logic
// in the fetch handler already absorbs), falling through to a same-family
// secondary model gives this a second, completely independent budget to draw
// from instead of failing the visitor outright. gpt-oss-20b is the smaller
// sibling of the primary 120b model -- same prompt/schema/response_format
// support, somewhat less capable, but far better than a hard failure.
// groq/compound and groq/compound-mini were added 2026-09-19 as extra fallback
// tiers -- each is its OWN separate quota bucket too (confirmed on the account's
// Limits page: 30 requests/min, 250/day, 70,000 tokens/min, no daily token cap --
// notably higher per-minute headroom than either gpt-oss model, though a lower
// daily request cap). They're placed between the two gpt-oss models rather than
// only at the end: compound-mini's 70k TPM buys real headroom before falling
// back to the same-family 20b, and full compound is the last resort since it's
// the heaviest/slowest of the four.
//
// IMPORTANT CAVEAT: unlike gpt-oss-20b (same family as the primary, same param
// surface), the compound models are Groq's agentic/tool-using meta-models --
// they can autonomously invoke web browsing and may not honor
// response_format/reasoning_effort the same way. That's a behavioral difference,
// not just a capacity swap. To keep that risk from ever reaching a visitor:
// callGroqModel applies a request timeout AND callGroqWithFallback validates
// that a compound model's response actually contains parseable JSON before
// accepting it -- any timeout, network error, non-2xx status, or non-JSON
// content from a compound model is treated as "this tier failed, try the next
// one" rather than being returned as-is. gpt-oss models keep the original,
// narrower behavior (only a 429 advances the chain) since they're trusted and
// same-family.
const TEXT_MODEL_CHAIN = ['openai/gpt-oss-120b', 'groq/compound-mini', 'openai/gpt-oss-20b', 'groq/compound'];
const COMPOUND_TIMEOUT_MS = 20000;
function isCompoundModel(model) {
return model.indexOf('groq/compound') === 0;
}
// Checks that a Groq chat-completion response's message content is actually
// parseable JSON (stripping markdown fences the way the site's own
// parseJsonLoose does) -- used only to sanity-check compound-family responses,
// since a browsing-style answer from those models could come back as prose,
// tool-call chatter, or nothing at all instead of the JSON object every other
// part of this system assumes.
function contentLooksLikeValidJson(text) {
try {
const parsed = JSON.parse(text);
const choice = parsed.choices && parsed.choices[0];
const raw = ((choice && choice.message && choice.message.content) || '').trim();
if (!raw) return false;
const cleaned = raw.replace(/```json|```/g, '').trim();
const start = cleaned.indexOf('{');
const end = cleaned.lastIndexOf('}');
if (start === -1 || end === -1) return false;
JSON.parse(cleaned.slice(start, end + 1));
return true;
} catch (e) {
return false;
}
}
// No same-capability fallback exists in this account's current model allowlist
// for vision input (allam-2-7b, the gpt-oss family, and the compound models are
// all text-only) -- qwen/qwen3.8-27b is the only vision-capable option today.
// (Groq's own vision docs mention a "qwen3.6-27b" too, but it doesn't appear
// in the account's actual Supported Models list -- likely a docs typo for
// 3.8, not a real second option. Don't add it as a fallback without directly
// confirming it 200s for this account first.)
// Kept as a one-item chain (rather than a bare constant) so both code paths
// share the exact same retry/fallback machinery below.
const VISION_MODEL_CHAIN = ['qwen/qwen3.8-27b'];

export default {
async fetch(request, env) {
const CORS_HEADERS = {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Methods': 'POST, OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Secret',
};

if (request.method === 'OPTIONS') {
return new Response(null, { headers: CORS_HEADERS });
}

const url = new URL(request.url);

// The leads dashboard is meant to be opened directly in a browser (plain GET,
// no custom headers possible) and guards itself with its own password rather
// than the site's PROXY_SECRET -- so it's handled before the POST-only /
// PROXY_SECRET rules below, which are for the site's own proxied API calls.
if (url.pathname === '/dashboard') {
return handleDashboardPage(CORS_HEADERS);
}
if (url.pathname === '/dashboard-data') {
return handleDashboardData(request, env, CORS_HEADERS);
}

if (request.method !== 'POST') {
return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
}

const providedSecret = request.headers.get('X-Proxy-Secret');
if (!env.PROXY_SECRET || providedSecret !== env.PROXY_SECRET) {
return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
status: 401,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}
        if (url.pathname === '/send-report') {
              return handleSendReport(request, env, CORS_HEADERS);
                  }

if (!env.GROQ_API_KEY) {
return new Response(JSON.stringify({ error: { message: 'Server misconfigured: GROQ_API_KEY is not set.' } }), {
status: 500,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

let body;
try {
body = await request.json();
} catch (e) {
return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
status: 400,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

const hasImageInput = Array.isArray(body.messages) && body.messages.some(function (m) {
return Array.isArray(m.content) && m.content.some(function (c) { return c && c.type === 'image_url'; });
});
const modelChain = hasImageInput ? VISION_MODEL_CHAIN : TEXT_MODEL_CHAIN;
console.log('Routing request: hasImageInput=' + hasImageInput + ' modelChain=' + modelChain.join(' -> '));
// FOUND 2026-09-19, live-reproduced -- qwen/qwen3.8-27b (vision) has its own,
// much tighter cap the account's Limits page never showed: 1000 OUTPUT
// tokens/minute, TOTAL, shared across every check anyone runs (not per
// request, not per visitor -- a rolling account-wide budget). A single
// bundled call describing 2-3 screenshots was hitting this directly at
// max_completion_tokens=1500 -- confirmed live, including on a single-image
// call after a prior test had already used part of the minute's budget. The
// site now sends the vision model one image per call (see analyzeVisuals in
// the-rung-check.html) with a small per-call budget, but this hard ceiling is
// enforced here too as a second line of defense in case that ever changes --
// this Worker has the final say over how much any single vision call can ask
// for, regardless of what the client requests.
const VISION_MAX_COMPLETION_TOKENS = 900;
body.max_completion_tokens = Math.min(Number(body.max_completion_tokens) || 3000, hasImageInput ? VISION_MAX_COMPLETION_TOKENS : 4000);
// FIXED 2026-09-19 -- this was the actual root cause of "Something went wrong
// reading your files" on every single check, misdiagnosed for a while as a
// Groq rate-limit/quota issue. Confirmed by reproducing it live (Claude in
// Chrome, direct requests against the deployed Worker) and cross-checking
// against a documented Groq/gpt-oss issue with the identical symptom
// (json_validate_failed, empty failed_generation) and the identical fix.
//
// openai/gpt-oss-120b (and qwen/qwen3.8-27b) are reasoning models: their
// hidden chain-of-thought draws from the SAME max_completion_tokens budget as
// the visible JSON output, and reasoning_effort='high' lets that hidden
// reasoning expand to consume however much budget it's given -- so raising
// max_completion_tokens alone does NOT fix this (verified live: raising the
// scoring call to the full 4000-token Worker cap while reasoning_effort
// stayed 'high' still failed identically). With 'high', on a prompt this
// size, the model spent its entire budget reasoning and had nothing left to
// write the actual JSON, so Groq's own json_object validator rejected an
// empty/incomplete completion with a 400 every single time -- not
// intermittently, not under load, on every request.
//
// 'high' was a deliberate change from the original 'low' (see the git history
// / prior comment here), made to improve reasoning quality against
// hallucinated facts -- a reasonable goal, but this pairing silently broke
// every audit rather than degrading quality gracefully. Reverting to 'low'
// (the previously-working value, and the exact fix used in the reference case
// above) restores a reliable, if less deeply-reasoned, scoring pass. The
// EVIDENCE RULE and PLAIN-LANGUAGE RULE in the system prompt are the other,
// still-active defenses against hallucinated/invented facts -- if reasoning
// quality genuinely needs to go back up, that has to be re-tested carefully
// (e.g. try 'medium' first) with this exact failure mode watched for, not
// assumed fixed just because a test run or two happens to succeed.
body.reasoning_effort = 'low';
body.include_reasoning = false;

// Groq's free tier enforces a tokens-per-minute cap shared across every call this
// Worker makes (the text-scoring call and the vision call both draw from it), so a
// short burst of checks -- our own QA testing included -- can trip a 429 that has
// nothing to do with actual traffic volume. Rather than surfacing that straight to
// the visitor, retry here server-side first: parse Groq's own "try again in Xs"
// wait time (falling back to its Retry-After header, then a flat default), and
// only actually sleep-and-retry when that wait is short enough to safely absorb
// within one Worker invocation. A longer cooldown is forwarded to the caller as-is
// -- the site's own client-side retry (with its own backoff) picks it up from
// there -- rather than risking this request stalling out or timing out.
const MAX_GROQ_ATTEMPTS = 3;
const MAX_SERVER_SIDE_WAIT_MS = 12000;

function parseGroqRetryWaitMs(resp, text) {
let waitMs = 4000;
let isPerMinuteCap = false;
try {
const parsed = JSON.parse(text);
const msg = (parsed.error && parsed.error.message) || '';
const m = msg.match(/try again in ([\d.]+)s/i);
if (m) waitMs = Math.ceil(parseFloat(m[1]) * 1000) + 500;
// FIXED 2026-09-19 -- discovered live while investigating a "no photo/banner
// provided" report that turned out to be a Groq 429 in disguise. Groq's
// per-minute quotas (RPM/TPM/ITPM/OTPM) don't always say "try again in Xs" --
// confirmed two real response shapes for the SAME underlying condition:
// "Rate limit reached for model ... (OTPM): Limit 1000, Used 696, ..." (has
// the words "rate limit") and "Request too large for model ... (OTPM): Limit
// 1000, Requested 1091 ..." (does NOT). Neither always includes a usable
// wait time. When we can't parse one AND the message names a per-minute
// bucket, don't guess a short wait and burn 2 retries that can't possibly
// succeed against a 60s rolling window -- flag it so the caller can skip
// straight to forwarding the error, and let the client's own (more patient)
// backoff handle it instead of stalling this Worker invocation.
if (!m && /per minute/i.test(msg)) isPerMinuteCap = true;
} catch (e) {
// leave default
}
const retryAfter = resp.headers.get('retry-after');
if (retryAfter) {
const secs = parseFloat(retryAfter);
if (!isNaN(secs)) waitMs = Math.max(waitMs, Math.ceil(secs * 1000) + 500);
}
if (isPerMinuteCap && waitMs <= MAX_SERVER_SIDE_WAIT_MS) waitMs = MAX_SERVER_SIDE_WAIT_MS + 1;
return waitMs;
}

// A fetch failure (network error, or our own timeout below) can't produce a
// real Response object, but everything downstream (parseGroqRetryWaitMs,
// resp.status checks, resp.ok) expects one -- this stands in for that case so
// a network hiccup on one model reads as "this tier failed" instead of
// crashing the whole chain.
function networkErrorResult(message) {
return {
resp: { status: 502, ok: false, headers: { get: function () { return null; } } },
text: JSON.stringify({ error: { message: message } }),
networkError: true,
};
}

// Calls one specific model with the short-cooldown retry logic described above.
// Compound-family models get a hard timeout (they can spend a while on
// autonomous tool calls) -- a timeout there fails fast, without burning through
// 3 retries against a model that may just be slow this time, so the chain can
// move on to the next tier quickly. Returns as soon as it gets anything other
// than a 429 (success, or a genuine non-capacity error that another model
// wouldn't fix either) -- or a network-error result if the fetch itself failed.
async function callGroqModel(model, body, env) {
const perModelBody = Object.assign({}, body, { model });
const timeoutMs = isCompoundModel(model) ? COMPOUND_TIMEOUT_MS : null;
let groqResp, text;
for (let attempt = 0; attempt < MAX_GROQ_ATTEMPTS; attempt++) {
const controller = timeoutMs ? new AbortController() : null;
const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
try {
groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
Authorization: `Bearer ${env.GROQ_API_KEY}`,
},
body: JSON.stringify(perModelBody),
signal: controller ? controller.signal : undefined,
});
text = await groqResp.text();
} catch (e) {
// A timeout-aborted fetch throws too, so this covers both real network
// errors and our own abort. Fail this model immediately rather than
// retrying -- a hung/slow compound call isn't going to speed up on a
// second try, and the chain's next tier is a better use of the time.
const reason = (controller && controller.signal.aborted) ? 'timed out after ' + timeoutMs + 'ms' : (e && e.message);
console.error('Groq call errored (model=' + model + '): ' + reason);
return networkErrorResult('Could not reach Groq API: ' + reason);
} finally {
if (timer) clearTimeout(timer);
}

if (groqResp.status !== 429) return { resp: groqResp, text: text };

const waitMs = parseGroqRetryWaitMs(groqResp, text);
const isLastAttempt = attempt === MAX_GROQ_ATTEMPTS - 1;
if (isLastAttempt || waitMs > MAX_SERVER_SIDE_WAIT_MS) {
console.error('Groq rate-limited (model=' + model + '); giving up on this model after ' + (attempt + 1) + ' attempt(s), suggested wait ' + waitMs + 'ms');
return { resp: groqResp, text: text };
}
console.log('Groq rate-limited (model=' + model + '); retrying in ' + waitMs + 'ms (attempt ' + (attempt + 2) + '/' + MAX_GROQ_ATTEMPTS + ')');
await new Promise(function (r) { setTimeout(r, waitMs); });
}
return { resp: groqResp, text: text };
}

// Whether a given model's result should make the chain move on to the next
// tier. A 429 or a network/timeout error always advances, for any model --
// neither one means the request itself was bad. For compound-family models
// specifically, ANY non-2xx status or content that isn't parseable JSON also
// advances (see the caveat above TEXT_MODEL_CHAIN) -- compound is the least
// trusted tier here, so it gets held to a stricter bar before its answer is
// allowed through. gpt-oss models don't get that extra check: they're the
// same trusted family the system already ran on before this change, so a
// non-429, non-network failure from one of them is treated as a real problem
// another model wouldn't fix either, exactly as before.
function shouldFallBackToNextModel(model, result) {
if (result.resp.status === 429 || result.networkError) return true;
if (isCompoundModel(model) && (!result.resp.ok || !contentLooksLikeValidJson(result.text))) return true;
return false;
}

// Walks the model chain in order, stopping at the first tier whose result
// doesn't call for falling back further (see shouldFallBackToNextModel).
// Every model has its own separate quota on Groq, so a tier that's genuinely
// exhausted or misbehaving just hands off to the next one instead of failing
// the visitor outright.
async function callGroqWithFallback(modelChain, body, env) {
let last;
for (let i = 0; i < modelChain.length; i++) {
const model = modelChain[i];
last = await callGroqModel(model, body, env);
if (!shouldFallBackToNextModel(model, last)) return last;
if (i < modelChain.length - 1) {
console.error('Model ' + model + ' failed (status=' + last.resp.status + (last.networkError ? ', network error' : '') + ') -- falling back to ' + modelChain[i + 1]);
}
}
return last;
}

let groqResp, text;
try {
const result = await callGroqWithFallback(modelChain, body, env);
groqResp = result.resp;
text = result.text;
} catch (e) {
return new Response(JSON.stringify({ error: { message: 'Could not reach Groq API: ' + e.message } }), {
status: 502,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

if (!groqResp.ok) {
console.error('Groq call failed (status=' + groqResp.status + '): ' + text.slice(0, 500));
} else {
console.log('Groq call OK: ' + text.slice(0, 300));
}
return new Response(text, {
status: groqResp.status,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
},
};

async function handleSendReport(request, env, CORS_HEADERS) {
if (!env.BREVO_API_KEY) {
return new Response(JSON.stringify({ error: { message: 'Server is missing the email API key.' } }), {
status: 500,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

let payload;
try {
payload = await request.json();
} catch (e) {
return new Response(JSON.stringify({ error: { message: 'Invalid request body.' } }), {
status: 400,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

const email = (payload.email || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
return new Response(JSON.stringify({ error: { message: 'A valid email address is required.' } }), {
status: 400,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

const a = payload.report || {};
const name = a.name || 'there';
const totalScore = a.totalScore ?? '';
const leadGap = a.leadGap || '';
// What the person said this audit was for (see the purpose dropdown on the
// upload step). Not used for anything server-side today beyond accepting it
// without erroring -- it's here so it can be logged/shown later if wanted.
const purpose = a.purpose || '';
const touchpoints = a.touchpoints || {};
const TOUCHPOINTS = [
{ key: 'photo', label: 'Photo' },
{ key: 'banner', label: 'Banner' },
{ key: 'headline', label: 'Headline' },
{ key: 'about', label: 'About' },
{ key: 'proofNextStep', label: 'Proof & Next Step' },
];
const TOUCHPOINT_MAX = 20;

// Versioned to bust Gmail's (and other clients') image proxy cache whenever the
// underlying PNG changes -- bump these query values any time logo.png/icon.png
// are replaced with new artwork, otherwise recipients keep seeing stale cached bytes.
const LOGO_URL = 'https://rungcheck.tabishhassan.com/logo.png?v=3';
// Email signature graphic (logo + headshot + contact card), supplied by
// Tabish. This is the white-text variant -- it always sits on its own dark
// navy card in the email (see htmlContent below), so it reads correctly
// regardless of the reader's light/dark mode instead of depending on mail
// clients to swap it themselves. Upload signature-dark.png next to logo.png
// and bump ?v= here any time the artwork changes.
const SIGNATURE_DARK_URL = 'https://rungcheck.tabishhassan.com/signature-dark.png?v=1';
const SITE_URL = 'https://rungcheck.tabishhassan.com';
const HOME_URL = 'https://tabishhassan.com';
const GALLERY_URL = 'https://quilt-cheque-ddb.notion.site/The-Ladder-Profile-Gallery-by-Tabish-Hassan-35216aea701e80a78cfae15c6ef9abb8';
const LINKEDIN_URL = 'https://www.linkedin.com/in/tabish-hassan436';
const REPLY_EMAIL = 'tabish@tabishhassan.com';

// Tiny raster ladder mark for the tier-tease header -- inline SVG (used on the
// site) isn't reliably rendered by email clients, so this is a rasterized
// equivalent embedded as a data URI. It's ~700 bytes, negligible weight.
const LADDER_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABwAAAAgCAYAAAABtRhCAAAB50lEQVR4nO2TsW7TUBSG/3PudUJapDYDS1kQawdAMMDYgUdIZrYydGeMvCAQT1BYq4Iu7wAjC5F4grYD6lh3aEkd+57DECcqiePrgGBA/hdb9v3P53N8fuAfi+YfDAaf7ead85sAEF1m+d5e/2KVgiE/T2+ccwYA1m5/f6IyOgHSkx/R6HBSRBkB1fXbeSPDRMbaDWJGNk43Vumujn8BKCrq81yJGQC8c84kyZCdcwvjn5NxzuH4LCWfo/BrHgQCAE0EAHm/3/cAfI3mPAC83D+8aM38tPCRpUAQQURUFbde7x/sQJVBJFU0gjcK41X9AxFWw6Z0Iss6RDZOlZnvW2s+hVoDAIUBARBV5FnmbdQytYHXwcW/DGraDkvlIJYAVUFEJOKTceq/TcppDaQCoE1mvrfsfClQVRG12pRejYYvnj97GiD9oldvPzxuW/2iugLw+vsitAygclZbW0NzevrQkxysV5UNAAnb2x8pSe5St3sUyiF1u0d0fFZ9KLA0yH4nh6sDmxyWnS2uTQ6bHDY5nKnJYSXw/84hs1FApRirj2OSwUARx9Vb6pyj3d1H8ubdez/1l33kwkaoiG3f6HC702EA61WQMoX8sw57vZ4AQNRa+5qmVzuABUjOASCOgxvzx/6/pp/BA3opGiU+OgAAAABJRU5ErkJggg==';

// Customer-facing band label -- shown in the email hero, the Notion "Rung"
// property, the D1 leads table, and the dashboard breakdown. This used to be
// two separate naming schemes (an internal Invisible/Seen/Remembered/
// Unignorable set for Notion/D1/dashboard, and this Overlooked/Emerging/
// Established/Magnetic set for the email) -- same 0-40/41-65/66-85/86-100
// cutoffs both ways, just inconsistent labels between the email a lead saw
// and what showed up in the dashboard/Notion for that same lead. Unified to
// one name everywhere as of 2026-09-19; leads recorded before this change
// keep their old label in D1/Notion (historical rows aren't rewritten).
const BAND_ORDER = [
{ min: 0, max: 40, label: 'Overlooked' },
{ min: 41, max: 65, label: 'Emerging' },
{ min: 66, max: 85, label: 'Established' },
{ min: 86, max: 100, label: 'Magnetic' },
];
function bandForScore(score) {
const n = Number(score);
const found = BAND_ORDER.find(function (b) { return !isNaN(n) && n >= b.min && n <= b.max; });
return found ? found.label : BAND_ORDER[0].label;
}
const band = bandForScore(totalScore);
const rung = band;

// recommendedTier itself (a.recommendedTier) is no longer read directly in
// this function -- the email CTA stopped branching on it 2026-09-19 (see the
// CTA block below). It's still saved whole inside report_json for the
// dashboard's report modal to read.

function truncate(str, max) {
if (!str) return '';
return str.length > max ? str.slice(0, max - 1).trim() + '...' : str;
}

function pct(score, max) {
const n = Math.round((Number(score) / Number(max)) * 100);
return isNaN(n) ? 0 : Math.max(0, Math.min(100, n));
}

// --- header hero: logo + name/score/leadGap + a single centered band-label
// pill, styled to match the .rung-hero dark card on the site. This replaces
// the old 4-pill ladder track (a <table> of nowrap pills, which is the
// mobile-Gmail overflow culprit Tabish reported -- 4 fixed-width nowrap pills
// in an auto-width table can exceed a narrow viewport even though the outer
// wrapper is max-width:560px). A single short word in a centered inline-block
// pill has no fixed/nowrap width constraint wider than its own content, so it
// can never overflow a narrow screen. -------------------------------------
const bandHtml = '<div style="text-align:center;margin-top:14px;">' +
'<div style="display:inline-block;padding:6px 18px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;background:#28ACDC;color:#04222C;font-family:Arial,sans-serif;">' + band + '</div>' +
'</div>';

const heroHtml = '<div style="background:#0D1B22;padding:32px 24px;text-align:center;">' +
'<img src="' + LOGO_URL + '" alt="The Ladder" width="130" style="display:block;margin:0 auto 18px;width:130px;height:auto;max-width:130px;border:0;">' +
'<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9FB4BE;margin-bottom:6px;">The Ladder Profile Audit</div>' +
'<div style="font-size:15px;font-weight:700;color:#EAF4F8;margin-bottom:14px;">' + name + "'s Ladder Score</div>" +
'<div style="font-size:44px;font-weight:800;color:#28ACDC;line-height:1;font-family:Arial,sans-serif;">' + totalScore + '<span style="font-size:16px;color:#9FB4BE;"> / 100</span></div>' +
(leadGap ? '<div style="font-size:14px;color:#EAF4F8;line-height:1.5;margin:12px auto 0;max-width:400px;text-align:center;">' + leadGap + '</div>' : '') +
bandHtml +
'</div>';

// --- touchpoint score cards with a track+fill progress bar, matching
// .pillar-row on the site. All widths here are percentage-based (width="X%"
// on the <td>, no fixed pixel widths, no nowrap), so this was already safe on
// narrow screens and stays that way with 5 cards instead of 3: a row of 3
// followed by a row of 2, each cell's own row summing to 100%. -------------
function touchpointCardTd(tp, widthPct) {
const d = touchpoints[tp.key] || {};
const score = d.score ?? 0;
const p = pct(score, TOUCHPOINT_MAX);
return '<td width="' + widthPct + '%" style="padding:4px;vertical-align:top;">' +
'<div style="background:#ffffff;border:1px solid #DDE6EA;border-radius:14px;padding:12px 10px;">' +
'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8B96A0;margin-bottom:3px;">' + tp.label + '</div>' +
'<span style="font-size:20px;font-weight:800;color:#14181C;font-family:Arial,sans-serif;">' + score + '</span>' +
'<span style="font-size:11px;color:#55606A;"> /' + TOUCHPOINT_MAX + '</span>' +
'<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#DDE6EA;border-radius:99px;">' +
'<table cellpadding="0" cellspacing="0" width="' + p + '%"><tr><td style="background:#28ACDC;height:4px;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
'</td></tr></table>' +
'</div>' +
'</td>';
}
const touchpointBarsHtml = '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
touchpointCardTd(TOUCHPOINTS[0], 33.33) + touchpointCardTd(TOUCHPOINTS[1], 33.33) + touchpointCardTd(TOUCHPOINTS[2], 33.34) +
'</tr><tr>' +
touchpointCardTd(TOUCHPOINTS[3], 50) + touchpointCardTd(TOUCHPOINTS[4], 50) +
'</tr></table>';

// --- per-touchpoint breakdown cards, matching .sec on the site: an
// observation line, then either a gap+move line or a "keep doing this" line
// when the touchpoint has no gap. ------------------------------------------
function sectionCard(label, score, max, observation, gap, move) {
const observationHtml = observation
? '<div style="font-size:13px;color:#14181C;line-height:1.5;margin-bottom:6px;"><span style="color:#1E9E6B;">&#10003;</span>&nbsp; ' + observation + '</div>'
: '';
const gapOrMoveHtml = gap
? '<div style="font-size:13px;color:#14181C;line-height:1.5;margin-bottom:6px;"><span style="color:#D14343;">&#10007;</span>&nbsp; <b>' + gap + '</b> <span style="color:#1C8CB5;">&rarr; ' + (move || '') + '</span></div>'
: (move ? '<div style="font-size:13px;color:#14181C;line-height:1.5;margin-bottom:6px;"><span style="color:#1E9E6B;">&#10003;</span>&nbsp; <span style="color:#1C8CB5;">Keep doing this: ' + move + '</span></div>' : '');
return '<div style="background:#ffffff;border:1px solid #DDE6EA;border-radius:14px;padding:16px;margin-bottom:12px;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;"><tr>' +
'<td style="font-size:13px;font-weight:700;color:#14181C;">' + label + '</td>' +
'<td style="text-align:right;"><span style="font-size:11px;background:#F4F9FB;color:#55606A;padding:2px 10px;border-radius:99px;border:1px solid #DDE6EA;">' + score + ' / ' + max + '</span></td>' +
'</tr></table>' +
observationHtml + gapOrMoveHtml +
'</div>';
}

const sectionsHtml = TOUCHPOINTS.map(function (tp) {
const d = touchpoints[tp.key] || {};
return sectionCard(tp.label, d.score ?? 0, TOUCHPOINT_MAX, d.observation, d.gap, d.move);
}).join('');

const touchpointsText = TOUCHPOINTS.map(function (tp) {
const d = touchpoints[tp.key] || {};
let block = tp.label + ': ' + (d.score ?? 0) + ' / ' + TOUCHPOINT_MAX + '\n';
if (d.observation) block += '+ ' + d.observation + '\n';
if (d.gap) block += '- ' + d.gap + ' -- fix: ' + (d.move || '') + '\n';
else if (d.move) block += '+ Keep doing this: ' + d.move + '\n';
return block;
}).join('\n');

// --- tier-tease block, with the small ladder icon next to the header -----
const tierTeaseHtml = '<div style="background:#F4F9FB;border:1px solid #DDE6EA;border-radius:14px;padding:16px 18px;margin:20px 0;">' +
'<table cellpadding="0" cellspacing="0" style="margin-bottom:10px;"><tr>' +
'<td style="padding-right:6px;vertical-align:middle;"><img src="data:image/png;base64,' + LADDER_ICON_B64 + '" width="12" height="14" alt="" style="display:block;"></td>' +
'<td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8B96A0;vertical-align:middle;">The Ladder</td>' +
'</tr></table>' +
'<div style="font-size:13px;color:#55606A;padding:4px 0;"><b style="color:#14181C;display:inline-block;min-width:96px;">Seen</b> Gets you noticed by future clients</div>' +
'<div style="font-size:13px;color:#55606A;padding:4px 0;"><b style="color:#14181C;display:inline-block;min-width:96px;">Remembered</b> Makes you stay top of mind</div>' +
'<div style="font-size:13px;color:#55606A;padding:4px 0;"><b style="color:#14181C;display:inline-block;min-width:96px;">Unignorable</b> Makes you unignorable in the feed</div>' +
'</div>';

// --- CTA: mirrors the site's ctaHTML (see renderReport() in
// the-rung-check.html) -- what a lead reads on the unlocked results page is
// exactly what lands in their inbox. UPDATED 2026-09-19 -- this used to
// branch on recommendedTier and pitch a specific tier name ("Here's your
// path to Remembered") as the CTA. Most reports were landing on the same
// tier, so it read as generic rather than personal and undercut itself as a
// hook. Collapsed to one unified, tier-agnostic CTA that leans on a real
// person having written the breakdown, not on which package it maps to.
// recommendedTier is still computed and still saved in report_json for
// Tabish's own dashboard (see openReportModal in DASHBOARD_HTML below) --
// it's just no longer part of what the lead themselves reads. ------------
const ctaHtml = '<div style="background:#F4F9FB;border:1px solid #DDE6EA;border-radius:14px;padding:24px;text-align:center;">' +
'<div style="font-weight:800;font-size:17px;color:#14181C;margin-bottom:6px;">Want to talk it through?</div>' +
'<div style="font-size:13px;color:#55606A;margin-bottom:14px;line-height:1.5;">Questions about any of this? I read every message myself &mdash; DM me.</div>' +
'<a href="' + LINKEDIN_URL + '" style="display:inline-block;padding:12px 24px;background:#28ACDC;color:#04222C;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px;">Message me on LinkedIn &rarr;</a>' +
'</div>';
const ctaText = 'Want to talk it through?\nQuestions about any of this? I read every message myself -- DM me.';

// Full HTML document (not just a fragment) -- kept even though the signature
// no longer depends on prefers-color-scheme (see note below), because it's
// still good practice for mail clients in general.
//
// NOTE on the signature block: a real Gmail-app test showed the light/dark
// CSS swap (@media prefers-color-scheme + [data-ogsc]) never fired -- the
// Gmail Android app auto-darkens the surrounding white background on its
// own, but does NOT evaluate our authored dark-mode CSS the way Gmail
// webmail or Apple Mail do, so the black-text signature was left sitting on
// a background Gmail had already darkened out from under it. Fix: stop
// trying to detect dark mode at all for this block. Instead give it a
// permanently dark card (like the navy hero header above, which was never
// broken because it's *always* dark) and always show the white-text
// signature inside it. Nothing here depends on client dark-mode support
// anymore, so it can't silently stop working in some other client either.
const htmlContent = '<!DOCTYPE html><html lang="en"><head>' +
'<meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<meta name="color-scheme" content="light dark">' +
'<meta name="supported-color-schemes" content="light dark">' +
'<style>' +
'body{margin:0;padding:0;}' +
'img{-ms-interpolation-mode:bicubic;}' +
'</style>' +
'</head><body style="margin:0;padding:0;">' +
'<div style="font-family:Arial,sans-serif;background:#F4F9FB;padding:32px 16px;">' +
'<div style="max-width:560px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #DDE6EA;">' +
heroHtml +
'<div style="padding:24px;">' + touchpointBarsHtml + '</div>' +
'<div style="padding:0 24px 24px;">' +
'<p style="font-size:15px;color:#14181C;line-height:1.6;margin-top:0;">Hi ' + name + ', here is my full breakdown of your profile, area by area, plus exactly what to fix first.</p>' +
sectionsHtml +
tierTeaseHtml +
ctaHtml +
'<div style="margin-top:28px;background:#0D1B22;border-radius:12px;padding:22px 20px;">' +
'<img src="' + SIGNATURE_DARK_URL + '" width="440" alt="Tabish Hassan -- Founder, The Ladder" style="display:block;width:100%;height:auto;max-width:440px;border:0;">' +
'</div>' +
'</div>' +
'<div style="padding:18px 24px;background:#F4F9FB;border-top:1px solid #DDE6EA;text-align:center;">' +
'<div style="font-size:11px;color:#8A99A2;line-height:1.6;">You are receiving this because you requested your Ladder Profile Audit at ' +
'<a href="' + SITE_URL + '" style="color:#8A99A2;">rungcheck.tabishhassan.com</a>. ' +
'<a href="mailto:' + REPLY_EMAIL + '?subject=Unsubscribe" style="color:#8A99A2;">Unsubscribe</a>' +
'</div>' +
'</div>' +
'</div>' +
'</div>' +
'</body></html>';

const textContent = 'Hi ' + name + ',\n\n' +
'Your Ladder Score: ' + totalScore + ' / 100\n' +
(leadGap ? leadGap + '\n' : '') + '\n' +
'FULL BREAKDOWN\n\n' +
touchpointsText + '\n' +
'THE LADDER\n' +
'Seen -- Gets you noticed by future clients\n' +
'Remembered -- Makes you stay top of mind\n' +
'Unignorable -- Makes you unignorable in the feed\n\n' +
ctaText + '\n' +
'Message me on LinkedIn: ' + LINKEDIN_URL + '\n\n' +
'-- Tabish Hassan\n' +
'Founder, The Ladder\n' +
'rungcheck.tabishhassan.com | tabishhassan.com\n\n' +
'You are receiving this because you requested your Ladder Profile Audit at rungcheck.tabishhassan.com.\n' +
'To unsubscribe, reply to this email or contact ' + REPLY_EMAIL + '.';

let brevoResp;
try {
brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Accept': 'application/json',
'api-key': env.BREVO_API_KEY,
},
body: JSON.stringify({
sender: { name: 'Tabish from The Ladder', email: 'tabish@tabishhassan.com' },
to: [{ email: email, name: name }],
replyTo: { email: 'tabish@tabishhassan.com', name: 'Tabish Hassan' },
subject: 'Your Ladder Score: ' + totalScore + '/100' + (leadGap ? ' - ' + truncate(leadGap, 70) : ''),
htmlContent: htmlContent,
textContent: textContent,
headers: { 'List-Unsubscribe': '<mailto:tabish@tabishhassan.com?subject=Unsubscribe>' },
}),
});
} catch (e) {
return new Response(JSON.stringify({ error: { message: 'Could not reach the email service.' } }), {
status: 502,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

const respText = await brevoResp.text();

if (env.NOTION_API_KEY) {
try {
const notionProps = {
Name: { title: [{ text: { content: name } }] },
Email: { email: email },
};
const numericScore = Number(totalScore);
if (!isNaN(numericScore)) notionProps.Score = { number: numericScore };
if (rung) notionProps.Rung = { select: { name: rung } };

const notionKey = (env.NOTION_API_KEY || '').trim();
console.log('NOTION_API_KEY length: ' + (notionKey ? notionKey.length : 'MISSING') + ', starts with: ' + notionKey.slice(0, 7));

const notionResp = await fetch('https://api.notion.com/v1/pages', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': 'Bearer ' + notionKey,
'Notion-Version': '2025-09-03',
'User-Agent': 'RungCheckWorker/1.0 (+https://rungcheck.tabishhassan.com)',
'Accept': 'application/json',
},
body: JSON.stringify({
parent: { type: 'data_source_id', data_source_id: '8fbcd4c7-cfd9-46ea-811e-1f0f8a852cb3' },
properties: notionProps,
}),
});
const notionRespText = await notionResp.text();
if (!notionResp.ok) {
const notionHeadersDump = [];
notionResp.headers.forEach(function (v, k) { notionHeadersDump.push(k + '=' + v); });
console.error('Notion leads sync rejected (' + notionResp.status + '): ' + notionRespText + ' | resp headers: ' + notionHeadersDump.join(', '));
} else {
console.log('Notion leads sync OK: ' + notionRespText.slice(0, 200));
}
} catch (e) {
// Never let a Notion hiccup break the actual email send -- it already went out above.
console.error('Notion leads sync failed: ' + e.message);
}
}

// D1 is the reliable lead store -- no external HTTP call, no bearer token to
// misconfigure, just a direct binding. Runs independently of the Notion sync
// above so neither one can break the other or the actual email send.
if (env.rung_check_leads) {
const numericScore = Number(totalScore);
// ADDED 2026-09-19 -- store the full report (touchpoints, leadGap,
// recommendedTier, purpose -- everything `a` holds) so the dashboard can show
// a lead's actual report later instead of just their score/tier. Requires a
// one-time migration on the D1 database (Tabish runs this himself, same as
// every other deploy/secret step):
//   wrangler d1 execute rung_check_leads --remote --command "ALTER TABLE leads ADD COLUMN report_json TEXT"
// Until that migration runs, inserting with this column would fail outright
// and silently drop the whole lead (not just the report) -- so this tries the
// new shape first and falls back to the old insert on exactly that error,
// rather than assuming the migration has already happened.
let reportJson = null;
try { reportJson = JSON.stringify(a); } catch (e) { /* leave null if the report object itself can't stringify */ }
try {
await env.rung_check_leads.prepare(
'INSERT INTO leads (name, email, score, rung, report_json) VALUES (?, ?, ?, ?, ?)'
).bind(name, email, isNaN(numericScore) ? null : numericScore, rung || null, reportJson).run();
console.log('D1 lead insert OK (with report_json)');
} catch (e) {
if (/no such column/i.test(e.message)) {
try {
await env.rung_check_leads.prepare(
'INSERT INTO leads (name, email, score, rung) VALUES (?, ?, ?, ?)'
).bind(name, email, isNaN(numericScore) ? null : numericScore, rung || null).run();
console.log('D1 lead insert OK (pre-migration shape -- run the report_json migration above to start saving full reports)');
} catch (e2) {
console.error('D1 lead insert failed: ' + e2.message);
}
} else {
console.error('D1 lead insert failed: ' + e.message);
}
}
}

return new Response(respText, {
status: brevoResp.status,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

// ---------------------------------------------------------------------------
// LEADS DASHBOARD
//
// /dashboard        (GET)  -- serves the page itself (password prompt + app)
// /dashboard-data   (POST) -- { password } -> D1 lead list + stats, plus a
//                              best-effort PostHog funnel if POSTHOG_API_KEY
//                              and POSTHOG_PROJECT_ID are set as Worker
//                              secrets. Works fine without them; the funnel
//                              card just says so and explains what to add.
// ---------------------------------------------------------------------------

// Pakistan is UTC+5 year-round (no DST) -- the dashboard is for Tabish, based
// in Pakistan, so every date it buckets or displays should read as
// Pakistan-local, not the UTC that D1's CURRENT_TIMESTAMP actually stores.
// See the 2026-09-19 fix note on the day-bucketing below for the full story.
const DASHBOARD_TIMEZONE = 'Asia/Karachi';
function pktDateKey(sqlOrDate) {
// D1's CURRENT_TIMESTAMP stores 'YYYY-MM-DD HH:MM:SS' in UTC with no
// timezone marker -- make that explicit ('...T...Z') before parsing, since a
// bare space-separated string like this is not reliably parsed as UTC by
// `new Date(...)` across engines.
const d = sqlOrDate instanceof Date ? sqlOrDate : new Date(String(sqlOrDate).replace(' ', 'T') + 'Z');
if (isNaN(d.getTime())) return null;
return new Intl.DateTimeFormat('en-CA', { timeZone: DASHBOARD_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function handleDashboardData(request, env, CORS_HEADERS) {
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

if (request.method !== 'POST') {
return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), { status: 405, headers: JSON_HEADERS });
}

if (!env.DASHBOARD_PASSWORD) {
return new Response(JSON.stringify({ error: { message: 'Dashboard is not set up yet -- DASHBOARD_PASSWORD is missing on the Worker.' } }), { status: 500, headers: JSON_HEADERS });
}

let body;
try {
body = await request.json();
} catch (e) {
return new Response(JSON.stringify({ error: { message: 'Invalid request body.' } }), { status: 400, headers: JSON_HEADERS });
}

if (!body.password || body.password !== env.DASHBOARD_PASSWORD) {
return new Response(JSON.stringify({ error: { message: 'Wrong password.' } }), { status: 401, headers: JSON_HEADERS });
}

if (!env.rung_check_leads) {
return new Response(JSON.stringify({ error: { message: 'D1 database is not bound to this Worker.' } }), { status: 500, headers: JSON_HEADERS });
}

// --- D1: the lead list itself, plus everything derived from it -----------
// ADDED 2026-09-19 -- tries the post-migration shape (with report_json) first,
// falls back to the pre-migration query on exactly a missing-column error, so
// the entire dashboard doesn't go down for the gap between deploying this
// Worker and actually running the D1 migration (see the comment above the
// insert in handleSendReport for the exact migration command).
let leads = [];
let hasReportColumn = true;
try {
const result = await env.rung_check_leads
.prepare('SELECT id, name, email, score, rung, created_at, report_json FROM leads ORDER BY created_at DESC LIMIT 2000')
.all();
leads = result.results || [];
} catch (e) {
if (/no such column/i.test(e.message)) {
hasReportColumn = false;
try {
const result = await env.rung_check_leads
.prepare('SELECT id, name, email, score, rung, created_at FROM leads ORDER BY created_at DESC LIMIT 2000')
.all();
leads = result.results || [];
} catch (e2) {
return new Response(JSON.stringify({ error: { message: 'D1 query failed: ' + e2.message } }), { status: 500, headers: JSON_HEADERS });
}
} else {
return new Response(JSON.stringify({ error: { message: 'D1 query failed: ' + e.message } }), { status: 500, headers: JSON_HEADERS });
}
}

const totalLeads = leads.length;
const scoresNum = leads.map(function (l) { return Number(l.score); }).filter(function (n) { return !isNaN(n); });
const avgScore = scoresNum.length ? Math.round(scoresNum.reduce(function (a, b) { return a + b; }, 0) / scoresNum.length) : null;

const RUNGS_ORDER = ['Overlooked', 'Emerging', 'Established', 'Magnetic'];
const byRung = {};
RUNGS_ORDER.forEach(function (r) { byRung[r] = 0; });
leads.forEach(function (l) {
if (l.rung && Object.prototype.hasOwnProperty.call(byRung, l.rung)) byRung[l.rung] += 1;
});

// Daily counts for the last 30 days, zero-filled so the trend line doesn't
// silently skip days with no leads.
//
// FIXED 2026-09-19 -- this used to bucket by the UTC calendar day
// (`d.toISOString().slice(0,10)` / `String(l.created_at).slice(0,10)`), and
// the leads table itself displayed D1's raw UTC `created_at` unconverted.
// Tabish is in Pakistan (UTC+5, no DST) -- a check made at, say, 11:50pm PKT
// is still the previous UTC day, so both the "which day did this happen on"
// bucketing and the displayed time were off by up to several hours from what
// he'd actually call "today." Pakistan has no DST, so a flat 24h-per-day
// subtraction in absolute time, then formatting in Asia/Karachi, is exact --
// no edge cases to handle. See `pktDateKey` above and the client-side
// `formatPKT` for the display-side half of this fix.
const DAYS = 30;
const dayBuckets = {};
const nowInstant = new Date();
for (let i = DAYS - 1; i >= 0; i--) {
const d = new Date(nowInstant.getTime() - i * 86400000);
dayBuckets[pktDateKey(d)] = 0;
}
leads.forEach(function (l) {
if (!l.created_at) return;
const key = pktDateKey(l.created_at);
if (key && Object.prototype.hasOwnProperty.call(dayBuckets, key)) dayBuckets[key] += 1;
});
const trend = Object.keys(dayBuckets).sort().map(function (date) { return { date: date, count: dayBuckets[date] }; });
const leadsLast7 = trend.slice(-7).reduce(function (sum, d) { return sum + d.count; }, 0);

// ADDED 2026-09-19 -- purpose and recommended-tier breakdowns, parsed out of
// each lead's saved report_json (see the migration note above). Leads
// recorded before that migration ran (or where the blob failed to parse)
// simply don't contribute -- `reportsAvailable` tells the dashboard how many
// leads these two breakdowns are actually based on, so the percentages don't
// silently imply full coverage they don't have.
const PURPOSE_ORDER = [
'Win new clients or customers',
'Get noticed by investors or partners',
'Build authority as a go-to expert',
'Land a new role or opportunity',
'Grow my visibility and network generally',
];
const TIER_ORDER = ['none', 'Seen', 'Remembered', 'Unignorable'];
const byPurpose = {};
PURPOSE_ORDER.forEach(function (p) { byPurpose[p] = 0; });
const byTier = {};
TIER_ORDER.forEach(function (t) { byTier[t] = 0; });
let reportsAvailable = 0;
leads.forEach(function (l) {
if (!l.report_json) return;
try {
const r = JSON.parse(l.report_json);
reportsAvailable += 1;
if (r.purpose && Object.prototype.hasOwnProperty.call(byPurpose, r.purpose)) byPurpose[r.purpose] += 1;
const tier = (r.recommendedTier && r.recommendedTier.tier) || null;
if (tier && Object.prototype.hasOwnProperty.call(byTier, tier)) byTier[tier] += 1;
} catch (e) {
// A malformed or truncated blob shouldn't take down the whole dashboard --
// just skip it from these two breakdowns.
}
});

// --- PostHog: funnel numbers, best-effort ---------------------------------
const funnel = { configured: false };
if (env.POSTHOG_API_KEY && env.POSTHOG_PROJECT_ID) {
funnel.configured = true;
try {
// .trim() guards against a stray trailing newline/space getting saved into
// the secret when it was pasted into a terminal -- an easy way for an
// otherwise-correct key to silently break the Authorization header.
const apiKey = String(env.POSTHOG_API_KEY).trim();
const projectId = String(env.POSTHOG_PROJECT_ID).trim();
const apiHost = (env.POSTHOG_API_HOST || 'https://us.posthog.com').trim().replace(/\/+$/, '');
const hogql = "SELECT event, count() AS c FROM events WHERE event IN ('check_started','report_viewed','email_gate_submitted') AND timestamp >= now() - INTERVAL 30 DAY GROUP BY event";
const phResp = await fetch(apiHost + '/api/projects/' + projectId + '/query/', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': 'Bearer ' + apiKey,
},
body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
});
const phText = await phResp.text();
if (!phResp.ok) {
// PostHog (or an edge in front of it) can reject a bad request with an
// EMPTY body, which used to render as a bare "PostHog returned 400:"
// with nothing to go on. Fall back to a couple of response headers
// (a Cloudflare ray id, a www-authenticate hint, etc.) so a repeat
// failure is actually debuggable instead of a dead end.
let detail = phText && phText.slice(0, 300);
if (!detail) {
const headerBits = [];
['cf-ray', 'www-authenticate', 'content-type'].forEach(function (h) {
const v = phResp.headers.get(h);
if (v) headerBits.push(h + '=' + v);
});
detail = '(empty response body)' + (headerBits.length ? ' [' + headerBits.join(', ') + ']' : '');
}
funnel.error = 'PostHog returned ' + phResp.status + ': ' + detail +
'. Double-check POSTHOG_PROJECT_ID is exactly "613736" and the personal API key has Query read access, then re-run wrangler secret put for both (retype rather than paste, to rule out a stray character).';
} else {
let phData = null;
try { phData = JSON.parse(phText); } catch (e) { /* leave null, handled below */ }
const counts = { check_started: 0, report_viewed: 0, email_gate_submitted: 0 };
const rows = (phData && (phData.results || phData.result)) || [];
rows.forEach(function (row) {
const eventName = Array.isArray(row) ? row[0] : (row && row.event);
const c = Array.isArray(row) ? row[1] : (row && row.c);
if (eventName && Object.prototype.hasOwnProperty.call(counts, eventName)) {
counts[eventName] = Number(c) || 0;
}
});
funnel.started = counts.check_started;
funnel.viewed = counts.report_viewed;
funnel.submitted = counts.email_gate_submitted;
}
} catch (e) {
funnel.error = 'Could not reach PostHog: ' + e.message;
}
}

return new Response(JSON.stringify({
totalLeads: totalLeads,
avgScore: avgScore,
leadsLast7: leadsLast7,
byRung: byRung,
rungsOrder: RUNGS_ORDER,
byPurpose: byPurpose,
purposeOrder: PURPOSE_ORDER,
byTier: byTier,
tierOrder: TIER_ORDER,
reportsAvailable: reportsAvailable,
hasReportColumn: hasReportColumn,
trend: trend,
funnel: funnel,
leads: leads,
timezone: DASHBOARD_TIMEZONE,
}), { status: 200, headers: JSON_HEADERS });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rung Check &mdash; Leads Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&family=Inter:wght@400;500;600;700&display=swap">
<style>
  :root {
    --bg:#F4F9FB; --surface:#FFFFFF; --surface-2:#EAF3F7; --ink:#14181C; --ink-soft:#55606A; --ink-faint:#8B96A0; --border:#DDE6EA;
    --accent:#28ACDC; --accent-dark:#1C8CB5; --accent-soft:#E3F4FA; --good:#1E9E6B; --bad:#D14343;
    --dark:#0D1B22; --dark-surface:#122732; --on-dark:#EAF4F8;
    --rung-1:#55c0e7; --rung-2:#20acdf; --rung-3:#1883aa; --rung-4:#115d78;
    --radius:14px; --radius-sm:10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0D1B22; --surface:#122732; --surface-2:#17303C; --ink:#EAF4F8; --ink-soft:#AFC2CB; --ink-faint:#728490; --border:#233C46; --accent-soft:#173A47;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, .display { font-family: "Plus Jakarta Sans", "Inter", sans-serif; }

  /* ---- password gate ---- */
  #gate[hidden], #app[hidden] { display: none !important; }
  #gate {
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  #gate .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 32px 28px;
    max-width: 340px;
    width: 100%;
    text-align: center;
  }
  #gate .eyebrow {
    font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--accent-dark); margin-bottom: 8px;
  }
  #gate h1 { font-size: 1.25rem; font-weight: 800; margin: 0 0 18px; }
  #gate input {
    width: 100%; font-size: 1rem; padding: 11px 14px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--bg); color: var(--ink); margin-bottom: 12px;
    font-family: inherit;
  }
  #gate input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  #gate button, .btn {
    width: 100%; font-size: 0.9375rem; font-weight: 700; padding: 11px 14px; border-radius: var(--radius-sm);
    border: none; background: var(--accent); color: #04222C; cursor: pointer; font-family: "Plus Jakarta Sans", sans-serif;
  }
  #gate button:hover, .btn:hover { background: var(--accent-dark); color: #fff; }
  #gateError { color: var(--bad); font-size: 0.8125rem; margin-top: 10px; min-height: 1em; }

  /* ---- app shell ---- */
  #app { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; }
  .header-row {
    display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 28px;
  }
  .eyebrow { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent-dark); margin-bottom: 6px; }
  h1.title { font-size: clamp(1.5rem, 4vw, 1.9rem); font-weight: 800; margin: 0; }
  #lastUpdated { font-size: 0.8125rem; color: var(--ink-faint); margin-top: 4px; }
  #refreshBtn { width: auto; padding: 9px 16px; font-size: 0.8125rem; }

  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  @media (max-width: 720px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } }
  .kpi {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px;
  }
  .kpi-label { font-size: 0.75rem; font-weight: 600; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .kpi-value { font-family: "Plus Jakarta Sans", sans-serif; font-size: 1.6rem; font-weight: 800; color: var(--ink); }

  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 780px) { .chart-row { grid-template-columns: 1fr; } }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
  .card-title { font-weight: 700; font-size: 0.9375rem; margin-bottom: 14px; }
  .card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .card-title-row .card-title { margin-bottom: 0; }
  .card-title-row input {
    font-size: 0.875rem; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--bg); color: var(--ink); font-family: inherit; min-width: 200px;
  }

  /* ---- bar rows (rungs + funnel) ---- */
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .bar-row:last-child { margin-bottom: 0; }
  .bar-label { width: 96px; flex-shrink: 0; font-size: 0.8125rem; font-weight: 600; color: var(--ink-soft); }
  .bar-label-wide { width: 190px; }
  @media (max-width: 480px) { .bar-label-wide { width: 120px; font-size: 0.75rem; } }
  .bar-track { flex: 1; height: 22px; background: var(--surface-2); border-radius: 999px; overflow: hidden; position: relative; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 240ms cubic-bezier(0.4,0,0.2,1); }
  .bar-value { width: 40px; flex-shrink: 0; text-align: right; font-size: 0.8125rem; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .drop-off { font-size: 0.75rem; color: var(--ink-faint); text-align: center; margin: 2px 0 10px 106px; }

  .funnel-note {
    display: flex; gap: 10px; align-items: flex-start; background: var(--accent-soft); border-radius: var(--radius-sm);
    padding: 12px 14px; font-size: 0.8125rem; color: var(--ink-soft); line-height: 1.5;
  }
  .funnel-note b { color: var(--ink); }
  .funnel-note code {
    font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 0.85em; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
  }

  /* ---- trend chart ---- */
  #trendChart { position: relative; }
  #trendChart svg { width: 100%; height: 160px; display: block; overflow: visible; }
  .trend-crosshair { stroke: var(--ink-faint); stroke-width: 1; opacity: 0; pointer-events: none; }
  .trend-dot { fill: var(--accent-dark); stroke: var(--surface); stroke-width: 2; opacity: 0; pointer-events: none; }
  .trend-tooltip {
    position: absolute; pointer-events: none; background: var(--dark); color: var(--on-dark);
    font-size: 0.75rem; padding: 6px 10px; border-radius: 8px; opacity: 0; transform: translate(-50%, -120%);
    white-space: nowrap; transition: opacity 100ms;
  }
  .trend-tooltip b { font-variant-numeric: tabular-nums; }
  .trend-axis-label { font-size: 0.6875rem; fill: var(--ink-faint); }

  /* ---- table ---- */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); font-weight: 600; }
  td.score-cell { font-variant-numeric: tabular-nums; font-weight: 600; }
  td.email-cell { color: var(--accent-dark); cursor: pointer; }
  td.email-cell:hover { text-decoration: underline; }
  .rung-pill {
    display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 700; color: #04222C;
  }
  #emptyState { text-align: center; color: var(--ink-faint); font-size: 0.875rem; padding: 24px 0; }
  #copiedToast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--good); color: #fff;
    padding: 8px 16px; border-radius: 999px; font-size: 0.8125rem; font-weight: 600; opacity: 0; pointer-events: none;
    transition: opacity 180ms;
  }

  /* ---- report link + view/copy modal (added 2026-09-19) ---- */
  .report-link { color: var(--accent-dark); font-weight: 600; cursor: pointer; background: none; border: none; font: inherit; padding: 0; }
  .report-link:hover { text-decoration: underline; }
  .report-link[disabled] { color: var(--ink-faint); cursor: default; }
  .report-link[disabled]:hover { text-decoration: none; }
  .breakdown-note { font-size: 0.75rem; color: var(--ink-faint); margin-top: 10px; }
  #reportModalOverlay[hidden] { display: none !important; }
  #reportModalOverlay {
    position: fixed; inset: 0; background: rgba(13,27,34,0.55); z-index: 50;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  #reportModal {
    background: var(--surface); border-radius: var(--radius); max-width: 560px; width: 100%;
    max-height: 86vh; overflow-y: auto; padding: 26px 24px;
  }
  #reportModal .rm-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
  #reportModal h2 { font-size: 1.15rem; margin: 0; }
  #reportModal .rm-close { background: none; border: none; font-size: 1.4rem; line-height: 1; color: var(--ink-faint); cursor: pointer; padding: 0 4px; }
  #reportModal .rm-meta { font-size: 0.8125rem; color: var(--ink-soft); margin-bottom: 18px; }
  #reportModal .rm-score { font-family: "Plus Jakarta Sans", sans-serif; font-weight: 800; font-size: 2rem; color: var(--accent-dark); }
  #reportModal .rm-tp { border-top: 1px solid var(--border); padding: 12px 0; }
  #reportModal .rm-tp-head { display: flex; justify-content: space-between; font-weight: 700; font-size: 0.875rem; margin-bottom: 6px; }
  #reportModal .rm-tp-obs { font-size: 0.8125rem; color: var(--ink-soft); margin-bottom: 4px; }
  #reportModal .rm-tp-gap { font-size: 0.8125rem; color: var(--bad); }
  #reportModal .rm-tp-move { color: var(--accent-dark); }
  #reportModal .rm-tier { background: var(--accent-soft); border-radius: var(--radius-sm); padding: 12px 14px; margin-top: 14px; font-size: 0.8125rem; }
  #reportModal .rm-actions { display: flex; gap: 10px; margin-top: 18px; }
  #reportModal .rm-actions button { width: auto; padding: 9px 16px; font-size: 0.8125rem; }
  #reportModal .rm-actions .secondary { background: var(--surface-2); color: var(--ink); }
  #reportModal .rm-actions .secondary:hover { background: var(--border); color: var(--ink); }
</style>
</head>
<body>

  <div id="gate">
    <div class="card">
      <div class="eyebrow">Rung Check</div>
      <h1>Leads Dashboard</h1>
      <input type="password" id="pwInput" placeholder="Password" autocomplete="current-password">
      <button id="pwSubmit" type="button">Unlock</button>
      <div id="gateError"></div>
    </div>
  </div>

  <div id="app" hidden>
    <div class="header-row">
      <div>
        <div class="eyebrow">Rung Check</div>
        <h1 class="title">Leads Dashboard</h1>
        <div id="lastUpdated"></div>
      </div>
      <button class="btn" id="refreshBtn" type="button">Refresh</button>
    </div>

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total leads</div><div class="kpi-value" id="kpiTotal">&ndash;</div></div>
      <div class="kpi"><div class="kpi-label">Avg score</div><div class="kpi-value" id="kpiAvg">&ndash;</div></div>
      <div class="kpi"><div class="kpi-label">Leads, last 7 days</div><div class="kpi-value" id="kpiWeek">&ndash;</div></div>
      <div class="kpi"><div class="kpi-label">Conversion rate</div><div class="kpi-value" id="kpiConv">&ndash;</div></div>
    </div>

    <div class="chart-row">
      <div class="card">
        <div class="card-title">Leads by tier</div>
        <div id="rungChart"></div>
      </div>
      <div class="card">
        <div class="card-title">Leads over the last 30 days</div>
        <div id="trendChart"></div>
      </div>
    </div>

    <div class="card" id="funnelCard">
      <div class="card-title">Funnel, last 30 days</div>
      <div id="funnelBody"></div>
    </div>

    <div class="chart-row">
      <div class="card" id="purposeCard">
        <div class="card-title">What people came to fix</div>
        <div id="purposeChart"></div>
        <div class="breakdown-note" id="purposeNote"></div>
      </div>
      <div class="card" id="tierCard">
        <div class="card-title">Recommended next tier</div>
        <div id="tierChart"></div>
        <div class="breakdown-note" id="tierNote"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title-row">
        <div class="card-title">All leads</div>
        <input type="text" id="searchBox" placeholder="Search name or email">
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Score</th><th>Tier</th><th>Date (PKT)</th><th>LinkedIn</th><th>Report</th></tr></thead>
          <tbody id="leadsTbody"></tbody>
        </table>
        <div id="emptyState" hidden>No leads yet.</div>
      </div>
    </div>
  </div>

  <div id="copiedToast">Email copied</div>

  <div id="reportModalOverlay" hidden>
    <div id="reportModal" role="dialog" aria-modal="true" aria-labelledby="rmName">
      <div class="rm-header">
        <div>
          <h2 id="rmName">&mdash;</h2>
          <div class="rm-meta" id="rmMeta"></div>
          <div class="rm-meta" id="rmLinkedIn" hidden></div>
        </div>
        <button class="rm-close" id="rmClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div><span class="rm-score" id="rmScore">&ndash;</span><span style="color:var(--ink-faint);font-size:0.9375rem;"> / 100</span></div>
      <div id="rmLeadGap" style="font-size:0.875rem;color:var(--ink-soft);margin:10px 0 4px;line-height:1.5;"></div>
      <div id="rmTouchpoints"></div>
      <div id="rmTier" class="rm-tier" hidden></div>
      <div class="rm-actions">
        <button class="btn secondary" id="rmCopyBtn" type="button">Copy report as text</button>
        <button class="btn secondary" id="rmCloseBtn" type="button">Close</button>
      </div>
    </div>
  </div>

  <script>
    var RUNG_COLORS = { Overlooked: '#55c0e7', Emerging: '#20acdf', Established: '#1883aa', Magnetic: '#115d78' };
    var RUNGS_ORDER = ['Overlooked', 'Emerging', 'Established', 'Magnetic'];
    var TIER_COLORS = { none: '#8B96A0', Seen: '#55c0e7', Remembered: '#1883aa', Unignorable: '#115d78' };
    var TOUCHPOINT_LABELS = { photo: 'Photo', banner: 'Banner', headline: 'Headline', about: 'About', proofNextStep: 'Proof & Next Step' };
    var TOUCHPOINT_ORDER = ['photo', 'banner', 'headline', 'about', 'proofNextStep'];
    var TOUCHPOINT_MAX = 20;
    var STORAGE_KEY = 'rc_dashboard_password';
    var lastData = null;
    var currentReportLead = null;

    function $(id) { return document.getElementById(id); }

    // D1's CURRENT_TIMESTAMP stores 'YYYY-MM-DD HH:MM:SS' in UTC with no
    // timezone marker. Tabish is in Pakistan (UTC+5, no DST) -- this renders
    // any D1 timestamp (or a live Date, for "Updated ...") as Pakistan-local,
    // matching the server-side pktDateKey() used for the trend chart. ADDED
    // 2026-09-19 to fix leads showing their raw UTC time (e.g. a check made
    // at 11:50pm PKT was displaying as "06:50").
    function formatPKT(input) {
      var d;
      if (input instanceof Date) {
        d = input;
      } else if (!input) {
        return '-';
      } else {
        d = new Date(String(input).replace(' ', 'T') + 'Z');
      }
      if (!d || isNaN(d.getTime())) return input ? String(input) : '-';
      var formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).format(d);
      return formatted + ' PKT';
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = String(str == null ? '' : str);
      return div.innerHTML;
    }

    function showGate(errorMsg) {
      $('app').hidden = true;
      $('gate').hidden = false;
      $('gateError').textContent = errorMsg || '';
    }

    function showApp() {
      $('gate').hidden = true;
      $('app').hidden = false;
    }

    function fetchData(password, onDone) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/dashboard-data', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var ok = xhr.status >= 200 && xhr.status < 300;
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        onDone(ok, data, xhr.status);
      };
      xhr.send(JSON.stringify({ password: password }));
    }

    function tryLoad(password) {
      fetchData(password, function (ok, data, status) {
        if (ok && data) {
          try { localStorage.setItem(STORAGE_KEY, password); } catch (e) {}
          lastData = data;
          renderAll(data);
          showApp();
        } else {
          try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
          var msg = (data && data.error && data.error.message) || 'Something went wrong.';
          showGate(msg);
        }
      });
    }

    $('pwSubmit').addEventListener('click', function () {
      var pw = $('pwInput').value;
      if (!pw) return;
      tryLoad(pw);
    });
    $('pwInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('pwSubmit').click();
    });
    $('refreshBtn').addEventListener('click', function () {
      var pw = null;
      try { pw = localStorage.getItem(STORAGE_KEY); } catch (e) {}
      if (pw) tryLoad(pw);
    });

    // ---- rendering -----------------------------------------------------

    function renderAll(data) {
      $('kpiTotal').textContent = String(data.totalLeads);
      $('kpiAvg').textContent = (data.avgScore === null ? '-' : data.avgScore + ' / 100');
      $('kpiWeek').textContent = String(data.leadsLast7);

      if (data.funnel && data.funnel.configured && typeof data.funnel.started === 'number' && data.funnel.started > 0) {
        var conv = Math.round((data.funnel.submitted / data.funnel.started) * 100);
        $('kpiConv').textContent = conv + '%';
      } else {
        $('kpiConv').textContent = '-';
      }

      $('lastUpdated').textContent = 'Updated ' + formatPKT(new Date());

      renderRungChart(data.byRung, data.totalLeads);
      renderTrendChart(data.trend);
      renderFunnel(data.funnel);
      renderBreakdowns(data);
      renderTable(data.leads);
    }

    // ---- purpose / recommended-tier breakdowns (added 2026-09-19) ---------
    // Both parsed server-side from each lead's saved report_json. Shares one
    // bar-list renderer with the rung/funnel charts above; reportsAvailable
    // and hasReportColumn (also from the server) drive the footnote so the
    // percentages never silently imply coverage they don't have.
    function renderBarList(containerId, order, counts, colorFor, wideLabels) {
      var el = $(containerId);
      el.innerHTML = '';
      var maxVal = 0;
      order.forEach(function (k) { if ((counts[k] || 0) > maxVal) maxVal = counts[k]; });
      if (maxVal === 0) maxVal = 1;

      order.forEach(function (k) {
        var count = counts[k] || 0;
        var pct = Math.round((count / maxVal) * 100);
        var row = document.createElement('div');
        row.className = 'bar-row';

        var label = document.createElement('div');
        label.className = 'bar-label' + (wideLabels ? ' bar-label-wide' : '');
        label.textContent = k === 'none' ? 'No tier needed' : k;

        var track = document.createElement('div');
        track.className = 'bar-track';
        var fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = Math.max(pct, count > 0 ? 3 : 0) + '%';
        fill.style.background = colorFor(k);
        fill.title = (k === 'none' ? 'No tier needed' : k) + ': ' + count;
        track.appendChild(fill);

        var value = document.createElement('div');
        value.className = 'bar-value';
        value.textContent = String(count);

        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(value);
        el.appendChild(row);
      });
    }

    function renderBreakdowns(data) {
      renderBarList('purposeChart', data.purposeOrder || [], data.byPurpose || {}, function () { return '#28ACDC'; }, true);
      renderBarList('tierChart', data.tierOrder || [], data.byTier || {}, function (k) { return TIER_COLORS[k] || '#8B96A0'; }, false);

      var note;
      if (!data.hasReportColumn) {
        note = "Report details aren't saved yet - run the report_json migration on D1 to start collecting these.";
      } else if (!data.reportsAvailable) {
        note = 'No saved reports yet.';
      } else {
        note = 'Based on ' + data.reportsAvailable + ' of ' + data.totalLeads + ' leads with a saved report.';
      }
      $('purposeNote').textContent = note;
      $('tierNote').textContent = note;
    }

    function renderRungChart(byRung, total) {
      var el = $('rungChart');
      el.innerHTML = '';
      var maxVal = 0;
      RUNGS_ORDER.forEach(function (r) { if (byRung[r] > maxVal) maxVal = byRung[r]; });
      if (maxVal === 0) maxVal = 1;

      RUNGS_ORDER.forEach(function (r) {
        var count = byRung[r] || 0;
        var pct = Math.round((count / maxVal) * 100);
        var row = document.createElement('div');
        row.className = 'bar-row';

        var label = document.createElement('div');
        label.className = 'bar-label';
        label.textContent = r;

        var track = document.createElement('div');
        track.className = 'bar-track';
        var fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = pct + '%';
        fill.style.background = RUNG_COLORS[r];
        fill.title = r + ': ' + count + ' lead' + (count === 1 ? '' : 's');
        track.appendChild(fill);

        var value = document.createElement('div');
        value.className = 'bar-value';
        value.textContent = String(count);

        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(value);
        el.appendChild(row);
      });
    }

    function renderFunnel(funnel) {
      var el = $('funnelBody');
      el.innerHTML = '';

      if (!funnel || !funnel.configured) {
        var note = document.createElement('div');
        note.className = 'funnel-note';
        note.innerHTML = '\u{1F4A1} <span><b>Not connected yet.</b> The funnel needs a PostHog personal API key. ' +
          'Add <code>POSTHOG_API_KEY</code> and <code>POSTHOG_PROJECT_ID</code> as Worker secrets to see how many people start a check versus finish one.</span>';
        el.appendChild(note);
        return;
      }
      if (funnel.error) {
        var errNote = document.createElement('div');
        errNote.className = 'funnel-note';
        errNote.textContent = String.fromCharCode(9888) + ' ' + funnel.error;
        el.appendChild(errNote);
        return;
      }

      var stages = [
        { label: 'Started', value: funnel.started || 0 },
        { label: 'Viewed report', value: funnel.viewed || 0 },
        { label: 'Submitted email', value: funnel.submitted || 0 },
      ];
      var maxVal = stages[0].value || 1;

      stages.forEach(function (stage, i) {
        var pct = Math.round((stage.value / maxVal) * 100);
        var row = document.createElement('div');
        row.className = 'bar-row';

        var label = document.createElement('div');
        label.className = 'bar-label';
        label.textContent = stage.label;

        var track = document.createElement('div');
        track.className = 'bar-track';
        var fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = Math.max(pct, 3) + '%';
        fill.style.background = '#28ACDC';
        track.appendChild(fill);

        var value = document.createElement('div');
        value.className = 'bar-value';
        value.textContent = String(stage.value);

        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(value);
        el.appendChild(row);

        if (i < stages.length - 1) {
          var nextVal = stages[i + 1].value;
          var dropPct = stage.value > 0 ? Math.round(100 - (nextVal / stage.value) * 100) : 0;
          var drop = document.createElement('div');
          drop.className = 'drop-off';
          drop.textContent = String.fromCharCode(8595) + ' ' + dropPct + '% drop-off';
          el.appendChild(drop);
        }
      });
    }

    function renderTrendChart(trend) {
      var el = $('trendChart');
      el.innerHTML = '';
      if (!trend || !trend.length) return;

      var W = 600, H = 160, padTop = 12, padBottom = 24, padX = 4;
      var maxVal = 0;
      trend.forEach(function (d) { if (d.count > maxVal) maxVal = d.count; });
      if (maxVal === 0) maxVal = 1;
      var plotH = H - padTop - padBottom;
      var n = trend.length;
      var stepX = (W - padX * 2) / (n - 1 || 1);

      function xAt(i) { return padX + i * stepX; }
      function yAt(v) { return padTop + plotH - (v / maxVal) * plotH; }

      var linePts = trend.map(function (d, i) { return xAt(i) + ',' + yAt(d.count); }).join(' ');
      var areaPts = linePts + ' ' + xAt(n - 1) + ',' + (padTop + plotH) + ' ' + xAt(0) + ',' + (padTop + plotH);

      var svgNS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('preserveAspectRatio', 'none');

      var gridLine = document.createElementNS(svgNS, 'line');
      gridLine.setAttribute('x1', padX); gridLine.setAttribute('x2', W - padX);
      gridLine.setAttribute('y1', padTop + plotH); gridLine.setAttribute('y2', padTop + plotH);
      gridLine.setAttribute('stroke', 'var(--border)'); gridLine.setAttribute('stroke-width', '1');
      svg.appendChild(gridLine);

      var area = document.createElementNS(svgNS, 'polygon');
      area.setAttribute('points', areaPts);
      area.setAttribute('fill', '#28ACDC');
      area.setAttribute('opacity', '0.10');
      svg.appendChild(area);

      var line = document.createElementNS(svgNS, 'polyline');
      line.setAttribute('points', linePts);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#1C8CB5');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);

      var firstLabel = document.createElementNS(svgNS, 'text');
      firstLabel.setAttribute('x', padX); firstLabel.setAttribute('y', H - 6);
      firstLabel.setAttribute('class', 'trend-axis-label');
      firstLabel.textContent = trend[0].date.slice(5);
      svg.appendChild(firstLabel);

      var lastLabel = document.createElementNS(svgNS, 'text');
      lastLabel.setAttribute('x', W - padX); lastLabel.setAttribute('y', H - 6);
      lastLabel.setAttribute('text-anchor', 'end');
      lastLabel.setAttribute('class', 'trend-axis-label');
      lastLabel.textContent = trend[n - 1].date.slice(5);
      svg.appendChild(lastLabel);

      var crosshair = document.createElementNS(svgNS, 'line');
      crosshair.setAttribute('class', 'trend-crosshair');
      crosshair.setAttribute('y1', padTop); crosshair.setAttribute('y2', padTop + plotH);
      svg.appendChild(crosshair);

      var dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('class', 'trend-dot');
      dot.setAttribute('r', '4');
      svg.appendChild(dot);

      el.appendChild(svg);

      var tooltip = document.createElement('div');
      tooltip.className = 'trend-tooltip';
      el.appendChild(tooltip);

      function showAt(i) {
        var cx = xAt(i), cy = yAt(trend[i].count);
        crosshair.setAttribute('x1', cx); crosshair.setAttribute('x2', cx);
        crosshair.style.opacity = '1';
        dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
        dot.style.opacity = '1';
        var pctX = (cx / W) * 100;
        var pctY = (cy / H) * 100;
        tooltip.style.left = pctX + '%';
        tooltip.style.top = pctY + '%';
        tooltip.innerHTML = trend[i].date + ': <b>' + trend[i].count + '</b>';
        tooltip.style.opacity = '1';
      }
      function hide() {
        crosshair.style.opacity = '0';
        dot.style.opacity = '0';
        tooltip.style.opacity = '0';
      }

      svg.addEventListener('pointermove', function (e) {
        var rect = svg.getBoundingClientRect();
        var relX = ((e.clientX - rect.left) / rect.width) * W;
        var i = Math.round((relX - padX) / stepX);
        if (i < 0) i = 0;
        if (i > n - 1) i = n - 1;
        showAt(i);
      });
      svg.addEventListener('pointerleave', hide);
    }

    // Parses a lead's saved report_json just far enough to pull out the
    // LinkedIn URL the model may have extracted, without throwing if the
    // report is missing, malformed, or predates this field entirely (older
    // leads simply won't have one -- that's expected, not an error).
    function getLeadLinkedInUrl(lead) {
      if (!lead || !lead.report_json) return null;
      try {
        var r = JSON.parse(lead.report_json);
        return (r && r.linkedinUrl) || null;
      } catch (e) {
        return null;
      }
    }

    function renderTable(leads) {
      window.__allLeads = leads || [];
      drawTableRows(window.__allLeads);
    }

    function drawTableRows(leads) {
      var tbody = $('leadsTbody');
      tbody.innerHTML = '';
      $('emptyState').hidden = leads.length > 0;

      leads.forEach(function (lead) {
        var tr = document.createElement('tr');

        var tdName = document.createElement('td');
        tdName.textContent = lead.name || '-';
        tr.appendChild(tdName);

        var tdEmail = document.createElement('td');
        tdEmail.className = 'email-cell';
        tdEmail.textContent = lead.email || '-';
        tdEmail.title = 'Click to copy';
        tdEmail.addEventListener('click', function () { copyText(lead.email, 'Email copied'); });
        tr.appendChild(tdEmail);

        var tdScore = document.createElement('td');
        tdScore.className = 'score-cell';
        tdScore.textContent = (lead.score === null || lead.score === undefined) ? '-' : lead.score;
        tr.appendChild(tdScore);

        var tdRung = document.createElement('td');
        if (lead.rung) {
          var pill = document.createElement('span');
          pill.className = 'rung-pill';
          pill.style.background = RUNG_COLORS[lead.rung] || 'var(--ink-faint)';
          pill.textContent = lead.rung;
          tdRung.appendChild(pill);
        } else {
          tdRung.textContent = '-';
        }
        tr.appendChild(tdRung);

        var tdDate = document.createElement('td');
        tdDate.textContent = formatPKT(lead.created_at);
        tr.appendChild(tdDate);

        // ADDED 2026-09-19 -- surfaces the LinkedIn URL the model pulled out
        // of the person's own PDF export (see "linkedinUrl" in the report
        // JSON schema in the-rung-check.html), so Tabish doesn't have to open
        // the full report just to find the profile of someone who saw their
        // score but never submitted an email-gated follow-up. Manual outreach
        // from here is still done by Tabish himself -- this only saves him
        // the trip into the PDF to find the link.
        var tdLinkedIn = document.createElement('td');
        var leadLinkedInUrl = getLeadLinkedInUrl(lead);
        if (leadLinkedInUrl) {
          var liLink = document.createElement('a');
          liLink.href = leadLinkedInUrl;
          liLink.target = '_blank';
          liLink.rel = 'noopener';
          liLink.className = 'report-link';
          liLink.textContent = 'Profile ' + String.fromCharCode(8599);
          tdLinkedIn.appendChild(liLink);
        } else {
          tdLinkedIn.textContent = '-';
        }
        tr.appendChild(tdLinkedIn);

        var tdReport = document.createElement('td');
        if (lead.report_json) {
          var viewBtn = document.createElement('button');
          viewBtn.className = 'report-link';
          viewBtn.type = 'button';
          viewBtn.textContent = 'View';
          viewBtn.addEventListener('click', function () { openReportModal(lead); });
          tdReport.appendChild(viewBtn);
        } else {
          var noRep = document.createElement('span');
          noRep.className = 'report-link';
          noRep.setAttribute('disabled', 'true');
          noRep.textContent = '-';
          tdReport.appendChild(noRep);
        }
        tr.appendChild(tdReport);

        tbody.appendChild(tr);
      });
    }

    $('searchBox').addEventListener('input', function () {
      var q = this.value.trim().toLowerCase();
      var all = window.__allLeads || [];
      if (!q) { drawTableRows(all); return; }
      var filtered = all.filter(function (l) {
        return (l.name || '').toLowerCase().indexOf(q) !== -1 || (l.email || '').toLowerCase().indexOf(q) !== -1;
      });
      drawTableRows(filtered);
    });

    function copyText(text, toastMsg) {
      function done() {
        var toast = $('copiedToast');
        toast.textContent = toastMsg || 'Copied';
        toast.style.opacity = '1';
        setTimeout(function () { toast.style.opacity = '0'; }, 1200);
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.focus(); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          done();
        }
      } catch (e) {}
    }

    // ---- report view/copy modal (added 2026-09-19) -------------------------
    // "a way to make copy of that report to me in the dashboard with a
    // clickable link" -- implemented as an in-dashboard modal behind the
    // existing password gate (not a new public URL), since these are real
    // people's personal audit results and the dashboard has no other auth.
    function openReportModal(lead) {
      var report = null;
      try { report = JSON.parse(lead.report_json); } catch (e) {}
      if (!report) return;
      currentReportLead = lead;

      $('rmName').textContent = (lead.name || 'Untitled') + "'s report";
      var metaBits = [];
      if (lead.email) metaBits.push(lead.email);
      metaBits.push(formatPKT(lead.created_at));
      $('rmMeta').textContent = metaBits.join(' - ');

      var modalLinkedInUrl = getLeadLinkedInUrl(lead);
      var rmLinkedInEl = $('rmLinkedIn');
      if (rmLinkedInEl) {
        if (modalLinkedInUrl) {
          rmLinkedInEl.hidden = false;
          rmLinkedInEl.innerHTML = '<a href="' + escapeHtml(modalLinkedInUrl) + '" target="_blank" rel="noopener">' + escapeHtml(modalLinkedInUrl) + ' ' + String.fromCharCode(8599) + '</a>';
        } else {
          rmLinkedInEl.hidden = true;
          rmLinkedInEl.innerHTML = '';
        }
      }
      $('rmScore').textContent = (lead.score === null || lead.score === undefined) ? '-' : lead.score;
      $('rmLeadGap').textContent = report.leadGap || '';

      var tpEl = $('rmTouchpoints');
      tpEl.innerHTML = '';
      TOUCHPOINT_ORDER.forEach(function (key) {
        var d = (report.touchpoints && report.touchpoints[key]) || {};
        var row = document.createElement('div');
        row.className = 'rm-tp';

        var head = document.createElement('div');
        head.className = 'rm-tp-head';
        var label = document.createElement('span');
        label.textContent = TOUCHPOINT_LABELS[key] || key;
        var score = document.createElement('span');
        score.textContent = (d.score == null ? 0 : d.score) + ' / ' + TOUCHPOINT_MAX;
        head.appendChild(label);
        head.appendChild(score);
        row.appendChild(head);

        if (d.observation) {
          var obs = document.createElement('div');
          obs.className = 'rm-tp-obs';
          obs.textContent = String.fromCharCode(10003) + ' ' + d.observation;
          row.appendChild(obs);
        }
        if (d.gap) {
          var gap = document.createElement('div');
          gap.className = 'rm-tp-gap';
          gap.innerHTML = String.fromCharCode(10007) + ' <b>' + escapeHtml(d.gap) + '</b>' + (d.move ? ' <span class="rm-tp-move">' + String.fromCharCode(8594) + ' ' + escapeHtml(d.move) + '</span>' : '');
          row.appendChild(gap);
        } else if (d.move) {
          var keep = document.createElement('div');
          keep.className = 'rm-tp-obs';
          keep.innerHTML = '<span class="rm-tp-move">Keep doing this: ' + escapeHtml(d.move) + '</span>';
          row.appendChild(keep);
        }
        tpEl.appendChild(row);
      });

      var tierEl = $('rmTier');
      if (report.recommendedTier && report.recommendedTier.tier && report.recommendedTier.tier !== 'none') {
        tierEl.hidden = false;
        tierEl.innerHTML = '<b>Path to ' + escapeHtml(report.recommendedTier.tier) + '</b><br>' + escapeHtml(report.recommendedTier.reason || '');
      } else {
        tierEl.hidden = true;
        tierEl.innerHTML = '';
      }

      $('reportModalOverlay').hidden = false;
    }

    function closeReportModal() {
      $('reportModalOverlay').hidden = true;
      currentReportLead = null;
    }

    $('rmClose').addEventListener('click', closeReportModal);
    $('rmCloseBtn').addEventListener('click', closeReportModal);
    $('reportModalOverlay').addEventListener('click', function (e) {
      if (e.target === $('reportModalOverlay')) closeReportModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('reportModalOverlay').hidden) closeReportModal();
    });

    $('rmCopyBtn').addEventListener('click', function () {
      if (!currentReportLead) return;
      var report = null;
      try { report = JSON.parse(currentReportLead.report_json); } catch (e) {}
      if (!report) return;

      var lines = [];
      lines.push((currentReportLead.name || 'Lead') + ' - ' + (currentReportLead.score == null ? '-' : currentReportLead.score) + ' / 100 - ' + (currentReportLead.rung || ''));
      lines.push(formatPKT(currentReportLead.created_at));
      if (currentReportLead.email) lines.push(currentReportLead.email);
      if (report.linkedinUrl) lines.push(report.linkedinUrl);
      lines.push('');
      if (report.leadGap) { lines.push(report.leadGap); lines.push(''); }
      TOUCHPOINT_ORDER.forEach(function (key) {
        var d = (report.touchpoints && report.touchpoints[key]) || {};
        lines.push((TOUCHPOINT_LABELS[key] || key) + ': ' + (d.score == null ? 0 : d.score) + ' / ' + TOUCHPOINT_MAX);
        if (d.observation) lines.push('  + ' + d.observation);
        if (d.gap) lines.push('  - ' + d.gap + (d.move ? ' -> ' + d.move : ''));
        else if (d.move) lines.push('  Keep doing this: ' + d.move);
        lines.push('');
      });
      if (report.recommendedTier && report.recommendedTier.tier && report.recommendedTier.tier !== 'none') {
        lines.push('Path to ' + report.recommendedTier.tier + ': ' + (report.recommendedTier.reason || ''));
      }
      copyText(lines.join(String.fromCharCode(10)).trim(), 'Report copied');
    });

    // ---- boot ------------------------------------------------------------
    (function boot() {
      var savedPw = null;
      try { savedPw = localStorage.getItem(STORAGE_KEY); } catch (e) {}
      if (savedPw) {
        tryLoad(savedPw);
      } else {
        showGate('');
      }
    })();
  </script>
</body>
</html>
`;

function handleDashboardPage(CORS_HEADERS) {
return new Response(DASHBOARD_HTML, {
status: 200,
headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
});
}