<?php
/**
 * Instagram Follower Count Proxy — Anti-Block + Hostinger Edition
 *
 * Designed for Hostinger shared hosting (innotechia.in) with:
 *   • open_basedir restrictions  → all files written to __DIR__ (always allowed)
 *   • No shell_exec / proc_open  → pure cURL only
 *   • SSL peer verification      → uses Hostinger's bundled CA bundle
 *   • LOCK_EX file writes        → safe under concurrent PHP-FPM workers
 *   • 8-second browser poll      → server-side 25 s cache absorbs the load;
 *                                   Instagram is only hit every ~25 s
 *
 * ROOT CAUSE of truncated counts (101,000,000 instead of 101,025,769):
 *   After ~20-25 requests Instagram detects the scraper and starts serving a
 *   login-wall page (HTTP 200 but no real data). The only data left is the
 *   og:description meta tag which Instagram abbreviates: "101M Followers".
 *   The old code converted that to 101,000,000 — losing all precision.
 *
 * FIX STRATEGY:
 *   1. Rotate 6 browser fingerprints — each has its own cookie jar + RL state.
 *   2. Three strategies in precision order:
 *        A) web_profile_info API  → exact integer
 *        B) i.instagram.com API   → exact integer (different endpoint)
 *        C) Profile HTML          → JSON-LD exact, then og:description approx
 *   3. Detect abbreviated counts; refuse to overwrite a precise cached value.
 *   4. Per-fingerprint 429 backoff — one blocked identity ≠ all blocked.
 *   5. Login-wall detection → invalidate session → re-bootstrap next request.
 */

// ── PHP hardening ─────────────────────────────────────────────────────────────
error_reporting(0);
ini_set('display_errors', '0');
ob_start();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Access-Control-Allow-Origin: *');

// ── Storage — always __DIR__ (safe inside Hostinger open_basedir) ─────────────
define('STORE_DIR',   __DIR__ . DIRECTORY_SEPARATOR);
define('CACHE_TTL',   25);    // seconds — browser polls every 8 s; serve cache
define('SESSION_TTL', 900);   // seconds — reuse cookie session (15 min)
define('BACKOFF_TTL', 600);   // seconds — per-fingerprint 429 backoff (10 min)

function storePath($name) { return STORE_DIR . $name; }
function cacheFile($u)    { return storePath('ig_count_' . preg_replace('/[^a-z0-9._]/', '_', $u) . '.json'); }

function readCache($u) {
    $r = @file_get_contents(cacheFile($u));
    return $r ? json_decode($r, true) : null;
}
function writeCache($u, $d) {
    // Atomic write: write to temp file then rename (avoids partial reads)
    $tmp = cacheFile($u) . '.tmp.' . getmypid();
    if (@file_put_contents($tmp, json_encode($d), LOCK_EX) !== false) {
        @rename($tmp, cacheFile($u));
    }
}
function isCacheFresh($u) {
    $f = cacheFile($u);
    return @file_exists($f) && (time() - @filemtime($f)) < CACHE_TTL;
}

// ── Browser fingerprint pool ──────────────────────────────────────────────────
$FINGERPRINTS = [
    [
        'id'       => 'chrome124_win',
        'ua'       => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'sec_ua'   => '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'platform' => '"Windows"',
        'mobile'   => '?0',
        'lang'     => 'en-US,en;q=0.9',
    ],
    [
        'id'       => 'chrome123_mac',
        'ua'       => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'sec_ua'   => '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        'platform' => '"macOS"',
        'mobile'   => '?0',
        'lang'     => 'en-GB,en;q=0.9',
    ],
    [
        'id'       => 'firefox125_win',
        'ua'       => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
        'sec_ua'   => '',
        'platform' => '"Windows"',
        'mobile'   => '?0',
        'lang'     => 'en-US,en;q=0.5',
    ],
    [
        'id'       => 'safari17_mac',
        'ua'       => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        'sec_ua'   => '',
        'platform' => '"macOS"',
        'mobile'   => '?0',
        'lang'     => 'en-US,en;q=0.9',
    ],
    [
        'id'       => 'chrome124_android',
        'ua'       => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
        'sec_ua'   => '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'platform' => '"Android"',
        'mobile'   => '?1',
        'lang'     => 'en-US,en;q=0.9',
    ],
    [
        'id'       => 'edge124_win',
        'ua'       => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
        'sec_ua'   => '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
        'platform' => '"Windows"',
        'mobile'   => '?0',
        'lang'     => 'en-US,en;q=0.9,en-GB;q=0.8',
    ],
];

// Per-fingerprint file helpers
function fpCookieJar($fp)  { return storePath('ig_jar_'  . $fp['id'] . '.cookies'); }
function fpSessionAge($fp) { return storePath('ig_sess_' . $fp['id'] . '.age');     }
function fpRateLimit($fp)  { return storePath('ig_rl_'   . $fp['id'] . '.txt');     }

