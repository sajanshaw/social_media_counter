// ─── Polling / refresh configuration ─────────────────────────────────────
// Modify these values to control how often follower counts are refreshed.
// All intervals are in milliseconds.
//
// NOTE: The PHP proxy (public/api/instagram.php) has a server-side cache of
// 25 seconds. Polling faster than that is safe — the server returns the cached
// value instantly without hitting Instagram again. The browser can poll every
// 8 seconds and the server will only make a real Instagram request every ~25s.

const config = {
  // Instagram live polling interval — 8 seconds feels real-time on screen.
  // The server-side cache (25 s) ensures Instagram is not hammered.
  INSTAGRAM_POLL_INTERVAL_MS: 8_000,

  // YouTube live polling interval (YouTube API quota: keep ≥ 30 s)
  YOUTUBE_POLL_INTERVAL_MS: 30_000,

  // Demo mode simulated tick interval
  DEMO_TICK_INTERVAL_MS: 5_000,
};

export default config;
