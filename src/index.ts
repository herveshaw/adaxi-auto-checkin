/**
 * adaxi.net check-in worker.
 *
 * Two modes:
 *   1. Interactive web UI (manual captcha entry) — recommended, 100% success rate.
 *      GET  /                        → HTML page
 *      POST /api/start   (auth)      → login + fetch captcha → { adaxiToken, captchaImg, cookie }
 *      POST /api/submit  (auth)      → { adaxiToken, captcha, cookie } → sign result
 *
 *   2. Automatic (cron-triggered) — uses Workers AI vision model for OCR.
 *      scheduled()                   → tries OCR with retries, lower success rate.
 *      GET  /checkin?token=ADMIN     → trigger auto mode manually
 *
 *   3. Admin management page.
 *      GET  /admin                   → admin HTML page (login with username+password)
 *      POST /admin/api/login         → { username, password } → { token }
 *      GET  /admin/api/state (auth)  → { config, history, stats }
 *      POST /admin/api/config (auth) → update config
 *      DELETE /admin/api/history (auth) → clear history
 */

const SITE = 'https://adaxi.net';
const DEFAULT_MAX_AUTO_RETRIES = 8;
const DEFAULT_SCHEDULE_HOURS = [8, 12, 21]; // Beijing time
const HISTORY_LIMIT = 100;

interface Env {
  ADAXI_USERNAME: string;
  ADAXI_PASSWORD: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  ADMIN_TOKEN: string;
  AI: Ai;
  CHECKIN_KV: KVNamespace;
}

// ============================================================
// KV-backed config & history
// ============================================================

interface CheckinConfig {
  enabled: boolean;
  scheduleHours: number[]; // Beijing-time hours, e.g. [8, 12, 21]
  maxRetries: number;
  updatedAt: string;
}

interface LogEntry {
  ts: string;
  step: string;
  detail?: string;
}

interface HistoryEntry {
  ts: string;
  trigger: 'cron' | 'manual';
  success: boolean;
  alreadySignedIn: boolean;
  trafficBytes: number;
  attempts: number;
  ocrRaw: string;
  ocrClean: string;
  triedVariants: string[];
  message: string;
  durationMs: number;
  log: LogEntry[];
}

interface AutoCheckinResult {
  success: boolean;
  alreadySignedIn?: boolean;
  trafficBytes?: number;
  trafficHuman?: string;
  message?: string;
  attempts: number;
  log: LogEntry[];
}

interface LoginResponse {
  message: string;
  data: string | null;
  status: number;
}
interface CaptchaResponse {
  img?: string;
}
interface SignResponse {
  message: string;
  data: number | null;
  status: number;
}

const KEY_CONFIG = 'config';
const KEY_HISTORY = 'history';

function defaultConfig(): CheckinConfig {
  return {
    enabled: true,
    scheduleHours: DEFAULT_SCHEDULE_HOURS,
    maxRetries: DEFAULT_MAX_AUTO_RETRIES,
    updatedAt: new Date(0).toISOString(),
  };
}

async function getConfig(env: Env): Promise<CheckinConfig> {
  const raw = await env.CHECKIN_KV.get(KEY_CONFIG);
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<CheckinConfig>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      scheduleHours: Array.isArray(parsed.scheduleHours) && parsed.scheduleHours.length > 0
        ? parsed.scheduleHours
        : DEFAULT_SCHEDULE_HOURS,
      maxRetries: typeof parsed.maxRetries === 'number' && parsed.maxRetries > 0
        ? parsed.maxRetries
        : DEFAULT_MAX_AUTO_RETRIES,
      updatedAt: parsed.updatedAt || new Date(0).toISOString(),
    };
  } catch {
    return defaultConfig();
  }
}

async function setConfig(env: Env, cfg: CheckinConfig): Promise<void> {
  cfg.updatedAt = new Date().toISOString();
  await env.CHECKIN_KV.put(KEY_CONFIG, JSON.stringify(cfg));
}

async function getHistory(env: Env): Promise<HistoryEntry[]> {
  const raw = await env.CHECKIN_KV.get(KEY_HISTORY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr as HistoryEntry[] : [];
  } catch {
    return [];
  }
}

async function appendHistory(env: Env, entry: HistoryEntry): Promise<void> {
  const list = await getHistory(env);
  list.unshift(entry);
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  await env.CHECKIN_KV.put(KEY_HISTORY, JSON.stringify(list));
}

/** Beijing-time hour (0-23) for the given Date. */
function beijingHour(d: Date): number {
  return (d.getUTCHours() + 8) % 24;
}

interface CheckinStats {
  total: number;
  successCount: number;
  alreadySignedCount: number;
  failedCount: number;
  totalTrafficBytes: number;
  totalTrafficHuman: string;
  avgAttempts: number;
  avgDurationMs: number;
  lastRun: string | null;
  lastSuccess: string | null;
  successRate: number;
}

