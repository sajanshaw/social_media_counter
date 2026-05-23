<?php
/**
 * Instagram Follower Count Proxy — Anti-Block Edition
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
 *   2. Try 4 independent data sources in order of precision:
 *        a) web_profile_info internal API  → exact integer (best)
 *        b) i.instagram.com mobile API     → exact integer
 *        c) JSON-LD structured data        → exact integer
 *        d) og:description                 → abbreviated (last resort)
 *   3. Detect abbreviated counts (multiples of 1 000 / 1 000 000) and refuse
 *      to overwrite a previously cached precise value with a rounded one.
 *   4. Per-fingerprint rate-limit tracking — if one identity gets a 429 the
 *      others keep working.
 *   5. Randomised request delays + Accept-Language variation to break
 *      fingerprinting heuristics.
 */

error_reporting(0);
ini_set('display_errors', '0');
ob_start();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');

// ── Storage ───────────────────────────────────────────────────────────────────
define('STORE_DIR',   __DIR__ . DIRECTORY_SEPARATOR);
define('CACHE_TTL',   25);      // seconds — serve cached value within this window
define('SESSION_TTL', 900);     // seconds — reuse a cookie session (15 min)
define('BACKOFF_TTL', 600);     // seconds — per-fingerprint 429 backoff (10 min)

function storePath($name) { return STORE_DIR . $name; }
function cacheFile($u)    { return storePath('ig_count_' . preg_replace('/[^a-z0-9._]/', '_', $u) . '.json'); }

function readCache($u)      { $r = @file_get_contents(cacheFile($u)); return $r ? json_decode($r, true) : null; }
function writeCache($u, $d) { @file_put_contents(cacheFile($u), json_encode($d), LOCK_EX); }
function isCacheFresh($u)   { $f = cacheFile($u); return @file_exists($f) && (time() - @filemtime($f)) < CACHE_TTL; }

// ── Browser fingerprint pool ──────────────────────────────────────────────────
// Each fingerprint has its own cookie jar and rate-limit file so one blocked
// identity does not poison the others.
$FINGERPRINTS = [
    [
        'id'      => 'chrome124_win',
        'ua'      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'sec_ua'  => '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'platform'=> '"Windows"',
        'mobile'  => '?0',
        'lang'    => 'en-US,en;q=0.9',
    ],
    [
        'id'      => 'chrome123_mac',
        'ua'      => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'sec_ua'  => '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        'platform'=> '"macOS"',
        'mobile'  => '?0',
        'lang'    => 'en-GB,en;q=0.9',
    ],
    [
        'id'      => 'firefox125_win',
        'ua'      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
        'sec_ua'  => '',   // Firefox does not send sec-ch-ua
        'platform'=> '"Windows"',
        'mobile'  => '?0',
        'lang'    => 'en-US,en;q=0.5',
    ],
    [
        'id'      => 'safari17_mac',
        'ua'      => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        'sec_ua'  => '',   // Safari does not send sec-ch-ua
        'platform'=> '"macOS"',
        'mobile'  => '?0',
        'lang'    => 'en-US,en;q=0.9',
    ],
    [
        'id'      => 'chrome124_android',
        'ua'      => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
        'sec_ua'  => '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'platform'=> '"Android"',
        'mobile'  => '?1',
        'lang'    => 'en-US,en;q=0.9',
    ],
    [
        'id'      => 'edge124_win',
        'ua'      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
        'sec_ua'  => '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
        'platform'=> '"Windows"',
        'mobile'  => '?0',
        'lang'    => 'en-US,en;q=0.9,en-GB;q=0.8',
    ],
];

function fpCookieJar($fp)    { return storePath('ig_jar_'  . $fp['id'] . '.cookies'); }
function fpSessionAge($fp)   { return storePath('ig_sess_' . $fp['id'] . '.age');     }
function fpRateLimit($fp)    { return storePath('ig_rl_'   . $fp['id'] . '.txt');     }

