'use strict';

const { chromium } = require('playwright-core');
const config = require('./config');
const logger = require('./logger');

// Hebrew text that labels the currently-playing song on the Galgalatz page.
const NOW_PLAYING_LABEL = 'מתנגן כעת';

// Regex that strips the label (and optional colon/spaces) to isolate the song text.
// Handles: "מתנגן כעת:", "מתנגן כעת :", "מתנגן כעת " etc.
const LABEL_REGEX = /מתנגן\s+כעת\s*:?\s*/;

/**
 * Launch Chromium, load the Galgalatz page, and return the currently-playing
 * song string (e.g. "Wu Lyf - Love Your Fate").
 * Throws if the page is unreachable or the now-playing text cannot be found.
 */
async function getNowPlaying() {
  let browser;

  try {
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',  // use /tmp instead of /dev/shm (important on Pi)
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
      ],
    };

    if (config.scraper.chromiumPath) {
      launchOptions.executablePath = config.scraper.chromiumPath;
    } else {
      // playwright-core requires an explicit path.  If CHROMIUM_PATH is not set,
      // attempt the standard locations installed by `npx playwright install chromium`.
      const { executablePath } = require('playwright-core/lib/server');
      try {
        launchOptions.executablePath = executablePath('chromium');
      } catch {
        throw new Error(
          'No Chromium found. Either set CHROMIUM_PATH=/usr/bin/chromium-browser ' +
          'or run: npx playwright install chromium'
        );
      }
    }

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'he-IL',
      extraHTTPHeaders: { 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' },
    });

    // Block heavy media / analytics to conserve Pi memory and speed up load.
    await context.route(
      /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|mp3|mp4|webm|ogg)(\?.*)?$/i,
      (route) => route.abort()
    );
    await context.route(
      /\/(ads?|analytics|tracking|gtm|pixel|beacon)\//i,
      (route) => route.abort()
    );

    const page = await context.newPage();

    logger.debug(`Navigating to: ${config.scraper.url}`);

    await page.goto(config.scraper.url, {
      waitUntil: 'networkidle',
      timeout: config.scraper.timeoutMs,
    });

    return await extractNowPlaying(page);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Try three progressive strategies to locate and return the song text from the
 * already-loaded page.  Throws if all strategies fail.
 */
async function extractNowPlaying(page) {
  // ── Strategy 1: innerText line extraction ──────────────────────────────────
  // Most reliable: waits for JS to render the text, then splits by newline so
  // we get the whole "מתנגן כעת: Artist - Title" line regardless of CSS changes.
  try {
    await page.waitForFunction(
      (label) => (document.body.innerText || '').includes(label),
      NOW_PLAYING_LABEL,
      { timeout: 20000 }
    );

    const song = await page.evaluate((label) => {
      const body = document.body.innerText || '';
      const idx  = body.indexOf(label);
      if (idx === -1) return null;
      // Grab the line that contains the label.
      const lineStart = body.lastIndexOf('\n', idx) + 1;
      const lineEnd   = body.indexOf('\n', idx);
      return body.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    }, NOW_PLAYING_LABEL);

    if (song) {
      const parsed = parseSong(song);
      if (parsed) {
        logger.debug(`[scraper] Strategy 1 succeeded: "${parsed}"`);
        return parsed;
      }
    }
  } catch (err) {
    logger.debug(`[scraper] Strategy 1 failed: ${err.message}`);
  }

  // ── Strategy 2: DOM tree walker ────────────────────────────────────────────
  // Walks all text nodes looking for the label; returns text of the parent
  // element (and its parent) so we capture the full "Artist - Title" segment
  // even when label and title are in sibling <span>s.
  try {
    const candidates = await page.evaluate((label) => {
      const results = new Set();
      const walker  = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null, false
      );
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.includes(label)) continue;
        const el = node.parentElement;
        if (el) {
          results.add(el.textContent.trim());
          if (el.parentElement) results.add(el.parentElement.textContent.trim());
          if (el.parentElement?.parentElement)
            results.add(el.parentElement.parentElement.textContent.trim());
        }
      }
      return [...results];
    }, NOW_PLAYING_LABEL);

    for (const text of candidates) {
      const parsed = parseSong(text);
      if (parsed) {
        logger.debug(`[scraper] Strategy 2 succeeded: "${parsed}"`);
        return parsed;
      }
    }
  } catch (err) {
    logger.debug(`[scraper] Strategy 2 failed: ${err.message}`);
  }

  // ── Strategy 3: full body text search ──────────────────────────────────────
  // Last resort: split entire body by newlines and check each line.
  try {
    const lines = await page.evaluate(() =>
      (document.body.textContent || '').split('\n').map((l) => l.trim()).filter(Boolean)
    );
    for (const line of lines) {
      if (line.includes(NOW_PLAYING_LABEL)) {
        const parsed = parseSong(line);
        if (parsed) {
          logger.debug(`[scraper] Strategy 3 succeeded: "${parsed}"`);
          return parsed;
        }
      }
    }
  } catch (err) {
    logger.debug(`[scraper] Strategy 3 failed: ${err.message}`);
  }

  throw new Error(
    `"${NOW_PLAYING_LABEL}" not found on page or could not be parsed. ` +
    'Run "npm run inspect" to dump the page and check the selector.'
  );
}

/**
 * Strip the Hebrew label prefix and return only the song text, or null if the
 * label is not present in the string.
 */
function parseSong(text) {
  if (!text) return null;
  const match = text.match(LABEL_REGEX);
  if (!match) return null;
  const song = text.slice(match.index + match[0].length).replace(/\s+/g, ' ').trim();
  return song.length >= 3 ? song : null;
}

/**
 * Normalize a song string for equality comparison:
 *   - lower-case
 *   - collapse whitespace
 *   - trim
 * This prevents re-adding the same song when it has minor whitespace differences.
 */
function normalizeSong(song) {
  if (!song) return '';
  return song.toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = { getNowPlaying, normalizeSong };
