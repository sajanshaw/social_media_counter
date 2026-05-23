import { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom';
import DisplayManager from './components/DisplayManager';
import SetupPage from './components/SetupPage';
import config from './config';
import { fetchInstagramFollowers } from './services/instagramService';
import './App.css';

const DEMO_INITIAL = 12847;
const DEMO_GROWTH_INITIAL = 42;

// ─────────────────────────────────────────────────────────────────────────────
// Daily growth helpers
//
// "Today's growth" = net change in follower count since midnight on the
// device's local date. Persisted in localStorage so a page refresh doesn't
// reset it. Resets automatically when the device date changes.
//
// Storage key format:  ig_growth_<username>
// Value format:        { date: "2026-05-23", baseline: 101025769, growth: 42 }
//
// Rules:
//   • On first load of the day  → baseline = current count, growth = 0
//   • count > baseline          → growth += (count - baseline); baseline = count
//   • count < baseline          → follower loss; growth stays (don't subtract),
//                                  baseline = count  (so next gain is measured
//                                  from the new lower value)
//   • New calendar day          → reset: baseline = count, growth = 0
// ─────────────────────────────────────────────────────────────────────────────

function todayDateString() {
  // Uses the device's local timezone (e.g. Asia/Calcutta)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function growthKey(username) {
  return `ig_growth_${username.toLowerCase().replace(/[^a-z0-9._]/g, '_')}`;
}

/**
 * Load persisted growth state for a username.
 * Returns { date, baseline, growth } or null if nothing stored.
 */
function loadGrowthState(username) {
  try {
    const raw = localStorage.getItem(growthKey(username));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.date && parsed.baseline != null && parsed.growth != null) {
      return parsed;
    }
  } catch (_) {}
  return null;
}

/**
 * Persist growth state.
 */
function saveGrowthState(username, state) {
  try {
    localStorage.setItem(growthKey(username), JSON.stringify(state));
  } catch (_) {}
}

/**
 * Given the current follower count and the persisted state, return the
 * updated { growth, baseline, date } and whether the state changed.
 *
 * @param {number} currentCount  - fresh follower count from API
 * @param {string} username
 * @returns {{ growth: number, baseline: number, date: string }}
 */
function computeGrowth(currentCount, username) {
  const today = todayDateString();
  const stored = loadGrowthState(username);

  // No stored state, or new day → reset
  if (!stored || stored.date !== today) {
    const newState = { date: today, baseline: currentCount, growth: 0 };
    saveGrowthState(username, newState);
    return newState;
  }

  let { baseline, growth } = stored;

  if (currentCount > baseline) {
    // Gained followers
    growth += currentCount - baseline;
    baseline = currentCount;
  } else if (currentCount < baseline) {
    // Lost followers — don't subtract from growth (growth = net gains only)
    // but update baseline so future gains are measured from here
    baseline = currentCount;
  }
  // currentCount === baseline → no change

  const newState = { date: today, baseline, growth };
  saveGrowthState(username, newState);
  return newState;
}

// ─────────────────────────────────────────────────────────────────────────────

async function fetchYouTubeSubscribers(handle, apiKey) {
  const cleanHandle = handle.replace(/^@/, '');
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=%40${encodeURIComponent(cleanHandle)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.items?.length) throw new Error('Channel not found');
  return parseInt(data.items[0].statistics.subscriberCount, 10) || 0;
}

function requestKioskFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) return Promise.resolve();
  const p = el.requestFullscreen
    ? el.requestFullscreen({ navigationUI: 'hide' })
    : el.webkitRequestFullscreen
    ? el.webkitRequestFullscreen()
    : Promise.resolve();
  return p ? p.catch(() => {}) : Promise.resolve();
}

