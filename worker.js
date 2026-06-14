/* =====================================================================
   Cloudflare Worker — שרת תזכורות (Web Push)
   שולח התראות אמיתיות גם כשהאפליקציה/הדפדפן סגורים.

   הגדרות נדרשות בדאשבורד של Cloudflare (ראה SETUP_PUSH.md):
   - KV Namespace בשם CAL  (Binding: CAL)
   - Variable  VAPID_PUBLIC       = המפתח הציבורי
   - Secret    VAPID_PRIVATE_JWK  = המפתח הפרטי (JSON)
   - Variable  VAPID_SUBJECT      = mailto:your@email.com
   - Cron Trigger: * * * * *   (כל דקה)

   הקובץ הזה אינו מכיל סודות — בטוח גם אם נחשף. אל תכניס לכאן את המפתח הפרטי.
   ===================================================================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // שמירה: רשימת תזכורות משותפת לכל המכשירים + רישום מינוי ההתראות של המכשיר
    if (url.pathname === '/save' && request.method === 'POST') {
      try {
        const data = await request.json();
        // הרשימה המשותפת = מקור האמת. כל מכשיר כותב אליה.
        if (Array.isArray(data.reminders)) {
          let prev = {}; try { prev = JSON.parse(await env.CAL.get('shared:reminders')) || {}; } catch (e) {}
          await env.CAL.put('shared:reminders', JSON.stringify({
            reminders: data.reminders,
            nextId: data.nextId || 0,
            wa: (data.wa !== undefined ? data.wa : prev.wa) || null,
            updated: Date.now()
          }));
        }
        // רישום/עדכון מינוי ההתראות של המכשיר הזה (אם נשלח)
        if (data.subscription && data.subscription.endpoint) {
          const id = await hashEndpoint(data.subscription.endpoint);
          await env.CAL.put('sub:' + id, JSON.stringify({
            subscription: data.subscription,
            tz: data.tz || 'Asia/Jerusalem',
            updated: Date.now()
          }));
        }
        return json({ ok: true }, 200, cors);
      } catch (e) { return json({ error: String(e) }, 500, cors); }
    }

    // טעינה: כל מכשיר מושך את הרשימה המשותפת
    if (url.pathname === '/load') {
      try {
        const raw = await env.CAL.get('shared:reminders');
        if (!raw) return json({ reminders: [], nextId: 0 }, 200, cors);
        return new Response(raw, { status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
      } catch (e) { return json({ error: String(e) }, 500, cors); }
    }

    if (url.pathname === '/test' && request.method === 'POST') {
      try {
        const data = await request.json();
        const status = await sendPush(data.subscription, {
          title: 'בדיקת התראה ✅',
          body: 'ההתראות עובדות! תקבל אותן גם כשהאפליקציה סגורה.',
          tag: 'test'
        }, env);
        return json({ ok: status === 201 || status === 200, status }, 200, cors);
      } catch (e) { return json({ error: String(e) }, 500, cors); }
    }

    return new Response('Calendar push worker is running.', { headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  }
};

/* ===== בדיקת תזכורות שהגיע זמנן (רץ כל דקה) =====
   קורא את הרשימה המשותפת פעם אחת, ושולח כל תזכורת שהגיע זמנה
   לכל המכשירים הרשומים (Mac, Windows, טלפון...). */