function computeStats(history: HistoryEntry[]): CheckinStats {
  const total = history.length;
  let successCount = 0;
  let alreadySignedCount = 0;
  let failedCount = 0;
  let totalTrafficBytes = 0;
  let attemptsSum = 0;
  let durationSum = 0;
  let lastRun: string | null = null;
  let lastSuccess: string | null = null;

  for (const h of history) {
    if (h.success) {
      successCount++;
      totalTrafficBytes += h.trafficBytes || 0;
      if (!lastSuccess || h.ts > lastSuccess) lastSuccess = h.ts;
    } else if (h.alreadySignedIn) {
      alreadySignedCount++;
    } else {
      failedCount++;
    }
    attemptsSum += h.attempts || 0;
    durationSum += h.durationMs || 0;
    if (!lastRun || h.ts > lastRun) lastRun = h.ts;
  }

  return {
    total,
    successCount,
    alreadySignedCount,
    failedCount,
    totalTrafficBytes,
    totalTrafficHuman: humanBytes(totalTrafficBytes),
    avgAttempts: total > 0 ? attemptsSum / total : 0,
    avgDurationMs: total > 0 ? durationSum / total : 0,
    lastRun,
    lastSuccess,
    successRate: total > 0 ? successCount / total : 0,
  };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cfg = await getConfig(env);
    if (!cfg.enabled) return;
    const hour = beijingHour(new Date());
    if (!cfg.scheduleHours.includes(hour)) return;
    ctx.waitUntil(autoCheckin(env, 'cron'));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/admin' && request.method === 'GET') {
      return new Response(ADMIN_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Public: admin login (username + password → returns ADMIN_TOKEN as session)
    if (url.pathname === '/admin/api/login' && request.method === 'POST') {
      try {
        if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_TOKEN) {
          return json({ error: '管理员凭据未配置' }, 503);
        }
        const body = (await request.json()) as { username?: string; password?: string };
        const u = (body.username || '').trim();
        const p = body.password || '';
        if (u !== env.ADMIN_USERNAME || p !== env.ADMIN_PASSWORD) {
          return json({ error: '账号或密码错误' }, 401);
        }
        return json({ ok: true, token: env.ADMIN_TOKEN });
      } catch (err: unknown) {
        return json({ error: (err as Error)?.message || String(err) }, 500);
      }
    }

    // All /api/* and /checkin routes require ADMIN_TOKEN
    if (!env.ADMIN_TOKEN) {
      return json({ error: 'ADMIN_TOKEN secret not set' }, 503);
    }
    const authHeader = request.headers.get('Authorization') ?? '';
    const urlToken = url.searchParams.get('token') ?? '';
    const isAuthed =
      authHeader === `Bearer ${env.ADMIN_TOKEN}` || urlToken === env.ADMIN_TOKEN;
    if (!isAuthed) {
      return json({ error: 'unauthorized' }, 401);
    }

    // --- Manual mode API ---
    if (url.pathname === '/api/start' && request.method === 'POST') {
      try {
        if (!env.ADAXI_USERNAME || !env.ADAXI_PASSWORD) {
          return json({ error: 'missing ADAXI credentials' }, 503);
        }
        const adaxiToken = await login(env.ADAXI_USERNAME, env.ADAXI_PASSWORD);
        const { img, cookie } = await fetchCaptchaWithCookie();
        return json({ ok: true, adaxiToken, captchaImg: img, cookie });
      } catch (err: unknown) {
        return json({ error: (err as Error)?.message || String(err) }, 500);
      }
    }

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { adaxiToken?: string; captcha?: string; cookie?: string };
        if (!body.adaxiToken || !body.captcha || !body.cookie) {
          return json({ error: 'missing adaxiToken, captcha, or cookie' }, 400);
        }
        const captcha = body.captcha.trim();
        if (!/^[A-Za-z0-9]{2}$/.test(captcha)) {
          return json({ error: '验证码必须是 2 位字母或数字' }, 400);
        }
        const sign = await signInWithCookie(body.adaxiToken, captcha, body.cookie);
        const alreadySignedIn = /已签|already|今日|重复|repeated/i.test(sign.message);
        return json({
          ok: sign.message === '签到成功',
          alreadySignedIn,
          message: sign.message,
          trafficBytes: sign.data ?? 0,
          trafficHuman: humanBytes(sign.data ?? 0),
        });
      } catch (err: unknown) {
        return json({ error: (err as Error)?.message || String(err) }, 500);
      }
    }

    // --- Auto mode (manual trigger of cron logic) ---
    if (url.pathname === '/checkin') {
      const result = await autoCheckin(env, 'manual');
      return json(result);
    }

    // --- Admin API: config + history + stats ---
    if (url.pathname === '/admin/api/state' && request.method === 'GET') {
      const [config, history] = await Promise.all([getConfig(env), getHistory(env)]);
      return json({ config, history, stats: computeStats(history) });
    }

    if (url.pathname === '/admin/api/config' && request.method === 'POST') {
      try {
        const body = (await request.json()) as Partial<CheckinConfig>;
        const cfg = await getConfig(env);
        if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled;
        if (Array.isArray(body.scheduleHours)) {
          const hours = body.scheduleHours
            .map(h => Number(h))
            .filter(h => Number.isInteger(h) && h >= 0 && h <= 23);
          if (hours.length === 0) return json({ error: 'scheduleHours 不能为空' }, 400);
          if (hours.length > 24) return json({ error: 'scheduleHours 最多 24 个' }, 400);
          cfg.scheduleHours = Array.from(new Set(hours)).sort((a, b) => a - b);
        }
        if (typeof body.maxRetries === 'number') {
          if (!Number.isInteger(body.maxRetries) || body.maxRetries < 1 || body.maxRetries > 30) {
            return json({ error: 'maxRetries 必须是 1-30 的整数' }, 400);
          }
          cfg.maxRetries = body.maxRetries;
        }
        await setConfig(env, cfg);
        return json({ ok: true, config: cfg });
      } catch (err: unknown) {
        return json({ error: (err as Error)?.message || String(err) }, 500);
      }
    }

    if (url.pathname === '/admin/api/history' && request.method === 'DELETE') {
      await env.CHECKIN_KV.delete(KEY_HISTORY);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};

