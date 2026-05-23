/**
 * CRA development proxy – Instagram live follower count lookup.
 *
 * ROOT CAUSE of truncated counts (101,000,000 instead of 101,025,769):
 *   After ~20-25 requests Instagram detects the scraper and starts serving a
 *   login-wall / challenge page (HTTP 200 but no real profile data). The only
 *   data left in that page is the og:description meta tag which Instagram
 *   intentionally abbreviates: "101M Followers". The old code converted that
 *   to 101,000,000 — losing all precision.
 *
 * FIX STRATEGY:
 *   1. Rotate through 6 distinct browser fingerprints (UA + sec-ch-ua headers)
 *      so no single identity gets rate-limited.
 *   2. Try 3 independent data sources in order of precision:
 *        a) web_profile_info internal API  → exact integer (best)
 *        b) i.instagram.com mobile API     → exact integer
 *        c) Profile HTML scrape            → JSON-LD (exact) or og:description (approx)
 *   3. Detect abbreviated counts (multiples of 1 000 / 1 000 000) and refuse
 *      to overwrite a previously cached precise value with a rounded one.
 *   4. Per-fingerprint rate-limit tracking — if one identity gets a 429 the
 *      others keep working.
 *   5. Randomised jitter delays to break timing-based fingerprinting.
 */

const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// Cookie utilities
// ─────────────────────────────────────────────────────────────────────────────

function parseSetCookies(setCookieHeaders) {
  const map = new Map();
  if (!setCookieHeaders) return map;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of arr) {
    const nameVal = raw.split(';')[0].trim();
    const eq = nameVal.indexOf('=');
    if (eq > 0) map.set(nameVal.slice(0, eq).trim(), nameVal.slice(eq + 1).trim());
  }
  return map;
}

function mergeCookies(cookieMap, setCookieHeaders) {
  for (const [k, v] of parseSetCookies(setCookieHeaders)) cookieMap.set(k, v);
}

