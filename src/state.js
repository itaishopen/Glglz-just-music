'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const STATE_FILE = path.resolve(config.stateFile);

function _load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    logger.warn(`[state] Could not read state file: ${err.message}`);
  }
  return { lastSong: null, lastAddedAt: null };
}

function _save(data) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[state] Could not write state file: ${err.message}`);
  }
}

function getLastSong() {
  return _load().lastSong || null;
}

/**
 * Persist the normalized song string so it survives process restarts.
 */
function setLastSong(normalizedSong) {
  _save({ lastSong: normalizedSong, lastAddedAt: new Date().toISOString() });
  logger.debug(`[state] Saved last song: "${normalizedSong}"`);
}

module.exports = { getLastSong, setLastSong };