/* ── Kiosk splash ─────────────────────────────────────────────────────────── */
const SPLASH_PLATFORMS = [
  {
    label: 'YouTube',
    gradient: 'linear-gradient(135deg, #FF0000, #b30000)',
    glow: 'rgba(255,0,0,0.45)',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width={32} height={32} viewBox="0 0 576 512" fill="#fff">
        <path d="M549.7 124.1c-6.3-23.7-24.8-42.3-48.3-48.6C458.8 64 288 64 288 64S117.2 64 74.6 75.5c-23.5 6.3-42 24.9-48.3 48.6-11.4 42.9-11.4 132.3-11.4 132.3s0 89.4 11.4 132.3c6.3 23.7 24.8 41.5 48.3 47.8C117.2 448 288 448 288 448s170.8 0 213.4-11.5c23.5-6.3 42-24.2 48.3-47.8 11.4-42.9 11.4-132.3 11.4-132.3s0-89.4-11.4-132.3zm-317.5 213.5V175.2l142.7 81.2z"/>
      </svg>
    ),
  },
  {
    label: 'Instagram',
    gradient: 'linear-gradient(135deg, #833AB4, #E1306C, #F77737)',
    glow: 'rgba(225,48,108,0.55)',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width={32} height={32} viewBox="0 0 448 512" fill="#fff">
        <path d="M224.1 141c-63.6 0-114.9 51.3-114.9 114.9S160.5 370.8 224.1 370.8 339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.6-74.7-74.7s33.6-74.7 74.7-74.7 74.7 33.6 74.7 74.7-33.5 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.9-26.9 26.9s-26.9-12-26.9-26.9 12-26.9 26.9-26.9 26.9 12 26.9 26.9zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1S4.4 127.5 2.6 163.4c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z"/>
      </svg>
    ),
  },
  {
    label: 'TikTok',
    gradient: 'linear-gradient(135deg, #010101, #69C9D0)',
    glow: 'rgba(105,201,208,0.4)',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width={30} height={30} viewBox="0 0 448 512" fill="#fff">
        <path d="M448 209.9a210.1 210.1 0 01-122.8-39.3v178.8A162.6 162.6 0 11185 188.3v89.9a74.6 74.6 0 1052.2 71.2V0h88a121 121 0 00122.8 121.2z"/>
      </svg>
    ),
  },
  {
    label: 'Twitter',
    gradient: 'linear-gradient(135deg, #1d9bf0, #0d6ebc)',
    glow: 'rgba(29,155,240,0.4)',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width={30} height={30} viewBox="0 0 512 512" fill="#fff">
        <path d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z"/>
      </svg>
    ),
  },
];

