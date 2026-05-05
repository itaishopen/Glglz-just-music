'use strict';

const axios  = require('axios');
const config = require('./config');
const logger = require('./logger');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE  = 'https://www.googleapis.com/youtube/v3';

let _accessToken    = null;
let _tokenExpiresAt = 0;

// ── Token management ──────────────────────────────────────────────────────────

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiresAt - 60_000) return _accessToken;

  logger.debug('[youtube] Refreshing access token');

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      client_id:     config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: config.youtube.refreshToken,
      grant_type:    'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 }
  );

  _accessToken    = response.data.access_token;
  _tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  logger.debug('[youtube] Access token refreshed');
  return _accessToken;
}

// ── Generic API request with retry ───────────────────────────────────────────

/**
 * @param {string} method
 * @param {string} url     Full URL or path relative to API_BASE
 * @param {object} [params]  Query-string parameters
 * @param {object} [data]    Request body (JSON)
 */
async function apiRequest(method, url, params = null, data = null, maxRetries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const token    = await getAccessToken();
      const response = await axios({
        method,
        url: fullUrl,
        params,
        data,
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      });
      return response.data ?? null;
    } catch (err) {
      if (err.response) {
        const { status, data: body } = err.response;

        if (status === 401) {
          _accessToken = null;
          _tokenExpiresAt = 0;
          if (attempt < maxRetries) { logger.debug('[youtube] 401 — forcing token refresh'); continue; }
        }

        if (status === 403) {
          const reason = body?.error?.errors?.[0]?.reason;
          if (reason === 'quotaExceeded') {
            throw new Error(
              'YouTube API daily quota exceeded (10,000 units/day free tier). ' +
              'Request a quota increase at console.cloud.google.com or wait until midnight Pacific time.'
            );
          }
        }

        if (status === 429) {
          const wait = parseInt(err.response.headers['retry-after'] || '10', 10);
          logger.warn(`[youtube] Rate limited (429). Waiting ${wait}s`);
          await sleep(wait * 1000);
          if (attempt < maxRetries) continue;
        }

        throw new Error(
          `YouTube API ${status} on ${method} ${url}: ${body?.error?.message ?? JSON.stringify(body)}`
        );
      }

      if (attempt < maxRetries) {
        const delay = 2 ** attempt * 1000;
        logger.warn(`[youtube] Request failed (attempt ${attempt}/${maxRetries}), retry in ${delay}ms: ${err.message}`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Search YouTube for a music video.
 *
 * Matching strategy:
 *   1. Search with videoCategoryId=10 (Music) for the full "Artist - Title" query.
 *   2. If no results, retry without the category filter (broader net).
 *   3. Score up to 5 results: title word match, artist/channel name match,
 *      bonus for "official" videos, penalty for live/cover/remix variants
 *      when the original query does not mention them.
 *
 * @param {string} query  Raw song string, e.g. "Wu Lyf - Love Your Fate"
 * @returns {{ videoId, title, channelTitle } | null}
 */
async function searchVideo(query) {
  logger.debug(`[youtube] Searching for: "${query}"`);

  const BASE_PARAMS = { part: 'snippet', type: 'video', maxResults: 5 };

  let data = await apiRequest('GET', '/search', { ...BASE_PARAMS, q: query, videoCategoryId: '10' });

  if (!data?.items?.length) {
    logger.debug('[youtube] No results in Music category — retrying without category filter');
    data = await apiRequest('GET', '/search', { ...BASE_PARAMS, q: query });
  }

  const items = data?.items || [];
  if (!items.length) return null;

  return pickBestVideo(items, query);
}

function pickBestVideo(items, rawQuery) {
  const q       = rawQuery.toLowerCase();
  const dash    = q.indexOf(' - ');
  const qArtist = dash > 0 ? q.slice(0, dash).trim()  : '';
  const qTitle  = dash > 0 ? q.slice(dash + 3).trim() : q;

  let bestScore = -Infinity;
  let best      = items[0];

  for (const item of items) {
    let score = 0;
    const vTitle   = (item.snippet.title        || '').toLowerCase();
    const channel  = (item.snippet.channelTitle || '').toLowerCase();
    const qWords   = qTitle.split(/\s+/).filter((w) => w.length > 2);

    // Title match
    if (vTitle.includes(qTitle))                      score += 10;
    else if (qWords.every((w) => vTitle.includes(w))) score +=  6;
    else if (qWords.some((w)  => vTitle.includes(w))) score +=  2;

    // Artist match — channel name often equals artist name for official channels
    if (qArtist) {
      if (channel.includes(qArtist))  score += 8;
      if (vTitle.includes(qArtist))   score += 4;
    }

    // Prefer official content
    if (vTitle.includes('official video')) score += 3;
    else if (vTitle.includes('official')) score += 2;
    if (vTitle.includes('music video'))   score += 1;

    // Penalise unwanted variants unless the query explicitly mentions them
    if (!q.includes('live')  && vTitle.includes('live'))  score -= 4;
    if (!q.includes('cover') && vTitle.includes('cover')) score -= 4;
    if (!q.includes('remix') && vTitle.includes('remix')) score -= 2;

    if (score > bestScore) { bestScore = score; best = item; }
  }

  logger.debug(
    `[youtube] Best match: "${best.snippet.title}" by ${best.snippet.channelTitle} (score: ${bestScore})`
  );

  return {
    videoId:      best.id.videoId,
    title:        best.snippet.title,
    channelTitle: best.snippet.channelTitle,
  };
}

// ── Playlist management ───────────────────────────────────────────────────────

/**
 * Efficiently check if a video is already in the playlist using YouTube's
 * built-in videoId filter (costs 1 quota unit instead of a full paginated fetch).
 */
async function isVideoInPlaylist(videoId) {
  const data = await apiRequest('GET', '/playlistItems', {
    part:       'id',
    playlistId: config.youtube.playlistId,
    videoId,
    maxResults: 1,
  });
  return (data?.pageInfo?.totalResults ?? 0) > 0;
}

/**
 * Append a video to the end of the YouTube playlist.
 */
async function addVideoToPlaylist(videoId) {
  await apiRequest('POST', '/playlistItems', { part: 'snippet' }, {
    snippet: {
      playlistId: config.youtube.playlistId,
      resourceId: { kind: 'youtube#video', videoId },
    },
  });
  logger.debug(`[youtube] Appended video ${videoId} to playlist`);
}

/**
 * Fetch all playlist items in order (oldest first = index 0).
 * Handles YouTube's 50-item pagination automatically.
 */
async function getPlaylistItems() {
  const items     = [];
  let pageToken   = undefined;

  do {
    const data = await apiRequest('GET', '/playlistItems', {
      part:       'snippet,contentDetails',
      playlistId: config.youtube.playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of (data?.items || [])) {
      items.push({
        playlistItemId: item.id,
        videoId:        item.contentDetails?.videoId,
        title:          item.snippet?.title,
      });
    }
    pageToken = data?.nextPageToken;
  } while (pageToken);

  return items;
}

/**
 * Ensure the playlist does not exceed maxSize items.
 * Items are appended at the end, so oldest items are at the beginning — those
 * are removed first, matching the Spotify behaviour.
 */
async function trimPlaylist(maxSize) {
  const items = await getPlaylistItems();
  if (items.length <= maxSize) return;

  const excess   = items.length - maxSize;
  const toRemove = items.slice(0, excess);
  logger.info(`[youtube] Trimming playlist: ${items.length} → ${maxSize} (removing ${excess} oldest item(s))`);

  for (const item of toRemove) {
    await apiRequest('DELETE', '/playlistItems', { id: item.playlistItemId });
  }
  logger.debug(`[youtube] Removed ${toRemove.length} item(s)`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  searchVideo,
  addVideoToPlaylist,
  getPlaylistItems,
  trimPlaylist,
  isVideoInPlaylist,
};
