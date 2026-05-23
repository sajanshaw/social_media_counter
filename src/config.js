// ─── Polling / refresh configuration ─────────────────────────────────────
// Modify these values to control how often follower counts are refreshed.
// All intervals are in milliseconds.

const config = {
  // Instagram live polling interval (default: 20 seconds)
  INSTAGRAM_POLL_INTERVAL_MS: 30_000,

  // YouTube live polling interval (default: 60 seconds)
  YOUTUBE_POLL_INTERVAL_MS: 60_000,

  // Demo mode simulated tick interval (default: 5 seconds)
  DEMO_TICK_INTERVAL_MS: 5_000,
};

export default config;
