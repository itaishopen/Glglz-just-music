'use strict';

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const IGNORE_FILE = path.join(__dirname, '..', 'data', 'ignore-words.txt');

/**
 * Read the ignore list fresh from disk on every call so the user can edit
 * the file without restarting the script.
 * Lines starting with # and blank lines are skipped.
 */
function loadIgnoreWords() {
  try {
    if (!fs.existsSync(IGNORE_FILE)) return [];
    return fs.readFileSync(IGNORE_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.toLowerCase());
  } catch (err) {
    logger.warn(`[ignore] Could not read ignore list: ${err.message}`);
    return [];
  }
}

/**
 * Return true if the song text contains any word from the ignore list.
 * Matching is case-insensitive and substring-based.
 */
function shouldIgnore(song) {
  if (!song) return false;
  const words    = loadIgnoreWords();
  const songLower = song.toLowerCase();
  for (const word of words) {
    if (songLower.includes(word)) {
      logger.info(`[ignore] Skipping — matched ignore word "${word}" in: "${song}"`);
      return true;
    }
  }
  return false;
}

module.exports = { shouldIgnore };
