'use strict';

require('dotenv').config();

const REQUIRED = [
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REFRESH_TOKEN',
  'SPOTIFY_PLAYLIST_ID',
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  spotify: {
    clientId:     process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    playlistId:   process.env.SPOTIFY_PLAYLIST_ID,
  },
  scraper: {
    url:        process.env.GLGLZ_URL || 'https://glz.co.il/%D7%92%D7%9C%D7%92%D7%9C%D7%A6',
    // Set CHROMIUM_PATH=/usr/bin/chromium-browser on Raspberry Pi 3 (ARM32)
    chromiumPath: process.env.CHROMIUM_PATH || null,
    timeoutMs:  parseInt(process.env.SCRAPER_TIMEOUT_MS || '45000', 10),
  },
  monitor: {
    intervalMs:      parseInt(process.env.CHECK_INTERVAL_MS  || '180000', 10),
    maxPlaylistSize: parseInt(process.env.MAX_PLAYLIST_SIZE  || '100',    10),
  },
  stateFile:  process.env.STATE_FILE  || './data/state.json',
  logLevel:   process.env.LOG_LEVEL   || 'info',
  logToFile:  process.env.LOG_TO_FILE === 'true',
};