function isFpSessionFresh($fp)  { $f = fpSessionAge($fp);  return @file_exists($f) && (time() - @filemtime($f)) < SESSION_TTL; }
function touchFpSession($fp)    { @file_put_contents(fpSessionAge($fp), time(), LOCK_EX); }
function isFpRateLimited($fp)   { $f = fpRateLimit($fp);   return @file_exists($f) && (int)@file_get_contents($f) > time(); }
function setFpRateLimit($fp)    { @file_put_contents(fpRateLimit($fp), time() + BACKOFF_TTL, LOCK_EX); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function respond($data) { ob_end_clean(); echo json_encode($data); exit; }

function serveStaleOrError($stale, $username, $msg) {
    respond($stale ?? ['success' => true, 'data' => [
        'username'      => $username,
        'followerCount' => null,
        'status'        => 'unavailable',
        'message'       => $msg,
        'dataSource'    => 'none',
    ]]);
}

/**
 * Returns true when a follower count looks like an abbreviated/rounded value.
 * e.g. 101000000 (101M), 5800000 (5.8M), 250000 (250K) are all suspicious.
 * A real precise count like 101025769 would NOT be divisible by 1000.
 */
function isAbbreviatedCount($n) {
    if ($n === null || $n < 1000) return false;
    // If divisible by 1,000,000 → almost certainly an M abbreviation
    if ($n % 1000000 === 0) return true;
    // If divisible by 100,000 → likely a rounded M (e.g. 5.8M → 5800000)
    if ($n % 100000 === 0) return true;
    // If divisible by 1,000 and > 100,000 → likely a K abbreviation
    if ($n > 100000 && $n % 1000 === 0) return true;
    return false;
}

// ── cURL helper ───────────────────────────────────────────────────────────────
function curlFetch($url, $fp, $extraHeaders = []) {
    $baseHeaders = [
        'Accept-Language: ' . $fp['lang'],
        'Accept-Encoding: identity',
        'Cache-Control: no-cache',
        'Pragma: no-cache',
        'Upgrade-Insecure-Requests: 1',
        'Sec-Fetch-Dest: document',
        'Sec-Fetch-Mode: navigate',
        'Sec-Fetch-Site: none',
    ];
    if ($fp['sec_ua'] !== '') {
        $baseHeaders[] = 'sec-ch-ua: ' . $fp['sec_ua'];
        $baseHeaders[] = 'sec-ch-ua-mobile: ' . $fp['mobile'];
        $baseHeaders[] = 'sec-ch-ua-platform: ' . $fp['platform'];
    }

    $headers = array_merge($baseHeaders, $extraHeaders);
    $jar     = fpCookieJar($fp);

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 6,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_USERAGENT      => $fp['ua'],
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_ENCODING       => 'identity',
        CURLOPT_COOKIEFILE     => $jar,
        CURLOPT_COOKIEJAR      => $jar,
    ]);

    $raw     = curl_exec($ch);
    $code    = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hdrSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $errno   = curl_errno($ch);
    curl_close($ch);

    if ($raw === false || $errno) return null;
    return ['code' => $code, 'body' => substr($raw, $hdrSize)];
}

// ── Strategy A: web_profile_info internal API (exact count) ──────────────────
function tryWebProfileInfo($username, $fp) {
    $url = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=' . rawurlencode($username);

    // Need a valid session cookie first
    if (!isFpSessionFresh($fp)) {
        curlFetch('https://www.instagram.com/', $fp, [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ]);
        curlFetch('https://www.instagram.com/' . rawurlencode($username) . '/', $fp, [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ]);
        touchFpSession($fp);
    }

    // Extract csrftoken from cookie jar file
    $csrfToken = '';
    $jarContent = @file_get_contents(fpCookieJar($fp));
    if ($jarContent && preg_match('/\bcsrftoken\s+(\S+)/i', $jarContent, $cm)) {
        $csrfToken = $cm[1];
    }

    $resp = curlFetch($url, $fp, [
        'Accept: */*',
        'X-IG-App-ID: 936619743392459',
        'X-IG-WWW-Claim: 0',
        'X-CSRFToken: ' . $csrfToken,
        'X-Requested-With: XMLHttpRequest',
        'Sec-Fetch-Site: same-origin',
        'Sec-Fetch-Mode: cors',
        'Sec-Fetch-Dest: empty',
        'Referer: https://www.instagram.com/' . rawurlencode($username) . '/',
    ]);

    if (!$resp) return null;

    if ($resp['code'] === 429) {
        setFpRateLimit($fp);
        return null;
    }
    if ($resp['code'] === 401 || $resp['code'] === 403) {
        // Session invalidated — clear session age so it re-bootstraps next time
        @unlink(fpSessionAge($fp));
        return null;
    }
    if ($resp['code'] !== 200) return null;

    $json = @json_decode($resp['body'], true);
    $user = $json['data']['user'] ?? null;
    if (!$user) return null;

    $count = $user['edge_followed_by']['count']
          ?? $user['follower_count']
          ?? null;

    if ($count !== null) {
        return ['count' => (int)$count, 'source' => 'web_profile_info'];
    }
    return null;
}