function isFpSessionFresh($fp) {
    $f = fpSessionAge($fp);
    return @file_exists($f) && (time() - @filemtime($f)) < SESSION_TTL;
}
function touchFpSession($fp) {
    @file_put_contents(fpSessionAge($fp), time(), LOCK_EX);
}
function isFpRateLimited($fp) {
    $f = fpRateLimit($fp);
    return @file_exists($f) && (int)@file_get_contents($f) > time();
}
function setFpRateLimit($fp) {
    @file_put_contents(fpRateLimit($fp), time() + BACKOFF_TTL, LOCK_EX);
}
function clearFpSession($fp) {
    @unlink(fpSessionAge($fp));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function respond($data) {
    ob_end_clean();
    echo json_encode($data);
    exit;
}

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
 * Detect abbreviated/rounded follower counts from og:description.
 * e.g. 101000000 (101M), 5800000 (5.8M), 250000 (250K).
 * A real precise count like 101025769 is NOT divisible by 1000.
 */
function isAbbreviatedCount($n) {
    if ($n === null || $n < 1000) return false;
    if ($n % 1000000 === 0) return true;   // exact M
    if ($n % 100000  === 0) return true;   // rounded M (5.8M → 5800000)
    if ($n > 100000 && $n % 1000 === 0) return true; // K abbreviation
    return false;
}

// ── cURL helper — Hostinger-safe ──────────────────────────────────────────────
function curlFetch($url, $fp, $extraHeaders = []) {
    $baseHeaders = [
        'Accept-Language: ' . $fp['lang'],
        'Accept-Encoding: identity',
        'Cache-Control: no-cache',
        'Pragma: no-cache',
        'Upgrade-Insecure-Requests: 1',
    ];
    if ($fp['sec_ua'] !== '') {
        $baseHeaders[] = 'sec-ch-ua: '          . $fp['sec_ua'];
        $baseHeaders[] = 'sec-ch-ua-mobile: '   . $fp['mobile'];
        $baseHeaders[] = 'sec-ch-ua-platform: ' . $fp['platform'];
    }

    $headers = array_merge($baseHeaders, $extraHeaders);
    $jar     = fpCookieJar($fp);

    $ch = curl_init();

    // ── SSL: try peer verification first; fall back gracefully on Hostinger ──
    // Hostinger bundles a CA cert at the standard path. If it's missing,
    // we disable peer verification (still encrypted, just not verified).
    $caBundle = '';
    foreach ([
        '/etc/ssl/certs/ca-certificates.crt',   // Debian/Ubuntu
        '/etc/pki/tls/certs/ca-bundle.crt',     // CentOS/RHEL
        '/etc/ssl/ca-bundle.pem',               // OpenSUSE
        '/usr/local/share/certs/ca-root-nss.crt', // FreeBSD
    ] as $path) {
        if (@file_exists($path)) { $caBundle = $path; break; }
    }

    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 6,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_USERAGENT      => $fp['ua'],
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_SSL_VERIFYPEER => ($caBundle !== ''),
        CURLOPT_SSL_VERIFYHOST => ($caBundle !== '') ? 2 : 0,
        CURLOPT_ENCODING       => 'identity',
        CURLOPT_COOKIEFILE     => $jar,
        CURLOPT_COOKIEJAR      => $jar,
        CURLOPT_TCP_KEEPALIVE  => 0,
        CURLOPT_FORBID_REUSE   => 1,
    ]);
    if ($caBundle !== '') {
        curl_setopt($ch, CURLOPT_CAINFO, $caBundle);
    }

    $raw     = curl_exec($ch);
    $code    = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hdrSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $errno   = curl_errno($ch);
    curl_close($ch);

    if ($raw === false || $errno) return null;
    return ['code' => $code, 'body' => substr($raw, $hdrSize)];
}

// ── Strategy A: web_profile_info (exact count) ────────────────────────────────
function tryWebProfileInfo($username, $fp) {
    if (isFpRateLimited($fp)) return null;

    // Bootstrap session if stale
    if (!isFpSessionFresh($fp)) {
        curlFetch('https://www.instagram.com/', $fp, [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest: document',
            'Sec-Fetch-Mode: navigate',
            'Sec-Fetch-Site: none',
        ]);
        curlFetch('https://www.instagram.com/' . rawurlencode($username) . '/', $fp, [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest: document',
            'Sec-Fetch-Mode: navigate',
            'Sec-Fetch-Site: same-origin',
        ]);
        touchFpSession($fp);
    }

    // Extract csrftoken from Netscape cookie jar file
    $csrfToken  = '';
    $jarContent = @file_get_contents(fpCookieJar($fp));
    if ($jarContent && preg_match('/\bcsrftoken\s+(\S+)/i', $jarContent, $cm)) {
        $csrfToken = trim($cm[1]);
    }

    $url  = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=' . rawurlencode($username);
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

    if ($resp['code'] === 429) { setFpRateLimit($fp); return null; }
    if ($resp['code'] === 401 || $resp['code'] === 403) { clearFpSession($fp); return null; }
    if ($resp['code'] === 404) return ['count' => null, 'source' => 'not_found'];
    if ($resp['code'] !== 200) return null;

    $json = @json_decode($resp['body'], true);
    $user = $json['data']['user'] ?? null;
    if (!$user) return null;

    $count = $user['edge_followed_by']['count'] ?? $user['follower_count'] ?? null;
    if ($count !== null) {
        return ['count' => (int)$count, 'source' => 'web_profile_info', 'approximate' => false];
    }
    return null;
}

