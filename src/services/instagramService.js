/**
 * Client-side service to call the Instagram lookup proxy.
 * The proxy runs in the CRA dev server (src/setupProxy.js) and handles
 * server-side requests to Instagram, avoiding CORS issues.
 */

export async function fetchInstagramFollowers(username) {
  const cleanUsername = username.replace(/^@/, '').toLowerCase().trim();

  // Development: CRA dev server proxy (setupProxy.js handles the request server-side)
  // Production:  PHP proxy deployed alongside the build (public/api/instagram.php)
  const url = process.env.NODE_ENV === 'production'
    ? `/api/instagram.php?username=${encodeURIComponent(cleanUsername)}`
    : `/api/instagram/lookup/${encodeURIComponent(cleanUsername)}`;

  const res = await fetch(url);

  if (res.status === 429) {
    throw new Error('Rate limit exceeded. Please wait a moment and try again.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.success) {
    throw new Error(data.error?.message || 'Failed to lookup username.');
  }

  return data.data;
}