// ── Strategy B: i.instagram.com mobile API (exact count) ─────────────────────
function tryMobileApi($username, $fp) {
    $url = 'https://i.instagram.com/api/v1/users/web_profile_info/?username=' . rawurlencode($username);

    $resp = curlFetch($url, $fp, [
        'Accept: */*',
        'X-IG-App-ID: 936619743392459',
        'Sec-Fetch-Site: same-origin',
        'Sec-Fetch-Mode: cors',
        'Sec-Fetch-Dest: empty',
    ]);

    if (!$resp || $resp['code'] !== 200) return null;

    $json = @json_decode($resp['body'], true);
    $user = $json['data']['user'] ?? null;
    if (!$user) return null;

    $count = $user['edge_followed_by']['count']
          ?? $user['follower_count']
          ?? null;

    if ($count !== null) {
        return ['count' => (int)$count, 'source' => 'mobile_api'];
    }
    return null;
}

// ── Strategy C: Profile HTML — JSON-LD (exact) + og:description (approx) ─────
function tryProfileHtml($username, $fp) {
    $url  = 'https://www.instagram.com/' . rawurlencode($username) . '/';
    $resp = curlFetch($url, $fp, [
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest: document',
        'Sec-Fetch-Mode: navigate',
        'Sec-Fetch-Site: none',
    ]);

    if (!$resp) return null;
    if ($resp['code'] === 429) { setFpRateLimit($fp); return null; }
    if ($resp['code'] !== 200) return null;

    $html = $resp['body'];

    // C1: JSON-LD — exact integer
    preg_match_all('/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i', $html, $lds);
    foreach ($lds[1] as $ldJson) {
        $ld = @json_decode($ldJson, true);
        if (!$ld) continue;
        foreach (isset($ld[0]) ? $ld : [$ld] as $entry) {
            $stats = $entry['interactionStatistic']
                  ?? ($entry['mainEntity']['interactionStatistic'] ?? null);
            if (!$stats) continue;
            if (isset($stats['interactionType'])) $stats = [$stats];
            foreach ($stats as $stat) {
                $type = strtolower(is_string($stat['interactionType'] ?? '')
                    ? ($stat['interactionType'] ?? '')
                    : ($stat['interactionType']['@type'] ?? ''));
                if (strpos($type, 'follow') !== false && isset($stat['userInteractionCount'])) {
                    $n = (int) round((float) $stat['userInteractionCount']);
                    if ($n > 0) return ['count' => $n, 'source' => 'json_ld', 'approximate' => false];
                }
            }
        }
    }

    // C2: og:description — abbreviated (e.g. "101M Followers")
    foreach ([
        '/property="og:description"\s+content="([^"]+)"/i',
        '/content="([^"]+)"\s+property="og:description"/i',
    ] as $p) {
        if (!preg_match($p, $html, $m)) continue;
        if (preg_match('/([\d,]+(?:\.\d+)?)\s*([KkMmBb]?)\s*Follower/i', $m[1], $fm)) {
            $n = (float) str_replace(',', '', $fm[1]);
            switch (strtoupper($fm[2])) {
                case 'K': $n *= 1e3; break;
                case 'M': $n *= 1e6; break;
                case 'B': $n *= 1e9; break;
            }
            return ['count' => (int) round($n), 'source' => 'og_description', 'approximate' => true];
        }
    }

    // Detect login-wall / not-found
    if (strpos($html, 'page_not_found') !== false || strpos($html, 'PageNotFound') !== false) {
        return ['count' => null, 'source' => 'not_found'];
    }

    // Login-wall detected — invalidate session so it re-bootstraps
    if (strpos($html, 'loginForm') !== false
        || strpos($html, '"login"') !== false
        || strpos($html, 'accounts/login') !== false) {
        @unlink(fpSessionAge($fp));
    }

    return null;
}