// ── Strategy B: i.instagram.com mobile API (exact count) ─────────────────────
function tryMobileApi($username, $fp) {
    if (isFpRateLimited($fp)) return null;

    $url  = 'https://i.instagram.com/api/v1/users/web_profile_info/?username=' . rawurlencode($username);
    $resp = curlFetch($url, $fp, [
        'Accept: */*',
        'X-IG-App-ID: 936619743392459',
        'Sec-Fetch-Site: same-origin',
        'Sec-Fetch-Mode: cors',
        'Sec-Fetch-Dest: empty',
    ]);

    if (!$resp) return null;
    if ($resp['code'] === 429) { setFpRateLimit($fp); return null; }
    if ($resp['code'] !== 200) return null;

    $json = @json_decode($resp['body'], true);
    $user = $json['data']['user'] ?? null;
    if (!$user) return null;

    $count = $user['edge_followed_by']['count'] ?? $user['follower_count'] ?? null;
    if ($count !== null) {
        return ['count' => (int)$count, 'source' => 'mobile_api', 'approximate' => false];
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

    // Not-found detection
    if (strpos($html, 'page_not_found') !== false || strpos($html, 'PageNotFound') !== false) {
        return ['count' => null, 'source' => 'not_found'];
    }

    // Login-wall detection — invalidate session
    if (strpos($html, 'loginForm') !== false
        || strpos($html, '"login"') !== false
        || strpos($html, 'accounts/login') !== false) {
        clearFpSession($fp);
    }

    return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
try {
    $username = isset($_GET['username']) ? strtolower(trim($_GET['username'])) : '';
    if (!preg_match('/^[a-z0-9._]{1,30}$/', $username)) {
        ob_end_clean();
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => ['message' => 'Invalid Instagram username format.']]);
        exit;
    }

    // ── 1. Serve fresh cache (handles the 8-second browser poll cheaply) ─────
    if (isCacheFresh($username)) {
        respond(readCache($username));
    }

    $staleCache = readCache($username);

    // Extract last known precise count from stale cache
    $lastPreciseCount = null;
    if ($staleCache && isset($staleCache['data']['followerCount'])) {
        $cached = $staleCache['data']['followerCount'];
        if ($cached !== null && !isAbbreviatedCount($cached)) {
            $lastPreciseCount = $cached;
        }
    }

    // ── 2. Pick a non-rate-limited fingerprint ────────────────────────────────
    global $FINGERPRINTS;
    $available = array_values(array_filter($FINGERPRINTS, function($fp) {
        return !isFpRateLimited($fp);
    }));

    if (empty($available)) {
        serveStaleOrError($staleCache, $username,
            'Instagram is rate-limiting all sessions. Displaying last known count.');
    }

    // Rotate by minute — same identity within a minute, different each minute
    $fp    = $available[(int)date('i') % count($available)];
    $altFp = count($available) > 1
           ? $available[((int)date('i') + 1) % count($available)]
           : $fp;

    // ── 3. Try strategies in precision order ──────────────────────────────────
    $result = tryWebProfileInfo($username, $fp);

    if (!$result || $result['count'] === null && ($result['source'] ?? '') !== 'not_found') {
        $result = tryMobileApi($username, $altFp);
    }

    if (!$result || $result['count'] === null && ($result['source'] ?? '') !== 'not_found') {
        $result = tryProfileHtml($username, $fp);
    }

    // ── 4. Handle not-found ───────────────────────────────────────────────────
    if ($result && ($result['source'] ?? '') === 'not_found') {
        respond(['success' => true, 'data' => [
            'username'      => $username,
            'followerCount' => null,
            'status'        => 'not_found',
            'message'       => 'Instagram account not found.',
            'dataSource'    => 'profile_html',
        ]]);
    }

    // ── 5. Got a count — apply the KEY FIX ───────────────────────────────────
    if ($result && $result['count'] !== null) {
        $newCount = $result['count'];
        $isApprox = $result['approximate'] ?? false;

        // If we got an abbreviated count AND have a precise cached value within
        // 5% → serve the precise value (prevents 101,025,769 → 101,000,000).
        if ($isApprox && $lastPreciseCount !== null) {
            $ratio = abs($newCount - $lastPreciseCount) / max($lastPreciseCount, 1);
            if ($ratio < 0.05) {
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

    // ── 6. Nothing worked — serve stale or error ──────────────────────────────
    serveStaleOrError($staleCache, $username,
        'Could not extract follower count. Instagram may require a login.');

} catch (Throwable $e) {
    ob_end_clean();
    echo json_encode(['success' => false, 'error' => ['message' => 'Server error: ' . $e->getMessage()]]);
}
