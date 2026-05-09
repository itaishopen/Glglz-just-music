'use strict';

const axios  = require('axios');
const config = require('./config');
const logger = require('./logger');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE  = 'https://api.spotify.com/v1';

// Cached access token state
let _accessToken   = null;
let _tokenExpiresAt = 0;

// ── Token management ──────────────────────────────────────────────────────────

async function getAccessToken() {
  // Refresh 60 s before actual expiry to avoid using a stale token mid-request.
  if (_accessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _accessToken;
  }

  logger.debug('[spotify] Refreshing access token');

  const credentials = Buffer.from(
    `${config.spotify.clientId}:${config.spotify.clientSecret}`
  ).toString('base64');

  let response;
  try {
    response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: config.spotify.refreshToken,
      }),
      {
        headers: {
          Authorization:  `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10_000,
      }
    );
  } catch (err) {
    const body = err.response?.data;
    if (body?.error === 'invalid_grant') {
      throw new Error(
        'Spotify refresh token is invalid or expired.\n' +
        '  → Run  node scripts/get-token.js  on your laptop to get a new token,\n' +
        '    then update SPOTIFY_REFRESH_TOKEN in your .env file on the Pi.'
      );
    }
    throw err;
  }

  _accessToken    = response.data.access_token;
  _tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  logger.info(`[spotify] Token scopes granted: ${response.data.scope || '(none returned)'}`);

  // Spotify occasionally rotates refresh tokens. Use the new one in-memory so
  // subsequent refreshes succeed, and warn the operator to persist it.
  if (response.data.refresh_token && response.data.refresh_token !== config.spotify.refreshToken) {
    config.spotify.refreshToken = response.data.refresh_token;
    logger.warn('[spotify] Spotify issued a new refresh token — update SPOTIFY_REFRESH_TOKEN in .env:');
    logger.warn(`[spotify]   SPOTIFY_REFRESH_TOKEN=${response.data.refresh_token}`);
  }

  return _accessToken;
}

// ── Generic API request with retry ───────────────────────────────────────────

/**
 * Make an authenticated Spotify API request.
 * Handles 401 (force token refresh + retry) and 429 (rate limit back-off).
 * @param {string} method  HTTP method
 * @param {string} url     Full URL or path relative to API_BASE
 * @param {object} [data]  Request body (JSON)
 * @param {number} [maxRetries]
 */
async function apiRequest(method, url, data = null, maxRetries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const token    = await getAccessToken();
      const isWrite = /^(POST|PUT|DELETE|PATCH)$/i.test(method);
      const response = await axios({
        method,
        url: fullUrl,
        ...(isWrite ? { data } : {}),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(isWrite ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 15_000,
      });
      return response.data;
    } catch (err) {
      if (err.response) {
        const { status, headers, data: body } = err.response;

        if (status === 401) {
          // Token was rejected — force a refresh on the next attempt.
          _accessToken    = null;
          _tokenExpiresAt = 0;
          if (attempt < maxRetries) {
            logger.debug('[spotify] 401 received, forcing token refresh and retrying');
            continue;
          }
        }

        if (status === 403) {
          logger.error(`[spotify] 403 raw body: ${JSON.stringify(body)}`);
          throw new Error(
            `Spotify API 403 Forbidden on ${method} ${url}: ${JSON.stringify(body)}`
          );
        }

        if (status === 429) {
          const retryAfter = parseInt(headers['retry-after'] || '10', 10);
          const MAX_RETRY_WAIT = 60;
          if (retryAfter > MAX_RETRY_WAIT) {
            throw new Error(
              `Spotify rate limited — Retry-After ${retryAfter}s is too long to wait. Will retry next cycle.`
            );
          }
          logger.warn(`[spotify] Rate limited (429). Waiting ${retryAfter}s before retry ${attempt}/${maxRetries}`);
          await sleep(retryAfter * 1000);
          if (attempt < maxRetries) continue;
        }

        throw new Error(
          `Spotify API error ${status} on ${method} ${url}: ` +
          JSON.stringify(body)
        );
      }

      // Network / timeout error — exponential back-off
      if (attempt < maxRetries) {
        const delay = 2 ** attempt * 1000;
        logger.warn(`[spotify] Request failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${err.message}`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Search Spotify for a song.
 *
 * Matching strategy:
 *   1. If the raw string contains " - ", split into artist / title and use
 *      Spotify's field filter: `<title> artist:<artist>` — this is highly
 *      precise and avoids false positives from similarly-named tracks.
 *   2. If that returns nothing (or a 400), fall back to a plain keyword query.
 *   3. Among up to 5 results, score each track on title similarity, artist
 *      similarity, and popularity, then return the highest scorer.
 *
 * @param {string} query  Raw song string from the radio site, e.g. "Wu Lyf - Love Your Fate"
 * @returns {{ uri, id, name, artists, popularity } | null}
 */
async function searchTrack(query) {
  logger.debug(`[spotify] Searching for: "${query}"`);

  const dash = query.indexOf(' - ');
  let primaryQuery;

  // Strip only specific invisible/control chars that cause Spotify 400 errors:
  // U+0000-001F (ASCII ctrl), U+200B-200F (ZWS/ZWJ/LRM/RLM),
  // U+202A-202E (directional marks), U+FEFF (BOM).
  // Hebrew, Arabic, and all other visible scripts are kept intact so
  // non-Latin songs can be searched on Spotify.
  const stripOps = (s) => s
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/,/g, ' ')
    .replace(/['"()\[\]{}!?:]/g, '')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (dash > 0) {
    const artist = query.slice(0, dash).trim();
    const title  = query.slice(dash + 3).trim();
    // Spotify's artist: filter accepts only a single artist name.
    // Split on comma, ampersand, slash, or "feat." and take the first one.
    const primaryArtist = artist.split(/\s*[,&\/]\s*|\s+feat\.?\s+/i)[0].trim();
    const cleanTitle  = stripOps(title);
    const cleanArtist = stripOps(primaryArtist);
    if (!cleanTitle) {
      logger.debug(`[spotify] Skipping — title is empty after sanitising (non-Latin script?): "${query}"`);
      return null;
    }
    primaryQuery = `${cleanTitle} artist:${cleanArtist}`;
    logger.debug(`[spotify] Parsed → artist="${artist}", cleanArtist="${cleanArtist}", title="${title}", cleanTitle="${cleanTitle}"`);
  } else {
    primaryQuery = stripOps(query);
    if (!primaryQuery) {
      logger.debug(`[spotify] Skipping — query is empty after sanitising: "${query}"`);
      return null;
    }
  }

  // Attempt field-filter query; if Spotify rejects it (400) fall straight
  // through to the plain-query fallback rather than surfacing an error.
  let data = null;
  try {
    data = await apiRequest(
      'GET',
      `/search?q=${encodeURIComponent(primaryQuery)}&type=track&limit=5&market=IL`
    );
  } catch (err) {
    if (err.message.includes('400')) {
      logger.warn(`[spotify] Field-filter query returned 400, falling back to plain query. Query was: "${primaryQuery}"`);
    } else {
      throw err;
    }
  }

  if (data?.tracks?.items?.length) {
    return pickBestMatch(data.tracks.items, query);
  }

  // Fallback: plain keyword query — title + first artist, all operators stripped.
  // Using cleanTitle+cleanArtist (already computed above) avoids commas, hyphens,
  // and multi-artist separators that cause 400s on the raw string.
  const plainQuery = dash > 0
    ? stripOps(`${query.slice(dash + 3)} ${query.slice(0, dash).split(/\s*[,&\/]\s*|\s+feat\.?\s+/i)[0]}`)
    : primaryQuery;

  if (plainQuery !== primaryQuery) {
    logger.debug(`[spotify] Trying plain query: "${plainQuery}"`);
    try {
      const fallback = await apiRequest(
        'GET',
        `/search?q=${encodeURIComponent(plainQuery)}&type=track&limit=5&market=IL`
      );
      if (fallback?.tracks?.items?.length) {
        return pickBestMatch(fallback.tracks.items, query);
      }
    } catch (err) {
      if (!err.message.includes('400')) throw err;
      logger.warn(`[spotify] Plain query also returned 400: "${plainQuery}"`);
    }
  }

  return null;
}

function pickBestMatch(tracks, rawQuery) {
  if (!tracks.length) return null;

  const q     = rawQuery.toLowerCase();
  const dash  = q.indexOf(' - ');
  const qTitle  = dash > 0 ? q.slice(dash + 3).trim() : q;
  // Normalize multi-artist separator (comma/ampersand/feat) to space so it
  // matches the way track.artists is joined below ("artist1 artist2").
  const qArtist = dash > 0
    ? q.slice(0, dash).trim().split(/\s*[,&\/]\s*|\s+feat\.?\s+/i).map(a => a.trim()).join(' ')
    : '';

  let bestScore = -Infinity;
  let bestTrack = tracks[0];

  for (const track of tracks) {
    let score = 0;
    const name    = track.name.toLowerCase();
    const artists = track.artists.map((a) => a.name.toLowerCase()).join(' ');

    // Title similarity
    if (name === qTitle)           score += 10;
    else if (name.includes(qTitle)) score += 5;
    else if (qTitle.includes(name)) score += 3;

    // Artist similarity
    if (qArtist) {
      if (artists === qArtist)            score += 8;
      else if (artists.includes(qArtist)) score += 5;
      else if (qArtist.includes(artists)) score += 3;
    }

    // Popularity as a tiebreaker (0-100 -> 0-5 points)
    score += (track.popularity ?? 0) / 20;

    if (score > bestScore) {
      bestScore = score;
      bestTrack = track;
    }
  }

  const artistNames = bestTrack.artists.map((a) => a.name).join(', ');
  logger.debug(
    `[spotify] Best match: "${bestTrack.name}" by ${artistNames} ` +
    `(popularity ${bestTrack.popularity}, score ${bestScore.toFixed(1)})`
  );

  return {
    uri:        bestTrack.uri,
    id:         bestTrack.id,
    name:       bestTrack.name,
    artists:    artistNames,
    popularity: bestTrack.popularity,
  };
}

// ── Playlist management ───────────────────────────────────────────────────────

/**
 * Fetch all track URIs and IDs from the target playlist, handling Spotify's
 * 100-item pagination automatically.
 * Returns items in playlist order: index 0 = oldest (first added at bottom).
 */
async function getPlaylistTracks() {
  const tracks = [];
  // Request only the fields we need to minimise payload size.
  let url = `/playlists/${config.spotify.playlistId}/items` +
            `?fields=next,items(track(uri,id))&limit=100`;

  while (url) {
    const data = await apiRequest('GET', url);
    for (const item of (data.items || [])) {
      if (item.track?.uri) {
        tracks.push({ uri: item.track.uri, id: item.track.id });
      }
    }
    url = data.next || null;   // data.next is a full URL or null
  }

  return tracks;
}

/**
 * Append a single track to the end of the playlist (chronological order).
 */
async function addTrackToPlaylist(trackUri) {
  await apiRequest('POST', `/playlists/${config.spotify.playlistId}/items`, {
    uris: [trackUri],
    // No `position` -> appended at the end
  });
  logger.debug(`[spotify] Appended ${trackUri} to playlist`);
}

/**
 * Remove specific track URIs from the playlist.
 * Batches in groups of 100 (Spotify's per-request limit).
 */
async function removeTracksFromPlaylist(uris) {
  if (!uris.length) return;
  for (let i = 0; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100).map((uri) => ({ uri }));
    await apiRequest('DELETE', `/playlists/${config.spotify.playlistId}/items`, {
      tracks: batch,
    });
  }
  logger.debug(`[spotify] Removed ${uris.length} track(s) from playlist`);
}

/**
 * Ensure the playlist does not exceed maxSize items.
 * Since we always append at the end, the oldest items are at the beginning
 * (lowest indices) — those are removed first.
 */
async function trimPlaylist(maxSize) {
  const tracks = await getPlaylistTracks();
  if (tracks.length <= maxSize) return;

  const excess   = tracks.length - maxSize;
  const toRemove = tracks.slice(0, excess).map((t) => t.uri);
  logger.info(`[spotify] Trimming playlist: ${tracks.length} -> ${maxSize} (removing ${excess} oldest track(s))`);
  await removeTracksFromPlaylist(toRemove);
}

/**
 * Return true if the given track URI is already in the playlist.
 * Used to prevent duplicates when the same song plays across multiple checks.
 */
async function isTrackInPlaylist(trackUri) {
  const tracks = await getPlaylistTracks();
  return tracks.some((t) => t.uri === trackUri);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify Spotify credentials and playlist access at startup.
 * Logs the authenticated user and playlist name, or a clear error if anything
 * is wrong (bad token, wrong playlist ID, missing scopes, wrong account).
 */
async function checkAccess() {
  let me;
  try {
    me = await apiRequest('GET', '/me');
    logger.info(`[spotify] Authenticated as: ${me.display_name || me.id} (${me.email || me.id})`);
  } catch (err) {
    logger.error(`[spotify] Token check failed: ${err.message}`);
    logger.error('[spotify]   → Re-run  node scripts/get-token.js  and update SPOTIFY_REFRESH_TOKEN in .env');
    return;
  }

  try {
    const pl = await apiRequest('GET', `/playlists/${config.spotify.playlistId}?fields=name,owner`);
    logger.info(`[spotify] Playlist metadata OK: "${pl.name}" (owned by ${pl.owner?.display_name || pl.owner?.id})`);
  } catch (err) {
    if (err.message.includes('403') || err.message.includes('404')) {
      logger.error(`[spotify] Cannot access playlist ID "${config.spotify.playlistId}": ${err.message}`);
      logger.error('[spotify]   → Check SPOTIFY_PLAYLIST_ID in .env.');
      logger.error('[spotify]     To find it: open the playlist in Spotify → Share → Copy link.');
      logger.error('[spotify]     The ID is the part after /playlist/ and before the ?');
    } else {
      logger.error(`[spotify] Playlist metadata check failed: ${err.message}`);
    }
    return;
  }

  // Test the tracks endpoint specifically — this requires playlist-read-private
  // scope and is what actually fails if the token was granted without scopes.
  try {
    await apiRequest('GET', `/playlists/${config.spotify.playlistId}/items?limit=1`);
    logger.info('[spotify] Playlist read/write access confirmed ✓');
  } catch (err) {
    if (err.message.includes('403')) {
      logger.error('[spotify] ✗ Cannot read playlist tracks — token is missing playlist scopes.');
      logger.error('[spotify]   The token was likely granted before the required scopes were added.');
      logger.error('[spotify]   Fix:');
      logger.error('[spotify]     1. Open https://www.spotify.com/account/apps in your browser');
      logger.error(`[spotify]        Find your app and click "REMOVE ACCESS"`);
      logger.error('[spotify]     2. Run  node scripts/get-token.js  on your laptop again');
      logger.error('[spotify]        (the Agree button will appear with all required scopes listed)');
      logger.error('[spotify]     3. Copy the new SPOTIFY_REFRESH_TOKEN to .env on the Pi and restart');
    } else {
      logger.error(`[spotify] Playlist tracks check failed: ${err.message}`);
    }
  }
}

module.exports = {
  searchTrack,
  addTrackToPlaylist,
  removeTracksFromPlaylist,
  getPlaylistTracks,
  trimPlaylist,
  isTrackInPlaylist,
  checkAccess,
};