async function runChecks(env) {
  const sharedRaw = await env.CAL.get('shared:reminders');
  if (!sharedRaw) return;
  let shared; try { shared = JSON.parse(sharedRaw); } catch (e) { return; }
  const reminders = shared.reminders || [];
  if (!reminders.length) return;
  const wa = shared.wa || null;

  // ===== שליחת וואטסאפ (פעם אחת לכל תזכורת, ללא תלות במכשירים) =====
  if (wa && wa.enabled && wa.phone && wa.key) {
    const p = nowParts('Asia/Jerusalem');
    const nowNaive = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    for (const r of reminders) {
      if (!r.time) continue;
      const tp = r.time.split(':'); const hh = +tp[0], mm = +tp[1];
      const offsets = [r.notifMin || 0];
      if (r.notifMin2 != null && r.notifMin2 !== '' && (+r.notifMin2) !== (r.notifMin || 0)) offsets.push(+r.notifMin2);
      for (let dayOff = -1; dayOff <= 2; dayOff++) {
        const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + dayOff));
        const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
        if (!isOccurrence(r, Y, M, D)) continue;
        const occNaive = Date.UTC(Y, M - 1, D, hh, mm);
        for (const nm of offsets) {
          const notifyNaive = occNaive - nm * 60000;
          const diff = nowNaive - notifyNaive;
          if (diff >= 0 && diff < 3 * 60000) {
            const fid = 'fired:wa:' + r.id + ':' + notifyNaive;
            if (await env.CAL.get(fid)) continue;
            await env.CAL.put(fid, '1', { expirationTtl: 600 });
            await sendWhatsApp(wa.phone, '🔔 ' + (r.title || 'תזכורת') + ' — ' + notifBody(r, nm), wa.key);
          }
        }
      }
    }
  }

  // איסוף כל המכשירים הרשומים
  const subList = await env.CAL.list({ prefix: 'sub:' });
  const devices = [];
  for (const k of subList.keys) {
    const raw = await env.CAL.get(k.name);
    if (!raw) continue;
    let rec; try { rec = JSON.parse(raw); } catch (e) { continue; }
    if (rec.subscription) devices.push({ key: k.name, sub: rec.subscription, tz: rec.tz || 'Asia/Jerusalem' });
  }
  if (!devices.length) return;

  for (const dev of devices) {
    const tz = dev.tz;
    const p = nowParts(tz);
    const nowNaive = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);

    for (const r of reminders) {
      if (!r.time) continue;
      const tp = r.time.split(':'); const hh = +tp[0], mm = +tp[1];
      const offsets = [r.notifMin || 0];
      if (r.notifMin2 != null && r.notifMin2 !== '' && (+r.notifMin2) !== (r.notifMin || 0)) offsets.push(+r.notifMin2);
      for (let dayOff = -1; dayOff <= 2; dayOff++) {
        const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + dayOff));
        const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
        if (!isOccurrence(r, Y, M, D)) continue;
        const occNaive = Date.UTC(Y, M - 1, D, hh, mm);
        for (const nm of offsets) {
          const notifyNaive = occNaive - nm * 60000;
          const diff = nowNaive - notifyNaive;
          if (diff >= 0 && diff < 3 * 60000) {
            const fid = 'fired:' + dev.key.slice(4) + ':' + r.id + ':' + notifyNaive;
            if (await env.CAL.get(fid)) continue;
            await env.CAL.put(fid, '1', { expirationTtl: 600 });
            const status = await sendPush(dev.sub, {
              title: r.title || 'תזכורת',
              body: notifBody(r, nm),
              tag: 'r' + r.id + '-' + nm
            }, env).catch(() => 0);
            if (status === 404 || status === 410) { await env.CAL.delete(dev.key); }
          }
        }
      }
    }
  }
}

async function sendWhatsApp(phone, text, key) {
  const url = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(phone) +
    '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(key);
  try { await fetch(url); } catch (e) {}
}
function notifBody(r, notifMin) {
  let parts = [];
  if (notifMin >= 2880) parts.push('בעוד יומיים');
  else if (notifMin >= 1440) parts.push('מחר');
  else if (notifMin >= 60) parts.push('בעוד ' + (notifMin / 60) + ' שעות');
  else if (notifMin > 0) parts.push('בעוד ' + notifMin + ' דקות');
  if (r.time) parts.push('בשעה ' + r.time);
  if (r.notes) parts.push(r.notes);
  return parts.join(' · ') || 'תזכורת קרובה';
}

/* ===== זמן נוכחי באזור הזמן של המשתמש ===== */
function nowParts(tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const o = {};
  for (const part of f.formatToParts(new Date())) o[part.type] = part.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}

/* ===== האם התזכורת חלה בתאריך נתון ===== */
function isOccurrence(r, Y, M, D) {
  const b = r.date.split('-').map(Number);
  const by = b[0], bm = b[1], bd = b[2];
  const cmp = Date.UTC(Y, M - 1, D) - Date.UTC(by, bm - 1, bd);
  switch (r.recur) {
    case 'daily': return cmp >= 0;
    case 'weekly': return cmp >= 0 && (Math.round(cmp / 86400000) % 7 === 0);
    case 'monthly': return cmp >= 0 && D === bd;
    case 'yearly': return cmp >= 0 && M === bm && D === bd;
    default: return Y === by && M === bm && D === bd;
  }
}

/* ===== שליחת Push (VAPID + הצפנת aes128gcm לפי RFC 8291) ===== */
async function sendPush(subscription, payloadObj, env) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(subscription, plaintext);
  const aud = new URL(subscription.endpoint).origin;
  const jwt = await vapidJwt(aud, env);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '600',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC
    },
    body
  });
  return res.status;
}

async function vapidJwt(aud, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com'
  })));
  const signingInput = header + '.' + payload;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
  return signingInput + '.' + b64u(sig);
}

async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64uToBytes(subscription.keys.p256dh);
  const authSecret = b64uToBytes(subscription.keys.auth);

  const asPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPair.privateKey, 256));

  const enc = new TextEncoder();
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  const rs = new Uint8Array([0, 0, 0x10, 0x00]); // record size 4096
  const head = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(head, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/* ===== עזרים ===== */
function concat() {
  let len = 0; for (const a of arguments) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arguments) { out.set(a, o); o += a.length; }
  return out;
}
function b64u(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
async function hashEndpoint(ep) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ep));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
}
