const GROQ_MODEL = 'openai/gpt-oss-120b';
const VISION_MODEL = 'qwen/qwen3.8-27b';

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
    const url = new URL(request.url);
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
body.model = hasImageInput ? VISION_MODEL : GROQ_MODEL;
console.log('Routing request: hasImageInput=' + hasImageInput + ' model=' + body.model);
body.max_completion_tokens = Math.min(Number(body.max_completion_tokens) || 3000, 4000);
body.reasoning_effort = 'low';
body.include_reasoning = false;

let groqResp;
try {
groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
Authorization: `Bearer ${env.GROQ_API_KEY}`,
},
body: JSON.stringify(body),
});
} catch (e) {
return new Response(JSON.stringify({ error: { message: 'Could not reach Groq API: ' + e.message } }), {
status: 502,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}

const text = await groqResp.text();
if (!groqResp.ok) {
console.error('Groq call failed (model=' + body.model + ', status=' + groqResp.status + '): ' + text.slice(0, 500));
} else {
console.log('Groq call OK (model=' + body.model + '): ' + text.slice(0, 300));
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
const rung = a.rung || '';
const totalScore = a.totalScore ?? '';
const top3 = Array.isArray(a.top3) ? a.top3 : [];
const pillars = a.pillars || {};
const scores = a.scores || {};
const PILLARS = [
{ key: 'reliability', label: 'Reliability', max: 35 },
{ key: 'readability', label: 'Readability', max: 35 },
{ key: 'resonance', label: 'Resonance', max: 30 },
];

// Versioned to bust Gmail's (and other clients') image proxy cache whenever the
// underlying PNG changes -- bump these query values any time logo.png/icon.png
// are replaced with new artwork, otherwise recipients keep seeing stale cached bytes.
const LOGO_URL = 'https://rungcheck.tabishhassan.com/logo.png?v=3';
// Custom email signature graphic (logo + headshot + contact card), supplied by
// Tabish. Upload signature.png next to logo.png and bump ?v= here any time
// the artwork changes -- same cache-busting rule as LOGO_URL above.
const SIGNATURE_URL = 'https://rungcheck.tabishhassan.com/signature.png?v=1';
const SITE_URL = 'https://rungcheck.tabishhassan.com';
const HOME_URL = 'https://tabishhassan.com';
const GALLERY_URL = 'https://quilt-cheque-ddb.notion.site/The-Ladder-Profile-Gallery-by-Tabish-Hassan-35216aea701e80a78cfae15c6ef9abb8';
const LINKEDIN_URL = 'https://www.linkedin.com/in/tabish-hassan436';
const REPLY_EMAIL = 'tabish@tabishhassan.com';

// Tiny raster ladder mark for the tier-tease header -- inline SVG (used on the
// site) isn't reliably rendered by email clients, so this is a rasterized
// equivalent embedded as a data URI. It's ~700 bytes, negligible weight.
const LADDER_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABwAAAAgCAYAAAABtRhCAAAB50lEQVR4nO2TsW7TUBSG/3PudUJapDYDS1kQawdAMMDYgUdIZrYydGeMvCAQT1BYq4Iu7wAjC5F4grYD6lh3aEkd+57DECcqiePrgGBA/hdb9v3P53N8fuAfi+YfDAaf7ead85sAEF1m+d5e/2KVgiE/T2+ccwYA1m5/f6IyOgHSkx/R6HBSRBkB1fXbeSPDRMbaDWJGNk43Vumujn8BKCrq81yJGQC8c84kyZCdcwvjn5NxzuH4LCWfo/BrHgQCAE0EAHm/3/cAfI3mPAC83D+8aM38tPCRpUAQQURUFbde7x/sQJVBJFU0gjcK41X9AxFWw6Z0Iss6RDZOlZnvW2s+hVoDAIUBARBV5FnmbdQytYHXwcW/DGraDkvlIJYAVUFEJOKTceq/TcppDaQCoE1mvrfsfClQVRG12pRejYYvnj97GiD9oldvPzxuW/2iugLw+vsitAygclZbW0NzevrQkxysV5UNAAnb2x8pSe5St3sUyiF1u0d0fFZ9KLA0yH4nh6sDmxyWnS2uTQ6bHDY5nKnJYSXw/84hs1FApRirj2OSwUARx9Vb6pyj3d1H8ubdez/1l33kwkaoiG3f6HC702EA61WQMoX8sw57vZ4AQNRa+5qmVzuABUjOASCOgxvzx/6/pp/BA3opGiU+OgAAAABJRU5ErkJggg==';

const RUNGS_ORDER = ['Invisible', 'Seen', 'Remembered', 'Unignorable'];
const rungIdx = RUNGS_ORDER.indexOf(rung);
const recommendedTier = a.recommendedTier || null;

function pct(score, max) {
const n = Math.round((Number(score) / Number(max)) * 100);
return isNaN(n) ? 0 : Math.max(0, Math.min(100, n));
}

// --- header hero: logo + name/score + the 4-tier ladder track, styled to
// match the .rung-hero dark card on the site -----------------------------
const ladderTrackHtml = '<table cellpadding="0" cellspacing="0" style="margin:14px auto 0;"><tr>' +
RUNGS_ORDER.map(function (r, i) {
const on = i === rungIdx;
return '<td style="padding:0 3px;">' +
'<div style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700;white-space:nowrap;background:' + (on ? '#28ACDC' : 'rgba(255,255,255,.08)') + ';color:' + (on ? '#04222C' : '#9FB4BE') + ';">' + r + '</div>' +
'</td>';
}).join('') +
'</tr></table>';

const heroHtml = '<div style="background:#0D1B22;padding:32px 24px;text-align:center;">' +
'<img src="' + LOGO_URL + '" alt="The Ladder" width="130" style="display:block;margin:0 auto 18px;height:auto;max-width:130px;border:0;">' +
'<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9FB4BE;margin-bottom:6px;">The Ladder Profile Audit</div>' +
'<div style="font-size:15px;font-weight:700;color:#EAF4F8;margin-bottom:14px;">' + name + '’s Ladder Score</div>' +
'<div style="font-size:44px;font-weight:800;color:#28ACDC;line-height:1;font-family:Arial,sans-serif;">' + totalScore + '<span style="font-size:16px;color:#9FB4BE;"> / 100</span></div>' +
'<div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#9FB4BE;margin-top:4px;">Ladder Score</div>' +
ladderTrackHtml +
'</div>';

// --- pillar score cards with a track+fill progress bar, matching .pillar-row
const pillarBarsHtml = '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
PILLARS.map(function (pl, i) {
const score = scores[pl.key] ?? 0;
const p = pct(score, pl.max);
const pad = i === 0 ? '0 6px 0 0' : (i === 2 ? '0 0 0 6px' : '0 6px');
return '<td width="33.33%" style="padding:' + pad + ';vertical-align:top;">' +
'<div style="background:#ffffff;border:1px solid #DDE6EA;border-radius:14px;padding:12px 10px;">' +
'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8B96A0;margin-bottom:3px;">' + pl.label + '</div>' +
'<span style="font-size:20px;font-weight:800;color:#14181C;font-family:Arial,sans-serif;">' + score + '</span>' +
'<span style="font-size:11px;color:#55606A;"> /' + pl.max + '</span>' +
'<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#DDE6EA;border-radius:99px;">' +
'<table cellpadding="0" cellspacing="0" width="' + p + '%"><tr><td style="background:#28ACDC;height:4px;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
'</td></tr></table>' +
'</div>' +
'</td>';
}).join('') +
'</tr></table>';

// --- per-pillar breakdown cards, matching .sec on the site (including the
// readability-only headline quote + 5-second test line) ------------------
function sectionCard(label, score, max, extraHtml, workingArr, missingArr) {
const workingHtml = (workingArr || []).map(function (w) {
return '<div style="font-size:13px;color:#14181C;line-height:1.5;margin-bottom:6px;"><span style="color:#1E9E6B;">&#10003;</span>&nbsp; ' + w + '</div>';
}).join('');
const missingHtml = (missingArr || []).map(function (m) {
return '<div style="font-size:13px;color:#14181C;line-height:1.5;margin-bottom:6px;"><span style="color:#D14343;">&#10007;</span>&nbsp; <b>' + (m.gap || '') + '</b> <span style="color:#1C8CB5;">&rarr; ' + (m.fix || '') + '</span></div>';
}).join('');
return '<div style="background:#ffffff;border:1px solid #DDE6EA;border-radius:14px;padding:16px;margin-bottom:12px;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;"><tr>' +
'<td style="font-size:13px;font-weight:700;color:#14181C;">' + label + '</td>' +
'<td style="text-align:right;"><span style="font-size:11px;background:#F4F9FB;color:#55606A;padding:2px 10px;border-radius:99px;border:1px solid #DDE6EA;">' + score + ' / ' + max + '</span></td>' +
'</tr></table>' +
(extraHtml || '') +
workingHtml + missingHtml +
'</div>';
}

const readabilityPd = pillars.readability || {};
const readabilityExtraHtml =
(readabilityPd.headline ? '<div style="font-size:12px;color:#8B96A0;font-style:italic;border-left:2px solid #28ACDC;padding-left:9px;margin-bottom:8px;">&ldquo;' + readabilityPd.headline + '&rdquo;</div>' : '') +
'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8B96A0;margin-bottom:8px;">The 5-second test: ' +
(readabilityPd.readabilityTest === 'pass' ? '<span style="color:#1E9E6B;">Pass &#10003;</span>' : '<span style="color:#D14343;">Needs work &#10007;</span>') +
'</div>';

const sectionsHtml =
sectionCard('Reliability', scores.reliability ?? 0, 35, '', (pillars.reliability || {}).working, (pillars.reliability || {}).missing) +
sectionCard('Readability', scores.readability ?? 0, 35, readabilityExtraHtml, readabilityPd.working, readabilityPd.missing) +
sectionCard('Resonance', scores.resonance ?? 0, 30, '', (pillars.resonance || {}).working, (pillars.resonance || {}).missing);

// --- top 3 actions, restyled to match the accent-soft .t3 cards on the site
const top3Html = top3.map(function (t, i) {
return '<div style="background:#E3F4FA;border:1px solid #DDE6EA;border-radius:14px;padding:15px;margin-bottom:10px;">' +
'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#1C8CB5;margin-bottom:4px;">Action ' + (i + 1) + '</div>' +
'<div style="font-family:Arial,sans-serif;font-weight:800;font-size:15px;color:#1C8CB5;margin-bottom:6px;">' + (t.title || '') + '</div>' +
'<div style="font-size:13px;color:#14181C;line-height:1.6;"><b>What:</b> ' + (t.what || '') + '<br><b>Why:</b> ' + (t.why || '') + '<br><b>How:</b> ' + (t.how || '') + '</div>' +
'</div>';
}).join('');

const top3Text = top3.map(function (t, i) {
return 'Action ' + (i + 1) + ': ' + (t.title || '') + '\n' +
'What: ' + (t.what || '') + '\n' +
'Why: ' + (t.why || '') + '\n' +
'How: ' + (t.how || '') + '\n';
}).join('\n');

const pillarsText = PILLARS.map(function (pl) {
const pd = pillars[pl.key] || {};
const score = scores[pl.key] ?? 0;
const working = Array.isArray(pd.working) ? pd.working : [];
const missing = Array.isArray(pd.missing) ? pd.missing : [];
let block = pl.label + ': ' + score + ' / ' + pl.max + '\n';
if (pl.key === 'readability') {
if (pd.headline) block += 'Headline: "' + pd.headline + '"\n';
block += 'The 5-second test: ' + (pd.readabilityTest === 'pass' ? 'Pass' : 'Needs work') + '\n';
}
working.forEach(function (w) { block += '+ ' + w + '\n'; });
missing.forEach(function (m) { block += '- ' + (m.gap || '') + ' -- fix: ' + (m.fix || '') + '\n'; });
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

// --- CTA: same branch logic as the site's ctaHTML -- what you see in the
// gated report unlocked view is exactly what's sent to the inbox ----------
let ctaHtml, ctaText;
if (recommendedTier && recommendedTier.tier && recommendedTier.tier !== 'none') {
ctaHtml = '<div style="background:#F4F9FB;border:1px solid #DDE6EA;border-radius:14px;padding:24px;text-align:center;">' +
'<div style="font-weight:800;font-size:17px;color:#14181C;margin-bottom:6px;">Here\'s your path to ' + recommendedTier.tier + '</div>' +
'<div style="font-size:13px;color:#55606A;margin-bottom:14px;line-height:1.5;">' + (recommendedTier.reason || '') + ' The <b>' + recommendedTier.tier + '</b> tier is built exactly to close this gap.</div>' +
'<a href="' + LINKEDIN_URL + '" style="display:inline-block;padding:12px 24px;background:#28ACDC;color:#04222C;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px;">This made sense? Let\'s talk &rarr;</a>' +
'</div>';
ctaText = 'Here\'s your path to ' + recommendedTier.tier + '\n' + (recommendedTier.reason || '') + ' The ' + recommendedTier.tier + ' tier is built exactly to close this gap.';
} else {
ctaHtml = '<div style="background:#F4F9FB;border:1px solid #DDE6EA;border-radius:14px;padding:24px;text-align:center;">' +
'<div style="font-weight:800;font-size:17px;color:#14181C;margin-bottom:6px;">You\'re Unignorable already</div>' +
'<div style="font-size:13px;color:#55606A;margin-bottom:14px;line-height:1.5;">Your profile is doing the work. If you ever want a second set of eyes on your content strategy, DM me and I\'ll take a look.</div>' +
'<a href="' + LINKEDIN_URL + '" style="display:inline-block;padding:12px 24px;background:#28ACDC;color:#04222C;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px;">This made sense? Let\'s talk &rarr;</a>' +
'</div>';
ctaText = 'You\'re Unignorable already\nYour profile is doing the work. If you ever want a second set of eyes on your content strategy, DM me and I\'ll take a look.';
}

const htmlContent = '<div style="font-family:Arial,sans-serif;background:#F4F9FB;padding:32px 16px;">' +
'<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #DDE6EA;">' +
heroHtml +
'<div style="padding:24px;">' + pillarBarsHtml + '</div>' +
'<div style="padding:0 24px 24px;">' +
'<p style="font-size:15px;color:#14181C;line-height:1.6;margin-top:0;">Hi ' + name + ', here is my full breakdown of your profile, plus the top 3 actions to take right now.</p>' +
sectionsHtml +
'<div style="font-size:11px;font-weight:700;color:#8A99A2;text-transform:uppercase;letter-spacing:.06em;margin:20px 0 10px;">Top 3 actions to take now</div>' +
top3Html +
tierTeaseHtml +
ctaHtml +
'<div style="margin-top:28px;padding-top:24px;border-top:1px solid #DDE6EA;">' +
'<img src="' + SIGNATURE_URL + '" width="440" alt="Tabish Hassan -- Founder, The Ladder" style="display:block;height:auto;max-width:440px;border:0;">' +
'</div>' +
'</div>' +
'<div style="padding:18px 24px;background:#F4F9FB;border-top:1px solid #DDE6EA;text-align:center;">' +
'<div style="font-size:11px;color:#8A99A2;line-height:1.6;">You are receiving this because you requested your Honest Read at ' +
'<a href="' + SITE_URL + '" style="color:#8A99A2;">rungcheck.tabishhassan.com</a>. ' +
'<a href="mailto:' + REPLY_EMAIL + '?subject=Unsubscribe" style="color:#8A99A2;">Unsubscribe</a>' +
'</div>' +
'</div>' +
'</div>' +
'</div>';

const textContent = 'Hi ' + name + ',\n\n' +
'Your Ladder Score: ' + totalScore + ' / 100\n\n' +
'FULL BREAKDOWN\n\n' +
pillarsText + '\n' +
'TOP 3 ACTIONS TO TAKE NOW\n\n' +
top3Text + '\n' +
'THE LADDER\n' +
'Seen -- Gets you noticed by future clients\n' +
'Remembered -- Makes you stay top of mind\n' +
'Unignorable -- Makes you unignorable in the feed\n\n' +
ctaText + '\n' +
'This made sense? Let\'s talk: ' + LINKEDIN_URL + '\n\n' +
'-- Tabish Hassan\n' +
'Founder, The Ladder\n' +
'rungcheck.tabishhassan.com | tabishhassan.com\n\n' +
'You are receiving this because you requested your Honest Read at rungcheck.tabishhassan.com.\n' +
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
subject: 'Your Honest Read: ' + totalScore + ' / 100',
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
try {
const numericScore = Number(totalScore);
await env.rung_check_leads.prepare(
'INSERT INTO leads (name, email, score, rung) VALUES (?, ?, ?, ?)'
).bind(name, email, isNaN(numericScore) ? null : numericScore, rung || null).run();
console.log('D1 lead insert OK');
} catch (e) {
console.error('D1 lead insert failed: ' + e.message);
}
}

return new Response(respText, {
status: brevoResp.status,
headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
});
}