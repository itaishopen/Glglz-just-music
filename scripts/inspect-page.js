#!/usr/bin/env node
/**
 * Debug helper — loads the Galgalatz page and dumps:
 *   1. A screenshot  →  data/inspect-screenshot.png
 *   2. The outerHTML of any element containing "מתנגן כעת"  →  stdout
 *
 * Use this when the scraper fails to find the now-playing element, or when
 * the site appears to have changed its DOM structure.
 *
 * Usage:  node scripts/inspect-page.js
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const config = require('../src/config');
const LABEL  = 'מתנגן כעת';

(async () => {
  console.log(`\nLoading: ${config.scraper.url}\n`);

  let browser;
  try {
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };

    if (config.scraper.chromiumPath) {
      launchOptions.executablePath = config.scraper.chromiumPath;
    } else {
      launchOptions.executablePath = chromium.executablePath();
    }

    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage();

    await page.goto(config.scraper.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Screenshot
    const screenshotPath = path.join(__dirname, '..', 'data', 'inspect-screenshot.png');
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved: ${screenshotPath}\n`);

    // innerText line extraction
    const line = await page.evaluate((label) => {
      const body = document.body.innerText || '';
      const idx  = body.indexOf(label);
      if (idx === -1) return null;
      const start = body.lastIndexOf('\n', idx) + 1;
      const end   = body.indexOf('\n', idx);
      return body.slice(start, end === -1 ? undefined : end).trim();
    }, LABEL);

    if (line) {
      console.log(`Found now-playing line:\n  "${line}"\n`);
    } else {
      console.log(`"${LABEL}" NOT FOUND in page innerText.\n`);
    }

    // Dump matching DOM elements
    const elements = await page.evaluate((label) => {
      const results = [];
      const walker  = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue?.includes(label)) {
          const el = node.parentElement;
          if (el) results.push(el.outerHTML.slice(0, 500));
        }
      }
      return results;
    }, LABEL);

    if (elements.length) {
      console.log(`DOM elements containing "${LABEL}":`);
      elements.forEach((html, i) => console.log(`\n[${i + 1}] ${html}`));
    } else {
      console.log(`No DOM elements found containing "${LABEL}".`);
      console.log('The page may not have loaded yet, or the site structure has changed.');
    }

    // Also print full body text for manual inspection
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const dumpPath = path.join(__dirname, '..', 'data', 'inspect-body.txt');
    fs.writeFileSync(dumpPath, bodyText, 'utf8');
    console.log(`\nFull body text saved: ${dumpPath}`);

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error(`\nInspection failed: ${err.message}`);
  process.exit(1);
});
