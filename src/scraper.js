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
      // chromium.executablePath() is the public Playwright API — returns the path
      // of the browser downloaded by `npx playwright install chromium`.
      launchOptions.executablePath = chromium.executablePath();
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

    // 'domcontentloaded' fires as soon as the HTML is parsed — before all XHR/
    // fetch requests settle.  Radio sites poll continuously for now-playing data
    // so 'networkidle' never triggers and causes a timeout.  The actual song
    // element is found afterwards by waitForSelector inside extractNowPlaying().
    await page.goto(config.scraper.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.scraper.timeoutMs,
    });

    return await extractNowPlaying(page);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Try four progressive strategies to locate and return the song text from the
 * already-loaded page.  Throws if all strategies fail.
 */
async function extractNowPlaying(page) {
  // ── Strategy 0: direct CSS selector ───────────────────────────────────────
  // The site renders the song title in <span class="current-song">.
  // This is the fastest and most precise strategy; update the selector here
  // if the site ever changes its class name.
  try {
    await page.waitForSelector('span.current-song', { timeout: 20000 });
    const text = await page.locator('span.current-song').first().textContent();
    if (text) {
      const song = cleanSongText(text);
      if (song) {
        logger.debug(`[scraper] Strategy 0 (CSS selector) succeeded: "${song}"`);
        return song;
      }
    }
  } catch (err) {
    logger.debug(`[scraper] Strategy 0 failed: ${err.message}`);
  }

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
 * Clean raw text from a dedicated element (e.g. span.current-song) that may or
 * may not include the Hebrew label.  Strips the label if present; otherwise uses
 * the text as-is.  Returns null if the result is too short to be a real song.
 */
function cleanSongText(text) {
  if (!text) return null;
  const stripped = LABEL_REGEX.test(text) ? text.replace(LABEL_REGEX, '') : text;
  const song = stripped.replace(/\s+/g, ' ').trim();
  return song.length >= 3 ? song : null;
}

/**
 * Strip the Hebrew label prefix and return only the song text, or null if the
 * label is not present in the string.  Used by Strategies 1–3 which always
 * capture the whole line including the label.
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
