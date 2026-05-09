'use strict';

require('dotenv').config();

const config  = require('./config');
const logger  = require('./logger');
const scraper = require('./scraper');
const spotify = require('./spotify');
const youtube = require('./youtube');
const state   = require('./state');
const ignore  = require('./ignore');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Single check cycle ────────────────────────────────────────────────────────

async function tick() {
  logger.info('─── Checking now-playing ───────────────────────────────');

  // 1. Scrape current song
  let currentSong;
  try {
    currentSong = await scraper.getNowPlaying();
    logger.info(`Now playing: "${currentSong}"`);
  } catch (err) {
    logger.error(`[scraper] Failed: ${err.message}`);
    return;
  }

  const normalized = scraper.normalizeSong(currentSong);

  if (!normalized) {
    logger.warn('Empty song text after normalisation — skipping');
    return;
  }

  // 2. Double-check against ignore list (data/ignore-words.txt)
  if (ignore.shouldIgnore(currentSong)) {
    state.setLastSong(normalized);
    return;
  }

  // 3. Skip if same song as last cycle
  const lastSong = state.getLastSong();
  if (normalized === lastSong) {
    logger.info('Same song still playing — no action needed');
    return;
  }

  logger.info(`New song detected (was: "${lastSong ?? 'none'}")`);

  // 4. Search Spotify
  let track;
  try {
    track = await spotify.searchTrack(currentSong);
  } catch (err) {
    logger.error(`[spotify] Search failed: ${err.message}`);
    // Don't update state — we'll retry next cycle
    return;
  }

  if (!track) {
    logger.warn(`No Spotify result for: "${currentSong}"`);
    // Update state anyway to avoid an infinite retry loop for the same unknown song
    state.setLastSong(normalized);
    return;
  }

  logger.info(`Found on Spotify: "${track.name}" by ${track.artists} (popularity: ${track.popularity})`);

  // 6. Fetch playlist once — reused for duplicate check and trim
  let playlistTracks = null;
  try {
    playlistTracks = await spotify.getPlaylistTracks();
  } catch (err) {
    logger.warn(`[spotify] Could not fetch playlist tracks (proceeding anyway): ${err.message}`);
  }

  // 7. Duplicate check using cached list
  if (playlistTracks) {
    if (playlistTracks.some((t) => t.uri === track.uri)) {
      logger.info('Track already in playlist — skipping add');
      state.setLastSong(normalized);
      return;
    }
  }

  // 8. Add to playlist
  try {
    await spotify.addTrackToPlaylist(track.uri);
    logger.info(`✓ Added to playlist: "${track.name}" by ${track.artists}`);
  } catch (err) {
    logger.error(`[spotify] Add to playlist failed: ${err.message}`);
    return;
  }

  // 9. Trim oldest if playlist now exceeds max size (using cached list + 1 for the song just added)
  if (playlistTracks) {
    const sizeAfterAdd = playlistTracks.length + 1;
    if (sizeAfterAdd > config.monitor.maxPlaylistSize) {
      const excess  = sizeAfterAdd - config.monitor.maxPlaylistSize;
      const toRemove = playlistTracks.slice(0, excess).map((t) => t.uri);
      try {
        await spotify.removeTracksFromPlaylist(toRemove);
        logger.info(`[spotify] Trimmed ${excess} oldest track(s)`);
      } catch (err) {
        logger.error(`[spotify] Trim failed: ${err.message}`);
      }
    }
  }

  // 10. YouTube playlist (optional — skipped if YOUTUBE_* vars are not set)
  if (config.youtube) {
    await addToYouTube(currentSong);
  }

  // 11. Persist state
  state.setLastSong(normalized);
  logger.info(`State updated ✓`);
}

// ── YouTube helper ────────────────────────────────────────────────────────────

/**
 * Search YouTube for the song and add it to the YouTube playlist.
 * Errors are logged but never bubble up — a YouTube failure must not prevent
 * the state from being updated or future Spotify additions from working.
 */
async function addToYouTube(songQuery) {
  // Search
  let video;
  try {
    video = await youtube.searchVideo(songQuery);
  } catch (err) {
    logger.error(`[youtube] Search failed: ${err.message}`);
    return;
  }

  if (!video) {
    logger.warn(`[youtube] No result found for: "${songQuery}"`);
    return;
  }

  logger.info(`[youtube] Found: "${video.title}" by ${video.channelTitle}`);

  // Duplicate check
  try {
    if (await youtube.isVideoInPlaylist(video.videoId)) {
      logger.info('[youtube] Video already in playlist — skipping add');
      return;
    }
  } catch (err) {
    logger.warn(`[youtube] Duplicate check failed (proceeding anyway): ${err.message}`);
  }

  // Add
  try {
    await youtube.addVideoToPlaylist(video.videoId);
    logger.info(`[youtube] ✓ Added: "${video.title}" by ${video.channelTitle}`);
  } catch (err) {
    logger.error(`[youtube] Add to playlist failed: ${err.message}`);
    return;
  }

  // Trim
  try {
    await youtube.trimPlaylist(config.monitor.maxPlaylistSize);
  } catch (err) {
    logger.error(`[youtube] Trim failed: ${err.message}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  logger.info('════════════════════════════════════════════════════════');
  logger.info(' Galgalatz → Spotify + YouTube Monitor  (starting up)');
  logger.info(`  Check interval : ${config.monitor.intervalMs / 1000}s`);
  logger.info(`  Playlist cap   : ${config.monitor.maxPlaylistSize} songs`);
  logger.info(`  Spotify playlist : ${config.spotify.playlistId}`);
  logger.info(`  YouTube playlist : ${config.youtube ? config.youtube.playlistId : 'disabled'}`);
  logger.info('════════════════════════════════════════════════════════');

  // Verify Spotify credentials and playlist access before the first tick.
  await spotify.checkAccess();

  // Run the first tick immediately, then wait between subsequent ticks.
  while (true) {
    try {
      await tick();
    } catch (err) {
      // Catch any unexpected error so the loop never dies.
      logger.error(`Unexpected error in tick: ${err.stack || err.message}`);
    }
    logger.debug(`Sleeping ${config.monitor.intervalMs / 1000}s until next check…`);
    await sleep(config.monitor.intervalMs);
  }
}

main().catch((err) => {
  // Only thrown if config validation fails at startup.
  console.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