// ============================================================
// Cookie-aware fetch helpers
// ============================================================

/**
 * Extract Set-Cookie value from a Response.
 * Workers fetch has two ways to read Set-Cookie:
 *   1. res.getSetCookie() — web standard, but may return empty array in some runtimes.
 *   2. res.headers.get('set-cookie') — Workers exposes it here even though it's "forbidden".
 */
function extractSetCookie(res: Response): string {
  const setCookies = (res as Response & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (setCookies.length > 0) return setCookies.join(', ');
  return res.headers.get('set-cookie') ?? '';
}

function parseCookieValue(setCookie: string, name: string): string | undefined {
  if (!setCookie) return undefined;
  for (const part of setCookie.split(',')) {
    const m = part.match(new RegExp(`\\b${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${SITE}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  const data = (await res.json()) as LoginResponse;
  if (!data.status || !data.data) {
    throw new Error(`login failed: ${data.message || 'unknown'}`);
  }
  return data.data;
}

async function fetchCaptchaWithCookie(): Promise<{ img: string; cookie: string }> {
  const res = await fetch(`${SITE}/captcha?${Math.random().toString(36).slice(2)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, image/webp, */*',
      'Referer': SITE + '/',
    },
  });
  if (!res.ok) throw new Error(`captcha HTTP ${res.status}`);
  const data = (await res.json()) as CaptchaResponse;
  if (!data.img) throw new Error('captcha response missing img field');
  const setCookie = extractSetCookie(res);
  const cookie = parseCookieValue(setCookie, 'vpnpn888');
  if (!cookie) throw new Error(`captcha did not set vpnpn888 cookie (set-cookie: ${setCookie || 'none'})`);
  return { img: data.img, cookie };
}

async function signInWithCookie(token: string, captcha: string, cookie: string): Promise<SignResponse> {
  const res = await fetch(`${SITE}/api/user/sign?v=${encodeURIComponent(captcha)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Cookie: `vpnpn888=${cookie}`,
    },
  });
  if (!res.ok) throw new Error(`sign HTTP ${res.status}`);
  return (await res.json()) as SignResponse;
}

// ============================================================
// Auto mode (Workers AI OCR with retries)
// ============================================================

async function autoCheckin(env: Env, trigger: 'cron' | 'manual' = 'manual'): Promise<AutoCheckinResult> {
  const log: LogEntry[] = [];
  const push = (step: string, detail?: string) =>
    log.push({ ts: new Date().toISOString(), step, detail });
  const startedAt = Date.now();

  push('start', `auto mode (${trigger})`);

  const cfg = await getConfig(env);
  const maxRetries = cfg.maxRetries;

  if (!env.ADAXI_USERNAME || !env.ADAXI_PASSWORD) {
    push('error', 'missing ADAXI_USERNAME or ADAXI_PASSWORD secret');
    return { success: false, attempts: 0, log };
  }

  let attempts = 0;
  let trafficBytes = 0;
  let ocrRaw = '';
  let ocrClean = '';
  let triedVariants: string[] = [];
  let message = '';

  try {
    push('login');
    const token = await login(env.ADAXI_USERNAME, env.ADAXI_PASSWORD);
    push('login.ok');

    let lastError: string | undefined;

    for (let i = 1; i <= maxRetries; i++) {
      attempts = i;
      push('attempt', `#${i}/${maxRetries}`);

      push('captcha.fetch');
      const { img: imageDataUrl, cookie } = await fetchCaptchaWithCookie();
      push('captcha.fetched', `${imageDataUrl.length} chars, cookie=${cookie.slice(0, 24)}...`);

      push('ocr');
      ocrRaw = await runOCR(env, imageDataUrl).catch(err => {
        push('ocr.error', String(err));
        return '';
      });
      ocrClean = cleanOcr(ocrRaw);
      push('ocr.result', `raw=${JSON.stringify(ocrRaw)} clean=${JSON.stringify(ocrClean)}`);

      if (!ocrClean || ocrClean.length !== 2) {
        lastError = `bad ocr length: "${ocrClean}" (raw: "${ocrRaw}")`;
        continue;
      }

      const variants = caseVariants(ocrClean);
      triedVariants = variants;
      push('sign', `trying variants: ${variants.join(', ')}`);

      let alreadyIn = false;
      let lastSignMsg = '';
      for (const v of variants) {
        const sign = await signInWithCookie(token, v, cookie);
        push('sign.try', `${v} -> ${sign.message}`);
        lastSignMsg = sign.message;
        if (sign.message === '签到成功') {
          trafficBytes = sign.data ?? 0;
          message = sign.message;
          push('done', `success with ${v}`);
          return finalize({
            success: true,
            trafficBytes,
            trafficHuman: humanBytes(trafficBytes),
            attempts,
            message,
            log,
          });
        }
        if (/已签|already|今日|重复|repeated/i.test(sign.message)) {
          alreadyIn = true;
          message = sign.message;
          break;
        }
      }

      if (alreadyIn) {
        push('done', 'already signed in');
        return finalize({
          success: false,
          alreadySignedIn: true,
          message,
          attempts,
          log,
        });
      }

      lastError = lastSignMsg;
      message = lastSignMsg;
    }

    push('done', 'failed');
    message = lastError || message;
    return finalize({ success: false, message, attempts, log });
  } catch (err: unknown) {
    const e = err as Error;
    push('error', e?.stack || e?.message || String(err));
    message = e?.message || String(err);
    return finalize({ success: false, message, attempts, log });
  }

  async function finalize(r: AutoCheckinResult): Promise<AutoCheckinResult> {
    const entry: HistoryEntry = {
      ts: new Date().toISOString(),
      trigger,
      success: r.success === true,
      alreadySignedIn: r.alreadySignedIn === true,
      trafficBytes: typeof r.trafficBytes === 'number' ? r.trafficBytes : trafficBytes,
      attempts: r.attempts,
      ocrRaw,
      ocrClean,
      triedVariants,
      message: r.message || message,
      durationMs: Date.now() - startedAt,
      log,
    };
    try {
      await appendHistory(env, entry);
    } catch (err) {
      push('history.error', String(err));
    }
    return r;
  }
}

async function runOCR(env: Env, imageDataUrl: string): Promise<string> {
  const prompt =
    'OCR this captcha image. It contains exactly 2 alphanumeric characters ' +
    '(A-Z, a-z, 0-9) on a dark background with light-colored strokes. ' +
    'Read both characters carefully, preserving letter case. ' +
    'Output ONLY the 2 characters separated by a space (e.g. "a B"). No other text.';

  try {
    const result = (await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      }],
      max_tokens: 32,
      temperature: 0.1,
    })) as { response?: string };

    const raw = (result?.response || '').trim();
    if (raw) return raw;
    throw new Error(`empty response (${JSON.stringify(result).slice(0, 200)})`);
  } catch (err) {
    throw new Error(`llama-4-scout OCR failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

function cleanOcr(text: string): string {
  if (!text) return '';

  const quoted = text.match(/["']([A-Za-z0-9])["']\s*(?:and|,|&)\s*["']([A-Za-z0-9])["']/);
  if (quoted) return (quoted[1] + quoted[2]);

  const ocrQuoted = text.match(/["']([A-Za-z0-9]{2})["']/);
  if (ocrQuoted) return ocrQuoted[1];

  const andMatch = text.match(/\b([A-Za-z0-9])\b\s+and\s+\b([A-Za-z0-9])\b/);
  if (andMatch) return (andMatch[1] + andMatch[2]);

  const tokens = text.match(/\b[A-Za-z0-9]\b/g);
  if (tokens) {
    const filtered = tokens.filter(t => !/^(a|A|an|An|the|The)$/.test(t));
    if (filtered.length >= 2) return (filtered[0] + filtered[1]);
    if (tokens.length >= 2) return (tokens[0] + tokens[1]);
  }

  const trimmed = text.trim();
  if (/^[A-Za-z0-9]{2}$/.test(trimmed)) return trimmed;
  const matches = text.match(/[A-Za-z0-9]/g);
  if (matches && matches.length >= 2) return (matches[0] + matches[1]);
  return '';
}

function caseVariants(s: string): string[] {
  if (s.length !== 2) return [s];
  const c1l = s[0].toLowerCase();
  const c1u = s[0].toUpperCase();
  const c2l = s[1].toLowerCase();
  const c2u = s[1].toUpperCase();
  const set = new Set<string>();
  set.add(c1l + c2l);
  set.add(c1l + c2u);
  set.add(c1u + c2l);
  set.add(c1u + c2u);
  return Array.from(set);
}

function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ============================================================
// Main page HTML (manual captcha entry)
// ============================================================

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>adaxi 签到</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .card {
    background: #1e293b;
    border-radius: 12px;
    padding: 28px;
    max-width: 420px;
    width: 100%;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
  }
  h1 { font-size: 20px; margin-bottom: 6px; color: #f1f5f9; }
  h2 { font-size: 15px; margin-bottom: 16px; color: #94a3b8; font-weight: 500; }
  .step { display: none; }
  .step.active { display: block; }
  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 14px;
    margin-bottom: 12px;
  }
  input:focus { outline: none; border-color: #3b82f6; }
  .btn {
    width: 100%;
    padding: 12px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity .2s;
  }
  .btn:hover { opacity: 0.9; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-success { background: #22c55e; color: white; }
  .btn-warn { background: #f59e0b; color: white; }
  .btn-error { background: #ef4444; color: white; }
  .btn-ghost { background: #334155; color: #e2e8f0; }
  .btn + .btn { margin-top: 8px; }
  .status {
    margin-top: 14px;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 13px;
    display: none;
  }
  .status.show { display: block; }
  .status.success { background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.3); }
  .status.error { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
  .status.warn { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
  .status.info { background: rgba(59,130,246,0.15); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3); }
  .captcha-wrap { text-align: center; margin-bottom: 12px; }
  .captcha-img {
    height: 64px;
    background: #0f172a;
    border-radius: 8px;
    border: 1px solid #334155;
    cursor: pointer;
    image-rendering: pixelated;
  }
  .captcha-input {
    text-align: center;
    font-size: 24px;
    letter-spacing: 8px;
    text-transform: uppercase;
    font-weight: 700;
  }
  .traffic-label {
    display: inline-block;
    padding: 4px 12px;
    background: rgba(34,197,94,0.15);
    color: #22c55e;
    border-radius: 999px;
    font-size: 12px;
    margin-bottom: 12px;
  }
  .traffic-num {
    font-size: 36px;
    color: #22c55e;
    font-weight: 800;
    text-align: center;
    margin: 8px 0 18px;
    word-break: break-all;
  }
  .already-icon {
    text-align: center;
    font-size: 56px;
    color: #f59e0b;
    margin-bottom: 16px;
    line-height: 1;
  }
  .already-title { text-align:center; font-size: 20px; margin-bottom: 8px; color: #f1f5f9; }
  .already-sub { text-align:center; color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
  .muted { color: #94a3b8; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>adaxi 签到</h1>
    <h2>手动签到面板</h2>

    <div class="step active" id="step-token">
      <p class="muted" style="margin-bottom:12px;">请输入管理员 Token 以继续</p>
      <input type="password" id="input-token" placeholder="ADMIN_TOKEN" autocomplete="off">
      <button class="btn btn-primary" onclick="saveToken()">确认</button>
    </div>

    <div class="step" id="step-ready">
      <p class="muted" style="margin-bottom:16px;">已验证身份，点击下方按钮开始签到流程。</p>
      <button class="btn btn-primary" onclick="startCheckin()">开始签到</button>
      <button class="btn btn-ghost" onclick="resetToken()">切换 Token</button>
    </div>

    <div class="step" id="step-captcha">
      <p class="muted" style="margin-bottom:8px;">请输入下图中的 2 位验证码</p>
      <div class="captcha-wrap">
        <img id="captcha-img" class="captcha-img" alt="验证码" onclick="refreshCaptcha()">
      </div>
      <input type="text" id="input-captcha" class="captcha-input" maxlength="2" placeholder="AB" autocomplete="off">
      <button class="btn btn-primary" onclick="submitCaptcha()">提交</button>
      <button class="btn btn-ghost" onclick="refreshCaptcha()">换一张</button>
    </div>

    <div class="step" id="step-result">
      <div style="text-align:center;">
        <span class="traffic-label">签到成功，本次获得流量</span>
        <div class="traffic-num" id="traffic-num">+ 0 B</div>
      </div>
      <button class="btn btn-success" onclick="showStep('step-ready')">再来一次</button>
    </div>

    <div class="step" id="step-already">
      <div class="already-icon">&#10003;</div>
      <div class="already-title">今日已签到</div>
      <div class="already-sub">明天再来，每日 08:00 重置</div>
      <button class="btn btn-ghost" onclick="showStep('step-ready')">返回</button>
    </div>

    <div class="status" id="status"></div>
  </div>

<script>
var adminToken = localStorage.getItem('adminToken') || '';
var adaxiToken = '';
var cookie = '';

function showStep(id) {
  var steps = document.querySelectorAll('.step');
  for (var i = 0; i < steps.length; i++) steps[i].classList.remove('active');
  document.getElementById(id).classList.add('active');
}

function showStatus(msg, type) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status show ' + (type || 'info');
}
function hideStatus() {
  document.getElementById('status').className = 'status';
}

function saveToken() {
  var v = document.getElementById('input-token').value.trim();
  if (!v) { showStatus('请输入 Token', 'error'); return; }
  adminToken = v;
  localStorage.setItem('adminToken', v);
  showStep('step-ready');
  hideStatus();
}

function resetToken() {
  adminToken = '';
  localStorage.removeItem('adminToken');
  document.getElementById('input-token').value = '';
  showStep('step-token');
}

function humanizeFallback(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var units = ['B','KB','MB','GB','TB','PB'];
  var i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + ' ' + units[i];
}

function setCaptchaImg(raw) {
  var src = raw || '';
  if (src && src.indexOf('data:') !== 0) src = 'data:image/png;base64,' + src;
  document.getElementById('captcha-img').src = src;
}

function startCheckin() {
  showStep('step-captcha');
  showStatus('正在登录并获取验证码...', 'info');
  fetch('/api/start', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + adminToken }
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { showStatus(d.error, 'error'); showStep('step-ready'); return; }
    adaxiToken = d.adaxiToken;
    cookie = d.cookie;
    setCaptchaImg(d.captchaImg);
    var inp = document.getElementById('input-captcha');
    inp.value = '';
    inp.focus();
    hideStatus();
  }).catch(function(e){ showStatus('请求失败: ' + e.message, 'error'); showStep('step-ready'); });
}

function refreshCaptcha() { startCheckin(); }

function submitCaptcha() {
  var c = document.getElementById('input-captcha').value.trim();
  if (!/^[A-Za-z0-9]{2}$/.test(c)) { showStatus('验证码必须是 2 位字母或数字', 'error'); return; }
  showStatus('提交中...', 'info');
  fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ adaxiToken: adaxiToken, cookie: cookie, captcha: c })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { showStatus(d.error, 'error'); return; }
    if (d.alreadySignedIn) {
      showStep('step-already');
      hideStatus();
      return;
    }
    if (d.ok) {
      var txt = '+' + (d.trafficHuman || humanizeFallback(d.trafficBytes));
      document.getElementById('traffic-num').textContent = txt;
      showStep('step-result');
      hideStatus();
      return;
    }
    showStatus(d.message || '签到失败', 'error');
  }).catch(function(e){ showStatus('请求失败: ' + e.message, 'error'); });
}

(function init(){
  if (adminToken) showStep('step-ready');
  else showStep('step-token');
})();
</script>
</body>
</html>`;

// ============================================================
// Admin management page
// ============================================================

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>adaxi 管理面板</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 20px; }
  .container { max-width: 1100px; margin: 0 auto; }
  .card { background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
  h1 { font-size: 22px; color: #f1f5f9; margin-bottom: 4px; }
  h2 { font-size: 15px; color: #94a3b8; font-weight: 500; margin-bottom: 16px; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .topbar .actions button { margin-left: 8px; }
  input[type="text"], input[type="password"], input[type="number"] {
    width: 100%; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 14px;
  }
  input:focus { outline: none; border-color: #3b82f6; }
  .btn { padding: 10px 16px; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .2s; }
  .btn:hover { opacity: 0.9; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-success { background: #22c55e; color: white; }
  .btn-warn { background: #f59e0b; color: white; }
  .btn-error { background: #ef4444; color: white; }
  .btn-ghost { background: #334155; color: #e2e8f0; }
  .login-box { max-width: 360px; margin: 80px auto; }
  .login-box input { margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .stat { background: #0f172a; border-radius: 8px; padding: 14px; border: 1px solid #334155; }
  .stat .label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  .stat .value { font-size: 20px; font-weight: 700; color: #f1f5f9; word-break: break-all; }
  .stat .value.green { color: #22c55e; }
  .stat .value.orange { color: #f59e0b; }
  .stat .value.red { color: #ef4444; }
  .stat .value.blue { color: #3b82f6; }
  .row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .row label { font-size: 13px; color: #94a3b8; min-width: 90px; }
  .toggle { position: relative; width: 44px; height: 24px; background: #334155; border-radius: 999px; cursor: pointer; transition: background .2s; flex-shrink: 0; }
  .toggle.on { background: #22c55e; }
  .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; background: white; border-radius: 50%; transition: transform .2s; }
  .toggle.on::after { transform: translateX(20px); }
  .hours { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .chip { padding: 5px 10px; border-radius: 999px; background: #0f172a; border: 1px solid #334155; font-size: 12px; cursor: pointer; color: #94a3b8; user-select: none; }
  .chip.on { background: #3b82f6; color: white; border-color: #3b82f6; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #334155; }
  th { color: #94a3b8; font-weight: 600; font-size: 12px; }
  tr.row-click { cursor: pointer; }
  tr.row-click:hover { background: rgba(59,130,246,0.08); }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.green { background: rgba(34,197,94,0.15); color: #22c55e; }
  .pill.orange { background: rgba(245,158,11,0.15); color: #f59e0b; }
  .pill.red { background: rgba(239,68,68,0.15); color: #ef4444; }
  .pill.gray { background: rgba(148,163,184,0.15); color: #94a3b8; }
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; align-items: center; justify-content: center; padding: 20px; }
  .modal-bg.show { display: flex; }
  .modal { background: #1e293b; border-radius: 12px; padding: 24px; max-width: 640px; width: 100%; max-height: 80vh; overflow: auto; }
  .modal h3 { margin-bottom: 12px; color: #f1f5f9; }
  .log { background: #0f172a; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; max-height: 320px; overflow: auto; }
  .log .line { margin-bottom: 4px; color: #cbd5e1; word-break: break-all; }
  .log .line .ts { color: #64748b; margin-right: 8px; }
  .log .line .step { color: #3b82f6; margin-right: 4px; }
  .empty { text-align: center; color: #64748b; padding: 20px; }
  .status { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; }
  .status.show { display: block; }
  .status.success { background: rgba(34,197,94,0.15); color: #22c55e; }
  .status.error { background: rgba(239,68,68,0.15); color: #ef4444; }
  .status.warn { background: rgba(245,158,11,0.15); color: #f59e0b; }
  .status.info { background: rgba(59,130,246,0.15); color: #3b82f6; }
  .table-wrap { overflow-x: auto; }
</style>
</head>
<body>
<div class="container">

  <div class="card login-box" id="login-card">
    <h1>adaxi 管理</h1>
    <h2>请登录</h2>
    <input type="text" id="login-user" placeholder="账号" autocomplete="off">
    <input type="password" id="login-pass" placeholder="密码">
    <button class="btn btn-primary" style="width:100%;margin-top:14px;" onclick="doLogin()">登录</button>
    <div class="status" id="login-status"></div>
  </div>

  <div id="dashboard" style="display:none;">
    <div class="topbar">
      <h1>adaxi 管理面板</h1>
      <div class="actions">
        <button class="btn btn-ghost" onclick="loadState()">刷新</button>
        <button class="btn btn-error" onclick="doLogout()">退出</button>
      </div>
    </div>

    <div class="card">
      <h2>统计</h2>
      <div class="stats" id="stats-grid"></div>
    </div>

    <div class="card">
      <h2>调度配置</h2>
      <div class="row">
        <label>启用</label>
        <div class="toggle" id="cfg-enabled" onclick="toggleEnabled()"></div>
      </div>
      <div class="row">
        <label>最大重试</label>
        <input type="number" id="cfg-retries" min="1" max="30" style="width:100px;">
        <span style="color:#64748b;font-size:12px;">(1-30)</span>
      </div>
      <div class="row" style="align-items:flex-start;">
        <label style="margin-top:6px;">签到小时</label>
        <div style="flex:1;min-width:240px;">
          <div style="color:#64748b;font-size:12px;margin-bottom:4px;">北京时间 (UTC+8)，点击切换</div>
          <div class="hours" id="cfg-hours"></div>
        </div>
      </div>
      <div class="row" style="margin-top:14px;">
        <button class="btn btn-primary" onclick="saveConfig()">保存配置</button>
        <button class="btn btn-ghost" onclick="restoreDefault()">恢复默认</button>
      </div>
      <div class="status" id="cfg-status"></div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <h2 style="margin:0;">历史记录</h2>
        <div>
          <button class="btn btn-success" onclick="runNow()">立即签到</button>
          <button class="btn btn-error" onclick="clearHistory()">清空历史</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>时间</th><th>触发</th><th>结果</th><th>流量</th><th>尝试</th><th>OCR</th><th>耗时</th>
          </tr></thead>
          <tbody id="history-body"></tbody>
        </table>
      </div>
      <div class="status" id="dash-status"></div>
    </div>
  </div>

  <div class="modal-bg" id="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <h3 id="modal-title">详情</h3>
      <div id="modal-meta" style="margin-bottom:12px;font-size:13px;color:#94a3b8;"></div>
      <div class="log" id="modal-log"></div>
      <button class="btn btn-ghost" style="margin-top:14px;" onclick="closeModal()">关闭</button>
    </div>
  </div>

</div>

<script>
var token = localStorage.getItem('adminToken') || '';
var stateData = null;
var selHours = {};

function setStatus(id, msg, type) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status show ' + (type || 'info');
}
function hideStatus(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'status';
}

function api(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Authorization'] = 'Bearer ' + token;
  return fetch(path, opts);
}

function fmtDate(s) {
  if (!s) return '-';
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  var pad = function(n){ return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function fmtRel(s) {
  if (!s) return '-';
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  var diff = Date.now() - d.getTime();
  if (diff < 0) return fmtDate(s);
  if (diff < 60000) return Math.floor(diff/1000) + ' 秒前';
  if (diff < 3600000) return Math.floor(diff/60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff/3600000) + ' 小时前';
  return Math.floor(diff/86400000) + ' 天前';
}
function fmtMs(ms) {
  if (!ms || ms <= 0) return '-';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms/1000).toFixed(2) + ' s';
}
function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  var units = ['B','KB','MB','GB','TB','PB'];
  var i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + ' ' + units[i];
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function doLogin() {
  var u = document.getElementById('login-user').value.trim();
  var p = document.getElementById('login-pass').value;
  if (!u || !p) { setStatus('login-status', '请输入账号和密码', 'error'); return; }
  setStatus('login-status', '登录中...', 'info');
  fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { setStatus('login-status', d.error, 'error'); return; }
    token = d.token;
    localStorage.setItem('adminToken', token);
    hideStatus('login-status');
    enterDashboard();
  }).catch(function(e){ setStatus('login-status', '请求失败: ' + e.message, 'error'); });
}

function doLogout() {
  token = '';
  localStorage.removeItem('adminToken');
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-card').style.display = 'block';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
}

function enterDashboard() {
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  loadState();
}

function loadState() {
  setStatus('dash-status', '加载中...', 'info');
  api('/admin/api/state').then(function(r){
    if (r.status === 401) { doLogout(); throw new Error('unauthorized'); }
    return r.json();
  }).then(function(d){
    if (d.error) { setStatus('dash-status', d.error, 'error'); return; }
    stateData = d;
    renderStats(d.stats);
    renderConfig(d.config);
    renderHistory(d.history);
    hideStatus('dash-status');
  }).catch(function(e){
    if (e && e.message === 'unauthorized') return;
    setStatus('dash-status', '请求失败: ' + (e && e.message ? e.message : e), 'error');
  });
}

function renderStats(s) {
  if (!s) s = { total:0, successCount:0, alreadySignedCount:0, failedCount:0, totalTrafficBytes:0, totalTrafficHuman:'0 B', avgAttempts:0, avgDurationMs:0, lastRun:null, lastSuccess:null, successRate:0 };
  var cards = [
    { l: '总次数', v: s.total, c: '' },
    { l: '成功', v: s.successCount, c: 'green' },
    { l: '已签(跳过)', v: s.alreadySignedCount, c: 'orange' },
    { l: '失败', v: s.failedCount, c: 'red' },
    { l: '累计流量', v: s.totalTrafficHuman || fmtBytes(s.totalTrafficBytes), c: 'blue' },
    { l: '成功率', v: (s.successRate * 100).toFixed(1) + '%', c: '' },
    { l: '平均尝试', v: s.avgAttempts.toFixed(2), c: '' },
    { l: '平均耗时', v: fmtMs(s.avgDurationMs), c: '' },
    { l: '上次运行', v: fmtRel(s.lastRun), c: '' },
    { l: '上次成功', v: fmtRel(s.lastSuccess), c: 'green' }
  ];
  var html = '';
  for (var i = 0; i < cards.length; i++) {
    html += '<div class="stat"><div class="label">' + cards[i].l + '</div><div class="value ' + cards[i].c + '">' + cards[i].v + '</div></div>';
  }
  document.getElementById('stats-grid').innerHTML = html;
}

function renderConfig(cfg) {
  document.getElementById('cfg-enabled').classList.toggle('on', !!cfg.enabled);
  document.getElementById('cfg-retries').value = cfg.maxRetries;
  selHours = {};
  if (cfg.scheduleHours && cfg.scheduleHours.length) {
    for (var i = 0; i < cfg.scheduleHours.length; i++) selHours[cfg.scheduleHours[i]] = true;
  }
  renderHours();
}

function renderHours() {
  var html = '';
  for (var h = 0; h < 24; h++) {
    var on = !!selHours[h];
    var label = h < 10 ? '0' + h : '' + h;
    html += '<div class="chip ' + (on ? 'on' : '') + '" onclick="toggleHour(' + h + ')">' + label + '</div>';
  }
  document.getElementById('cfg-hours').innerHTML = html;
}

function toggleHour(h) {
  if (selHours[h]) delete selHours[h]; else selHours[h] = true;
  renderHours();
}

function toggleEnabled() {
  document.getElementById('cfg-enabled').classList.toggle('on');
}

function saveConfig() {
  var enabled = document.getElementById('cfg-enabled').classList.contains('on');
  var retries = parseInt(document.getElementById('cfg-retries').value, 10);
  if (!retries || retries < 1 || retries > 30) { setStatus('cfg-status', '重试次数必须是 1-30 的整数', 'error'); return; }
  var hours = [];
  for (var h in selHours) hours.push(parseInt(h, 10));
  if (hours.length === 0) { setStatus('cfg-status', '至少选择一个小时', 'error'); return; }
  hours.sort(function(a,b){ return a-b; });
  setStatus('cfg-status', '保存中...', 'info');
  api('/admin/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled, maxRetries: retries, scheduleHours: hours })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { setStatus('cfg-status', d.error, 'error'); return; }
    setStatus('cfg-status', '已保存', 'success');
    setTimeout(function(){ hideStatus('cfg-status'); }, 1500);
  }).catch(function(e){ setStatus('cfg-status', '请求失败: ' + e.message, 'error'); });
}

function restoreDefault() {
  selHours = { 8: true, 12: true, 21: true };
  document.getElementById('cfg-enabled').classList.add('on');
  document.getElementById('cfg-retries').value = 8;
  renderHours();
  setStatus('cfg-status', '已恢复默认值（需点击保存）', 'warn');
}

function resultPill(h) {
  if (h.success) return '<span class="pill green">成功</span>';
  if (h.alreadySignedIn) return '<span class="pill orange">已签</span>';
  return '<span class="pill red">失败</span>';
}
function triggerLabel(t) { return t === 'cron' ? 'cron' : 'manual'; }

function renderHistory(list) {
  if (!list || list.length === 0) {
    document.getElementById('history-body').innerHTML = '<tr><td colspan="7" class="empty">暂无历史记录</td></tr>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var h = list[i];
    html += '<tr class="row-click" onclick="showDetail(' + i + ')">'
      + '<td>' + fmtDate(h.ts) + '</td>'
      + '<td><span class="pill gray">' + triggerLabel(h.trigger) + '</span></td>'
      + '<td>' + resultPill(h) + '</td>'
      + '<td>' + (h.success ? fmtBytes(h.trafficBytes) : '-') + '</td>'
      + '<td>' + (h.attempts || 0) + '</td>'
      + '<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(h.ocrClean || '') + '">' + escapeHtml(h.ocrClean || '-') + '</td>'
      + '<td>' + fmtMs(h.durationMs) + '</td>'
      + '</tr>';
  }
  document.getElementById('history-body').innerHTML = html;
}

function showDetail(idx) {
  if (!stateData || !stateData.history) return;
  var h = stateData.history[idx];
  if (!h) return;
  document.getElementById('modal-title').innerHTML = '运行详情 ' + resultPill(h);
  var meta = '时间: ' + fmtDate(h.ts) + '  |  触发: ' + triggerLabel(h.trigger) + '  |  尝试: ' + (h.attempts||0) + '  |  耗时: ' + fmtMs(h.durationMs);
  if (h.success) meta += '  |  流量: ' + fmtBytes(h.trafficBytes);
  if (h.message) meta += '  |  消息: ' + h.message;
  document.getElementById('modal-meta').textContent = meta;
  var logHtml = '';
  if (h.ocrRaw) {
    logHtml += '<div class="line"><span class="ts">--</span><span class="step">[ocrRaw]</span>' + escapeHtml(h.ocrRaw) + '</div>';
  }
  if (h.ocrClean) {
    logHtml += '<div class="line"><span class="ts">--</span><span class="step">[ocrClean]</span>' + escapeHtml(h.ocrClean) + '</div>';
  }
  if (h.triedVariants && h.triedVariants.length) {
    logHtml += '<div class="line"><span class="ts">--</span><span class="step">[triedVariants]</span>' + escapeHtml(h.triedVariants.join(', ')) + '</div>';
  }
  if (h.log && h.log.length) {
    for (var i = 0; i < h.log.length; i++) {
      var l = h.log[i];
      logHtml += '<div class="line"><span class="ts">' + escapeHtml(l.ts || '') + '</span><span class="step">[' + escapeHtml(l.step || '') + ']</span>' + escapeHtml(l.detail || '') + '</div>';
    }
  }
  if (!logHtml) logHtml = '<div class="line">无日志</div>';
  document.getElementById('modal-log').innerHTML = logHtml;
  document.getElementById('modal-bg').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-bg').classList.remove('show');
}

function runNow() {
  setStatus('dash-status', '正在签到...', 'info');
  api('/checkin').then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { setStatus('dash-status', d.error, 'error'); return; }
    var msg, type;
    if (d.success) { msg = '签到成功: ' + (d.trafficHuman || fmtBytes(d.trafficBytes)); type = 'success'; }
    else if (d.alreadySignedIn) { msg = '今日已签到'; type = 'warn'; }
    else { msg = d.message || '签到失败'; type = 'error'; }
    setStatus('dash-status', msg, type);
    loadState();
  }).catch(function(e){ setStatus('dash-status', '请求失败: ' + e.message, 'error'); });
}

function clearHistory() {
  if (!confirm('确认清空所有历史记录？')) return;
  api('/admin/api/history', { method: 'DELETE' }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { setStatus('dash-status', d.error, 'error'); return; }
    setStatus('dash-status', '已清空', 'success');
    setTimeout(function(){ hideStatus('dash-status'); }, 1500);
    loadState();
  }).catch(function(e){ setStatus('dash-status', '请求失败: ' + e.message, 'error'); });
}

(function init(){
  if (token) {
    api('/admin/api/state').then(function(r){
      if (r.status === 401) { doLogout(); return; }
      enterDashboard();
    }).catch(function(){ doLogout(); });
  } else {
    document.getElementById('login-card').style.display = 'block';
    document.getElementById('dashboard').style.display = 'none';
  }
})();
</script>
</body>
</html>`;
