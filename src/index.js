'use strict';

require('dotenv').config();

const config  = require('./config');
const logger  = require('./logger');
const scraper = require('./scraper');
const spotify = require('./spotify');
const state   = require('./state');

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

  // 2. Skip if same song as last cycle
  const lastSong = state.getLastSong();
  if (normalized === lastSong) {
    logger.info('Same song still playing — no action needed');
    return;
  }

  logger.info(`New song detected (was: "${lastSong ?? 'none'}")`);

  // 3. Search Spotify
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

  // 4. Check for duplicates already in the playlist
  try {
    const alreadyIn = await spotify.isTrackInPlaylist(track.uri);
    if (alreadyIn) {
      logger.info('Track already in playlist — skipping add');
      state.setLastSong(normalized);
      return;
    }
  } catch (err) {
    logger.warn(`[spotify] Duplicate check failed (proceeding anyway): ${err.message}`);
  }

  // 5. Add to playlist
  try {
    await spotify.addTrackToPlaylist(track.uri);
    logger.info(`✓ Added to playlist: "${track.name}" by ${track.artists}`);
  } catch (err) {
    logger.error(`[spotify] Add to playlist failed: ${err.message}`);
    return;
  }

  // 6. Trim playlist to configured max size
  try {
    await spotify.trimPlaylist(config.monitor.maxPlaylistSize);
  } catch (err) {
    logger.error(`[spotify] Trim failed: ${err.message}`);
    // Non-fatal — the track was added; just log and continue
  }

  // 7. Persist state
  state.setLastSong(normalized);
  logger.info(`State updated ✓`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  logger.info('════════════════════════════════════════════════════════');
  logger.info(' Galgalatz → Spotify Monitor  (starting up)');
  logger.info(`  Check interval : ${config.monitor.intervalMs / 1000}s`);
  logger.info(`  Playlist cap   : ${config.monitor.maxPlaylistSize} songs`);
  logger.info(`  Playlist ID    : ${config.spotify.playlistId}`);
  logger.info('════════════════════════════════════════════════════════');

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