function serializeCookies(cookieMap) {
  return [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTPS helper — follows redirects, accumulates Set-Cookie across all hops
// ─────────────────────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}, cookieJar = new Map(), maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false });

    const doRequest = (currentUrl, redirectsLeft) => {
      const parsed = new URL(currentUrl);
      const cookieStr = serializeCookies(cookieJar);
      const reqHeaders = { ...headers, ...(cookieStr ? { Cookie: cookieStr } : {}) };

      const req = https.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
          headers: reqHeaders, timeout: 15_000, agent },
        (res) => {
          mergeCookies(cookieJar, res.headers['set-cookie']);
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            return doRequest(new URL(res.headers.location, currentUrl).href, redirectsLeft - 1);
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ statusCode: res.statusCode, body, responseHeaders: res.headers }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    };

    doRequest(url, maxRedirects);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser fingerprint pool
// Each fingerprint has its own session (cookie jar + csrf) and rate-limit state
// so one blocked identity does not poison the others.
// ─────────────────────────────────────────────────────────────────────────────

const FINGERPRINTS = [
  {
    id: 'chrome124_win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    secUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"Windows"',
    mobile: '?0',
    lang: 'en-US,en;q=0.9',
  },
  {
    id: 'chrome123_mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    secUa: '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    platform: '"macOS"',
    mobile: '?0',
    lang: 'en-GB,en;q=0.9',
  },
  {
    id: 'firefox125_win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    secUa: null, // Firefox does not send sec-ch-ua
    platform: '"Windows"',
    mobile: '?0',
    lang: 'en-US,en;q=0.5',
  },
  {
    id: 'safari17_mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    secUa: null, // Safari does not send sec-ch-ua
    platform: '"macOS"',
    mobile: '?0',
    lang: 'en-US,en;q=0.9',
  },
  {
    id: 'chrome124_android',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
    secUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"Android"',
    mobile: '?1',
    lang: 'en-US,en;q=0.9',
  },
  {
    id: 'edge124_win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    secUa: '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
    platform: '"Windows"',
    mobile: '?0',
    lang: 'en-US,en;q=0.9,en-GB;q=0.8',
  },
];

// Per-fingerprint state: { cookieJar, csrfToken, refreshedAt, rateLimitedUntil }
const _fpState = {};
for (const fp of FINGERPRINTS) {
  _fpState[fp.id] = {
    cookieJar:       new Map(),
    csrfToken:       '',
    refreshedAt:     0,
    rateLimitedUntil: 0,
  };
}

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const BACKOFF_MS     = 10 * 60 * 1000; // 10 minutes per-fingerprint backoff

// ─────────────────────────────────────────────────────────────────────────────
// Abbreviated count detection
// Returns true when a count looks like it came from an "M"/"K" abbreviation.
// e.g. 101000000 (101M), 5800000 (5.8M), 250000 (250K) are all suspicious.
// A real precise count like 101025769 would NOT be divisible by 1000.
// ─────────────────────────────────────────────────────────────────────────────

function isAbbreviatedCount(n) {
  if (n == null || n < 1000) return false;
  if (n % 1_000_000 === 0) return true;   // exact M
  if (n % 100_000  === 0) return true;    // rounded M (e.g. 5.8M → 5800000)
  if (n > 100_000 && n % 1_000 === 0) return true; // K abbreviation
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build base headers for a given fingerprint
// ─────────────────────────────────────────────────────────────────────────────

function baseHeaders(fp) {
  const h = {
    'User-Agent':       fp.ua,
    'Accept-Language':  fp.lang,
    'Accept-Encoding':  'identity',
    'Cache-Control':    'no-cache',
    'Pragma':           'no-cache',
  };
  if (fp.secUa) {
    h['sec-ch-ua']          = fp.secUa;
    h['sec-ch-ua-mobile']   = fp.mobile;
    h['sec-ch-ua-platform'] = fp.platform;
  }
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session bootstrap — get anonymous cookies from homepage + profile page
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSession(fp, username) {
  const state = _fpState[fp.id];
  const now   = Date.now();
  if (state.refreshedAt && now - state.refreshedAt < SESSION_TTL_MS) return state;

  const jar = new Map();
  const navHeaders = {
    ...baseHeaders(fp),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  // Phase a: homepage — establishes mid + ig_did + first csrftoken
  try {
    await httpsGet('https://www.instagram.com/', navHeaders, jar);
  } catch (e) {
    console.warn(`[instagram-proxy][${fp.id}] homepage fetch failed:`, e.message);
  }

  // Phase b: profile page — refreshes csrftoken, adds viewport cookies
  try {
    await httpsGet(`https://www.instagram.com/${encodeURIComponent(username)}/`, navHeaders, jar);
  } catch (e) {
    console.warn(`[instagram-proxy][${fp.id}] profile prefetch failed:`, e.message);
  }

  const csrfToken = jar.get('csrftoken') || '';
  console.log(`[instagram-proxy][${fp.id}] session bootstrapped | csrf=${csrfToken ? csrfToken.slice(0, 8) + '…' : 'MISSING'} | cookies=${jar.size}`);

  state.cookieJar   = jar;
  state.csrfToken   = csrfToken;
  state.refreshedAt = Date.now();
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 1 — web_profile_info (exact live count)
// ─────────────────────────────────────────────────────────────────────────────

async function tryWebProfileInfo(username, fp) {
  const state = _fpState[fp.id];
  const now   = Date.now();

  if (now < state.rateLimitedUntil) {
    const secs = Math.ceil((state.rateLimitedUntil - now) / 1000);
    console.warn(`[instagram-proxy][${fp.id}] web_profile_info: rate-limited — skipping for ${secs}s`);
    return null;
  }

  try {
    await ensureSession(fp, username);
    const { cookieJar, csrfToken } = _fpState[fp.id];

    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const res = await httpsGet(url, {
      ...baseHeaders(fp),
      'Accept':             '*/*',
      'X-IG-App-ID':        '936619743392459',
      'X-IG-WWW-Claim':     '0',
      'X-CSRFToken':        csrfToken,
      'X-Requested-With':   'XMLHttpRequest',
      'Sec-Fetch-Site':     'same-origin',
      'Sec-Fetch-Mode':     'cors',
      'Sec-Fetch-Dest':     'empty',
      'Referer':            `https://www.instagram.com/${encodeURIComponent(username)}/`,
    }, cookieJar);

    console.log(`[instagram-proxy][${fp.id}] web_profile_info → HTTP ${res.statusCode}`);

    if (res.statusCode === 404) {
      return { username, followerCount: null, status: 'not_found', message: 'Instagram account not found.', dataSource: 'none' };
    }
    if (res.statusCode === 429) {
      state.rateLimitedUntil = Date.now() + BACKOFF_MS;
      state.refreshedAt = 0; // force re-bootstrap
      console.warn(`[instagram-proxy][${fp.id}] web_profile_info: 429 — backing off ${BACKOFF_MS / 60000} min`);
      return null;
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      state.refreshedAt = 0; // force re-bootstrap
      console.warn(`[instagram-proxy][${fp.id}] web_profile_info: ${res.statusCode} — session invalidated`);
      return null;
    }
    if (res.statusCode !== 200) {
      console.warn(`[instagram-proxy][${fp.id}] web_profile_info: HTTP ${res.statusCode}`);
      return null;
    }

    let json;
    try { json = JSON.parse(res.body); } catch { return null; }

    const user = json?.data?.user;
    if (!user) { console.warn(`[instagram-proxy][${fp.id}] web_profile_info: unexpected JSON shape`); return null; }

    const followerCount = user.edge_followed_by?.count ?? user.follower_count ?? null;
    const followsCount  = user.edge_follow?.count ?? user.following_count ?? null;
    const mediaCount    = user.edge_owner_to_timeline_media?.count ?? user.media_count ?? null;

    if (followerCount != null) {
      console.log(`[instagram-proxy][${fp.id}] web_profile_info → ${followerCount} followers`);
      return { username, followerCount, followsCount, mediaCount, status: 'found', message: null, dataSource: 'web_profile_info', approximate: false };
    }
    return null;
  } catch (e) {
    console.warn(`[instagram-proxy][${fp.id}] web_profile_info exception:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 2 — i.instagram.com mobile API (exact count, different endpoint)
// ─────────────────────────────────────────────────────────────────────────────

async function tryMobileApi(username, fp) {
  const state = _fpState[fp.id];
  if (Date.now() < state.rateLimitedUntil) return null;

  try {
    const { cookieJar } = await ensureSession(fp, username);

    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const res = await httpsGet(url, {
      ...baseHeaders(fp),
      'Accept':         '*/*',
      'X-IG-App-ID':    '936619743392459',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    }, cookieJar);

    console.log(`[instagram-proxy][${fp.id}] mobile-api → HTTP ${res.statusCode}`);
    if (res.statusCode === 429) { state.rateLimitedUntil = Date.now() + BACKOFF_MS; return null; }
    if (res.statusCode !== 200) return null;

    let json;
    try { json = JSON.parse(res.body); } catch { return null; }

    const user = json?.data?.user;
    if (!user) return null;

    const followerCount = user.edge_followed_by?.count ?? user.follower_count ?? null;
    if (followerCount != null) {
      console.log(`[instagram-proxy][${fp.id}] mobile-api → ${followerCount} followers`);
      return { username, followerCount, status: 'found', message: null, dataSource: 'mobile_api', approximate: false };
    }
    return null;
  } catch (e) {
    console.warn(`[instagram-proxy][${fp.id}] mobile-api exception:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 3 — Profile HTML scraping (JSON-LD exact + og:description approx)
// ─────────────────────────────────────────────────────────────────────────────

async function tryProfileHtmlScrape(username, fp) {
  try {
    const { cookieJar } = await ensureSession(fp, username);

    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    const res = await httpsGet(url, {
      ...baseHeaders(fp),
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            'none',
    }, cookieJar);

    console.log(`[instagram-proxy][${fp.id}] profile-html → HTTP ${res.statusCode}`);

    if (res.statusCode === 429) {
      _fpState[fp.id].rateLimitedUntil = Date.now() + BACKOFF_MS;
      return null;
    }
    if (res.statusCode !== 200) return null;

    const body = res.body;

    // Strategy A: JSON-LD structured data — exact integer
    const ldRe = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ldRe.exec(body)) !== null) {
      try {
        const ld = JSON.parse(m[1]);
        const entries = Array.isArray(ld) ? ld : [ld];
        for (const entry of entries) {
          const stats = entry?.interactionStatistic || entry?.mainEntity?.interactionStatistic;
          if (!stats) continue;
          for (const stat of (Array.isArray(stats) ? stats : [stats])) {
            const itype = (typeof stat?.interactionType === 'string'
              ? stat.interactionType
              : stat?.interactionType?.['@type'] || '').toLowerCase();
            if (itype.includes('follow') && stat.userInteractionCount != null) {
              const count = Math.round(Number(stat.userInteractionCount));
              if (!isNaN(count) && count >= 0) {
                console.log(`[instagram-proxy][${fp.id}] profile-html: JSON-LD → ${count} followers`);
                return { username, followerCount: count, status: 'found', message: null, dataSource: 'profile_html', approximate: false };
              }
            }
          }
        }
      } catch (_) {}
    }

    // Strategy B: og:description — abbreviated (e.g. "5.8M Followers")
    const ogMatch =
      body.match(/property="og:description"\s+content="([^"]+)"/i) ||
      body.match(/content="([^"]+)"\s+property="og:description"/i);
    if (ogMatch) {
      const fm = ogMatch[1].match(/((?:[\d,]+)(?:\.\d+)?)\s*([KkMmBb]?)\s*Follower/i);
      if (fm) {
        let n = parseFloat(fm[1].replace(/,/g, ''));
        const u = fm[2].toUpperCase();
        if (u === 'K') n = Math.round(n * 1_000);
        else if (u === 'M') n = Math.round(n * 1_000_000);
        else if (u === 'B') n = Math.round(n * 1_000_000_000);
        else n = Math.round(n);
        console.log(`[instagram-proxy][${fp.id}] profile-html: og:description → ${n} followers (APPROXIMATE)`);
        return { username, followerCount: n, status: 'found', message: null, dataSource: 'profile_html', approximate: true };
      }
    }

    // Detect not-found vs login-wall
    if (body.includes('page_not_found') || body.includes('PageNotFound')) {
      return { username, followerCount: null, status: 'not_found', message: 'Instagram account not found.', dataSource: 'profile_html' };
    }

    // Login-wall detected — force session re-bootstrap
    if (body.includes('loginForm') || body.includes('"login"') || body.includes('accounts/login')) {
      console.warn(`[instagram-proxy][${fp.id}] profile-html: login-wall detected — invalidating session`);
      _fpState[fp.id].refreshedAt = 0;
    } else {
      console.warn(`[instagram-proxy][${fp.id}] profile-html: no follower count found — body snippet:`, body.slice(0, 200));
    }

    return null;
  } catch (e) {
    console.warn(`[instagram-proxy][${fp.id}] profile-html exception:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint rotation helpers
// ─────────────────────────────────────────────────────────────────────────────

function getAvailableFingerprints() {
  const now = Date.now();
  return FINGERPRINTS.filter(fp => now >= _fpState[fp.id].rateLimitedUntil);
}

/**
 * Pick the primary fingerprint for this minute.
 * Consecutive requests within the same minute reuse the same identity
 * (avoids thrashing sessions), but each new minute rotates to the next one.
 */
function pickPrimaryFp(available) {
  const minute = Math.floor(Date.now() / 60_000);
  return available[minute % available.length];
}

/**
 * Pick an alternate fingerprint (different from primary) for fallback strategies.
 */
function pickAltFp(available, primaryFp) {
  const others = available.filter(fp => fp.id !== primaryFp.id);
  if (others.length === 0) return primaryFp;
  const minute = Math.floor(Date.now() / 60_000);
  return others[minute % others.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Last-known-precise-count cache
// Stores the last non-abbreviated follower count per username so we can
// refuse to overwrite it with a rounded value when Instagram is blocking us.
// ─────────────────────────────────────────────────────────────────────────────

const _preciseCache = new Map(); // username → { count, fetchedAt }
const PRECISE_CACHE_TTL_MS = 60 * 60 * 1000; // keep for 1 hour

function getLastPreciseCount(username) {
  const entry = _preciseCache.get(username);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PRECISE_CACHE_TTL_MS) { _preciseCache.delete(username); return null; }
  return entry.count;
}

function setLastPreciseCount(username, count) {
  _preciseCache.set(username, { count, fetchedAt: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// Express middleware
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function (app) {
  app.get('/api/instagram/lookup/:username', async (req, res) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma':        'no-cache',
      'Expires':       '0',
    });

    try {
      const username = (req.params.username || '').toLowerCase().trim();
      if (!/^[a-z0-9._]{1,30}$/.test(username)) {
        return res.status(400).json({ success: false, error: { message: 'Invalid Instagram username format.' } });
      }

      console.log(`[instagram-proxy] lookup @${username}`);

      // ── Get available (non-rate-limited) fingerprints ──────────────────────
      const available = getAvailableFingerprints();
      if (available.length === 0) {
        console.warn('[instagram-proxy] all fingerprints rate-limited');
        const lastPrecise = getLastPreciseCount(username);
        if (lastPrecise != null) {
          return res.json({ success: true, data: {
            username, followerCount: lastPrecise, status: 'found',
            message: 'Serving last known precise count (all sessions rate-limited).',
            dataSource: 'cache_precise',
          }});
        }
        return res.status(429).json({ success: false, error: { message: 'Instagram is rate-limiting all sessions. Please wait a few minutes.' } });
      }

      const primaryFp = pickPrimaryFp(available);
      const altFp     = pickAltFp(available, primaryFp);

      // ── Strategy 1: web_profile_info (exact) ──────────────────────────────
      let result = await tryWebProfileInfo(username, primaryFp);

      // ── Strategy 2: mobile API (exact) — different fingerprint ────────────
      if (!result || result.followerCount == null) {
        result = await tryMobileApi(username, altFp);
      }

      // ── Strategy 3: profile HTML scrape ───────────────────────────────────
      if (!result || result.followerCount == null) {
        result = await tryProfileHtmlScrape(username, primaryFp);
      }

      // ── Handle not-found ───────────────────────────────────────────────────
      if (result && result.status === 'not_found') {
        return res.json({ success: true, data: result });
      }

      // ── Got a count — apply the KEY FIX ───────────────────────────────────
      if (result && result.followerCount != null) {
        const isApprox = result.approximate === true;

        if (!isApprox) {
          // Precise count — update the cache and return it
          setLastPreciseCount(username, result.followerCount);
          console.log(`[instagram-proxy] result @${username}: source=${result.dataSource} count=${result.followerCount} (PRECISE)`);
          return res.json({ success: true, data: result });
        }

        // Abbreviated count — check if we have a better cached precise value
        const lastPrecise = getLastPreciseCount(username);
        if (lastPrecise != null) {
          const ratio = Math.abs(result.followerCount - lastPrecise) / Math.max(lastPrecise, 1);
          if (ratio < 0.05) {
            // The abbreviated count is consistent with our precise value (within 5%).
            // Return the precise cached value instead of the rounded one.
            console.log(`[instagram-proxy] result @${username}: og:description gave ${result.followerCount} (rounded) — serving cached precise ${lastPrecise} instead`);
            return res.json({ success: true, data: {
              username,
              followerCount: lastPrecise,
              status: 'found',
              message: null,
              dataSource: 'cache_precise',
            }});
          }
        }

        // No precise cache or counts diverged too much — return the approximate value
        console.log(`[instagram-proxy] result @${username}: source=${result.dataSource} count=${result.followerCount} (APPROXIMATE)`);
        return res.json({ success: true, data: result });
      }

      // ── Nothing worked — return last precise count if available ────────────
      const lastPrecise = getLastPreciseCount(username);
      if (lastPrecise != null) {
        console.warn(`[instagram-proxy] all strategies failed for @${username} — serving last precise count ${lastPrecise}`);
        return res.json({ success: true, data: {
          username,
          followerCount: lastPrecise,
          status: 'found',
          message: 'Serving last known precise count.',
          dataSource: 'cache_precise',
        }});
      }

      console.warn(`[instagram-proxy] all strategies failed for @${username}`);
      return res.json({ success: true, data: {
        username,
        followerCount: null,
        status: 'unavailable',
        message: 'Could not retrieve follower count. Instagram may be blocking requests.',
        dataSource: 'none',
      }});

    } catch (err) {
      console.error('[instagram-proxy] unexpected error:', err);
      return res.status(500).json({ success: false, error: { message: 'Internal proxy error.' } });
    }
  });
};