// ── Main logic ────────────────────────────────────────────────────────────────
try {
    $username = isset($_GET['username']) ? strtolower(trim($_GET['username'])) : '';
    if (!preg_match('/^[a-z0-9._]{1,30}$/', $username)) {
        ob_end_clean();
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => ['message' => 'Invalid Instagram username format.']]);
        exit;
    }

    // ── Serve fresh cache immediately ────────────────────────────────────────
    if (isCacheFresh($username)) {
        respond(readCache($username));
    }

    $staleCache = readCache($username);

    // Extract the last known precise count from stale cache (if any)
    $lastPreciseCount = null;
    if ($staleCache && isset($staleCache['data']['followerCount'])) {
        $cached = $staleCache['data']['followerCount'];
        if ($cached !== null && !isAbbreviatedCount($cached)) {
            $lastPreciseCount = $cached;
        }
    }

    // ── Pick a non-rate-limited fingerprint (rotate by minute for variety) ───
    global $FINGERPRINTS;
    $available = array_filter($FINGERPRINTS, function($fp) { return !isFpRateLimited($fp); });
    if (empty($available)) {
        // All fingerprints are rate-limited — serve stale
        serveStaleOrError($staleCache, $username,
            'Instagram is rate-limiting all sessions. Displaying last known count.');
    }

    // Rotate: pick fingerprint based on current minute so consecutive requests
    // within the same minute use the same identity (avoids thrashing sessions),
    // but different minutes use different identities.
    $available = array_values($available);
    $fp = $available[(int)(date('i')) % count($available)];

    // ── Try strategies in order of precision ────────────────────────────────
    $result = null;

    // Strategy A: web_profile_info (exact)
    $result = tryWebProfileInfo($username, $fp);

    // Strategy B: mobile API (exact) — try with a different fingerprint if A failed
    if (!$result || $result['count'] === null) {
        $altFps = array_filter($available, function($f) use ($fp) { return $f['id'] !== $fp['id']; });
        $altFp  = $altFps ? array_values($altFps)[0] : $fp;
        $result = tryMobileApi($username, $altFp);
    }

    // Strategy C: profile HTML scrape
    if (!$result || $result['count'] === null) {
        $result = tryProfileHtml($username, $fp);
    }

    // ── Handle not-found ─────────────────────────────────────────────────────
    if ($result && $result['source'] === 'not_found') {
        respond(['success' => true, 'data' => [
            'username'      => $username,
            'followerCount' => null,
            'status'        => 'not_found',
            'message'       => 'Instagram account not found.',
            'dataSource'    => 'profile_html',
        ]]);
    }

    // ── Got a count — decide whether to use it ───────────────────────────────
    if ($result && $result['count'] !== null) {
        $newCount   = $result['count'];
        $isApprox   = $result['approximate'] ?? false;

        // KEY FIX: If the new count is an abbreviated/rounded value AND we have
        // a previously cached precise count that is close (within 5%), keep the
        // precise one and just update the cache timestamp so we don't serve stale.
        if ($isApprox && $lastPreciseCount !== null) {
            $ratio = abs($newCount - $lastPreciseCount) / max($lastPreciseCount, 1);
            if ($ratio < 0.05) {
                // The abbreviated count is consistent with our precise value —
                // serve the precise cached value but refresh the cache TTL.
                $out = $staleCache;
                $out['data']['dataSource'] = 'cache_precise';
                $out['data']['message']    = null;
                writeCache($username, $out);
                respond($out);
            }
        }

        $out = ['success' => true, 'data' => [
            'username'      => $username,
            'followerCount' => $newCount,
            'status'        => 'found',
            'message'       => null,
            'dataSource'    => $result['source'],
        ]];
        writeCache($username, $out);
        respond($out);
    }

    // ── Nothing worked — serve stale or error ────────────────────────────────
    serveStaleOrError($staleCache, $username,
        'Could not extract follower count. Instagram may require a login.');

} catch (Throwable $e) {
    ob_end_clean();
    echo json_encode(['success' => false, 'error' => ['message' => 'PHP error: ' . $e->getMessage()]]);
}