function KioskSplash({ visible, onStart }) {
  return (
    <div
      onClick={visible ? () => onStart(0) : undefined}
      onTouchEnd={visible ? (e) => { e.preventDefault(); onStart(0); } : undefined}
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        width: '100%', height: '100%',
        zIndex: 9999,
        background: 'linear-gradient(160deg, #08080f 0%, #10101c 60%, #0b0b14 100%)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 0.4s ease',
        overflow: 'hidden',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0, width: '100%' }}>
        <div style={{ display: 'flex', gap: 20, marginBottom: 40, flexWrap: 'wrap', justifyContent: 'center', padding: '0 16px' }}>
          {SPLASH_PLATFORMS.map((p, i) => (
            <div
              key={p.label}
              onClick={(e) => { e.stopPropagation(); onStart(i); }}
              onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); onStart(i); }}
              style={{
                width: 72, height: 72, borderRadius: 20,
                background: p.gradient,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 0 32px ${p.glow}`,
                cursor: 'pointer',
              }}>
              {p.icon}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px', marginBottom: 14, textAlign: 'center' }}>
          Follower Counter
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', letterSpacing: 4, textTransform: 'uppercase', textAlign: 'center' }}>
          Tap anywhere to start
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App — demo / YouTube / non-Instagram live mode
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const [kioskReady, setKioskReady] = useState(false);
  const [initialPlatformIndex, setInitialPlatformIndex] = useState(0);
  const [session, setSession] = useState(null);
  const [followers, setFollowers] = useState(DEMO_INITIAL);
  const [todayGrowth, setTodayGrowth] = useState(DEMO_GROWTH_INITIAL);

  // Lock scroll + re-enter fullscreen when keyboard closes
  useEffect(() => {
    if (!kioskReady) return;
    const vv = window.visualViewport;
    let fullHeight = window.innerHeight;
    let keyboardOpen = false;
    let reenterTimer = null;
    const lock = () => { window.scrollTo(0, 0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0; };
    const onResize = () => {
      lock();
      if (!vv) return;
      const currentHeight = vv.height;
      const wasOpen = keyboardOpen;
      keyboardOpen = currentHeight < fullHeight - 150;
      if (!keyboardOpen) fullHeight = Math.max(fullHeight, currentHeight);
      if (wasOpen && !keyboardOpen) {
        clearTimeout(reenterTimer);
        reenterTimer = setTimeout(() => {
          if (!document.fullscreenElement && !document.webkitFullscreenElement) requestKioskFullscreen();
        }, 400);
      }
    };
    lock();
    if (vv) { vv.addEventListener('resize', onResize); vv.addEventListener('scroll', lock); }
    return () => { clearTimeout(reenterTimer); if (vv) { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', lock); } };
  }, [kioskReady]);

  const handleStart = useCallback((platformIndex = 0) => {
    setInitialPlatformIndex(platformIndex);
    requestKioskFullscreen();
    setTimeout(() => setKioskReady(true), 200);
  }, []);

  const handleConnect = useCallback((info) => {
    setSession(info);
    if (info.followers != null) {
      setFollowers(info.followers);
      setTodayGrowth(0);
    } else {
      setFollowers(DEMO_INITIAL);
      setTodayGrowth(DEMO_GROWTH_INITIAL);
    }
    requestKioskFullscreen();
  }, []);

  // Live refresh (YouTube) or demo tick
  useEffect(() => {
    if (!session) return;

    if (session.isLive) {
      const interval = config.YOUTUBE_POLL_INTERVAL_MS;
      const id = setInterval(async () => {
        try {
          const fresh = await fetchYouTubeSubscribers(session.handle, session.apiKey);
          if (fresh != null) {
            setFollowers(prev => {
              const diff = fresh - prev;
              if (diff > 0) setTodayGrowth(g => g + diff);
              // Note: decrement does NOT reduce todayGrowth
              return fresh;
            });
          }
        } catch (_) {}
      }, interval);
      return () => clearInterval(id);
    } else {
      // Demo mode
      const id = setInterval(() => {
        const inc = Math.floor(Math.random() * 3) + 1;
        setFollowers(p => p + inc);
        setTodayGrowth(p => p + inc);
      }, config.DEMO_TICK_INTERVAL_MS);
      return () => clearInterval(id);
    }
  }, [session]);

  return (
    <>
      {!session ? (
        <SetupPage onConnect={handleConnect} initialPlatformIndex={initialPlatformIndex} />
      ) : (
        <DisplayManager
          followers={followers}
          todayGrowth={todayGrowth}
          username={session.displayName || session.handle}
        />
      )}
      <KioskSplash visible={!kioskReady} onStart={handleStart} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InstagramPage — /instagram/:username
//
// Growth logic:
//   • todayGrowth = net follower gains since midnight (device local time)
//   • Persisted in localStorage — survives page refresh
//   • Resets automatically at midnight (new calendar date)
//   • Decrements in follower count do NOT reduce todayGrowth
//   • If the API returns an abbreviated/rounded count (same as last precise),
//     the display stays at the last precise value (handled by proxy)
// ─────────────────────────────────────────────────────────────────────────────

function InstagramPage() {
  const { username } = useParams();
  const navigate = useNavigate();

  const [followers, setFollowers] = useState(null);
  const [todayGrowth, setTodayGrowth] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [kioskReady, setKioskReady] = useState(false);

  // Track the last date we saw — used to detect midnight rollover
  const lastDateRef = useRef(todayDateString());

  // On mount: restore persisted growth state for today
  useEffect(() => {
    if (!username) return;
    const stored = loadGrowthState(username);
    const today  = todayDateString();
    if (stored && stored.date === today) {
      setTodayGrowth(stored.growth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  useEffect(() => {
    if (!username) return;

    let isMounted = true;

    const doFetch = async () => {
      try {
        const result = await fetchInstagramFollowers(username);
        if (!isMounted) return;

        if (result.status === 'found' || result.status === 'success') {
          const freshCount = result.followerCount;

          // ── Midnight rollover check ──────────────────────────────────────
          const today = todayDateString();
          if (today !== lastDateRef.current) {
            // New day — reset growth baseline
            lastDateRef.current = today;
            const newState = { date: today, baseline: freshCount, growth: 0 };
            saveGrowthState(username, newState);
            setFollowers(freshCount);
            setTodayGrowth(0);
            setError('');
            return;
          }

          // ── Normal update ────────────────────────────────────────────────
          const { growth } = computeGrowth(freshCount, username);
          setFollowers(freshCount);
          setTodayGrowth(growth);
          setError('');

        } else if (result.status === 'not_found') {
          setError(`@${username} not found.`);
        } else {
          // Unavailable / rate-limited — keep last known count, no error shown
          // if we already have a value
          if (followers == null) setError(result.message || 'Could not load follower count.');
        }
      } catch (e) {
        if (isMounted && followers == null) setError('Failed to reach Instagram.');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    doFetch();
    const id = setInterval(doFetch, config.INSTAGRAM_POLL_INTERVAL_MS);
    return () => { isMounted = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const handleTap = useCallback(() => {
    if (!kioskReady) { requestKioskFullscreen(); setKioskReady(true); }
  }, [kioskReady]);

  if (loading) {
    return (
      <div onClick={handleTap} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100dvh', background: '#0a0a0a', color: '#fff', fontSize: 20, fontFamily: 'sans-serif' }}>
        Loading @{username}…
      </div>
    );
  }

  if (error && followers == null) {
    return (
      <div onClick={handleTap} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, height: '100dvh', background: '#0a0a0a',
        color: '#fff', fontSize: 18, fontFamily: 'sans-serif', padding: 24, textAlign: 'center' }}>
        <span>{error}</span>
        <button onClick={() => navigate('/')}
          style={{ marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
            background: 'linear-gradient(135deg,#833AB4,#E1306C)', color: '#fff', fontSize: 16, cursor: 'pointer' }}>
          ← Back to Setup
        </button>
      </div>
    );
  }

  return (
    <div onClick={handleTap}>
      <DisplayManager
        followers={followers ?? 0}
        todayGrowth={todayGrowth}
        username={username}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTubePage — /youtube/:username
// ─────────────────────────────────────────────────────────────────────────────

function YouTubePage() {
  const { username } = useParams();
  const navigate = useNavigate();
  const apiKey = localStorage.getItem('yt_api_key') || '';
  const channelTitle = localStorage.getItem('yt_channel_title') || username;
  const [subscribers, setSubscribers] = useState(null);
  const [todayGrowth, setTodayGrowth] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [kioskReady, setKioskReady] = useState(false);

  // Restore persisted YouTube growth state
  useEffect(() => {
    if (!username) return;
    const stored = loadGrowthState('yt_' + username);
    const today  = todayDateString();
    if (stored && stored.date === today) {
      setTodayGrowth(stored.growth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const lastDateRef = useRef(todayDateString());

  useEffect(() => {
    if (!username || !apiKey) { setLoading(false); return; }
    let isMounted = true;

    const doFetch = async () => {
      try {
        const count = await fetchYouTubeSubscribers(username, apiKey);
        if (!isMounted) return;

        const today = todayDateString();
        if (today !== lastDateRef.current) {
          lastDateRef.current = today;
          const newState = { date: today, baseline: count, growth: 0 };
          saveGrowthState('yt_' + username, newState);
          setSubscribers(count);
          setTodayGrowth(0);
          setError('');
          return;
        }

        const { growth } = computeGrowth(count, 'yt_' + username);
        setSubscribers(count);
        setTodayGrowth(growth);
        setError('');
      } catch (e) {
        if (isMounted) {
          setSubscribers(prev => {
            if (prev == null) setError(e.message || 'Failed to fetch subscriber count.');
            return prev;
          });
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    doFetch();
    const id = setInterval(doFetch, config.YOUTUBE_POLL_INTERVAL_MS);
    return () => { isMounted = false; clearInterval(id); };
  }, [username, apiKey]);

  const handleTap = useCallback(() => {
    if (!kioskReady) { requestKioskFullscreen(); setKioskReady(true); }
  }, [kioskReady]);

  if (!apiKey) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 16, height: '100dvh', background: '#0a0a0a', color: '#fff', fontSize: 18,
        fontFamily: 'sans-serif', padding: 24, textAlign: 'center' }}>
        <span>No YouTube API key found. Please connect your YouTube account first.</span>
        <button onClick={() => navigate('/')}
          style={{ marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
            background: 'linear-gradient(135deg,#FF0000,#b30000)', color: '#fff', fontSize: 16, cursor: 'pointer' }}>
          ← Back to Setup
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div onClick={handleTap} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100dvh', background: '#0a0a0a', color: '#fff', fontSize: 20, fontFamily: 'sans-serif' }}>
        Loading @{username}…
      </div>
    );
  }

  if (error && subscribers == null) {
    return (
      <div onClick={handleTap} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, height: '100dvh', background: '#0a0a0a',
        color: '#fff', fontSize: 18, fontFamily: 'sans-serif', padding: 24, textAlign: 'center' }}>
        <span>{error}</span>
        <button onClick={() => navigate('/')}
          style={{ marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
            background: 'linear-gradient(135deg,#FF0000,#b30000)', color: '#fff', fontSize: 16, cursor: 'pointer' }}>
          ← Back to Setup
        </button>
      </div>
    );
  }

  return (
    <div onClick={handleTap}>
      <DisplayManager
        followers={subscribers ?? 0}
        todayGrowth={todayGrowth}
        username={channelTitle}
      />
    </div>
  );
}

// ── Root with router ──────────────────────────────────────────────────────────
function Root() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/instagram/:username" element={<InstagramPage />} />
        <Route path="/youtube/:username"   element={<YouTubePage />} />
        <Route path="*"                    element={<App />} />
      </Routes>
    </BrowserRouter>
  );
}

export default Root;
