#!/usr/bin/env node
/**
 * One-time helper to obtain a Spotify refresh token.
 *
 * No local server or certificate needed.
 *
 * How it works:
 *   1. Register  https://httpbin.org/get  in the Spotify Developer Dashboard.
 *      (httpbin.org is a trusted public HTTP-testing service — real HTTPS,
 *      so Spotify accepts it.  The auth code it receives is single-use and
 *      expires within seconds, so it is safe to use for a setup script.)
 *   2. This script prints an auth URL.  Open it in your browser and log in.
 *   3. Click "Agree".  Your browser will redirect to httpbin.org and show
 *      a JSON page — that is expected and means it worked.
 *   4. Copy the FULL URL from the browser address bar.  It will look like:
 *        https://httpbin.org/get?code=AQDxxx...&state=yyy...
 *   5. Paste that URL here.  The script extracts the code and gets your token.
 */

'use strict';

require('dotenv').config();

const https    = require('https');
const crypto   = require('crypto');
const qs       = require('querystring');
const readline = require('readline');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = 'https://httpbin.org/get';

const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\n❌  SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env first.\n'
  );
  process.exit(1);
}

const state   = crypto.randomBytes(16).toString('hex');
const authUrl = 'https://accounts.spotify.com/authorize?' + qs.stringify({
  response_type: 'code',
  client_id:     CLIENT_ID,
  scope:         SCOPES,
  redirect_uri:  REDIRECT_URI,
  state,
  show_dialog:   'true',  // always show Agree screen so new scopes are granted
});

console.log('\n══════════════════════════════════════════════════');
console.log(' Spotify Refresh Token Helper');
console.log('══════════════════════════════════════════════════\n');
console.log('Make sure your Spotify Developer Dashboard has this redirect URI saved:');
console.log('  https://httpbin.org/get\n');
console.log('Step 1 — Open this URL in your browser:\n');
console.log('  ' + authUrl + '\n');
console.log('Step 2 — Log in and click "Agree"');
console.log('Step 3 — Your browser will load a JSON page on httpbin.org — that\'s expected.');
console.log('Step 4 — You can paste EITHER:');
console.log('           a) The full URL from the address bar: https://httpbin.org/get?code=AQC...');
console.log('           b) Just the "code" value shown in the JSON on the page\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the URL or code here: ', async (input) => {
  rl.close();
  input = input.trim();

  let code;

  if (input.startsWith('http')) {
    // Full URL pasted — extract code and validate state
    let url;
    try { url = new URL(input); } catch {
      console.error('\n❌  That does not look like a valid URL. Please try again.\n');
      process.exit(1);
    }

    const error         = url.searchParams.get('error');
    const returnedState = url.searchParams.get('state');
    code                = url.searchParams.get('code');

    if (error) { console.error(`\n❌  Spotify returned an error: ${error}\n`); process.exit(1); }
    if (!code)  { console.error('\n❌  No "code" in URL. Make sure you copied the full redirect URL.\n'); process.exit(1); }

    if (returnedState !== state) {
      console.error('\n❌  State mismatch — URL may be from a previous session. Run the script again.\n');
      process.exit(1);
    }
  } else {
    // Bare code pasted directly
    code = input;
    if (!code) { console.error('\n❌  Nothing was pasted. Please try again.\n'); process.exit(1); }
  }

  try {
    const tokens = await exchangeCode(code);
    console.log('\n══════════════════════════════════════════════════');
    console.log('✅  SUCCESS — add this line to your .env file:');
    console.log('══════════════════════════════════════════════════\n');
    console.log(`SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.warn(
        '⚠️  No refresh_token returned. Revoke the app at\n' +
        '    https://www.spotify.com/account/apps and re-run this script.\n'
      );
    }
  } catch (err) {
    console.error(`\n❌  Token exchange failed: ${err.message}\n`);
    process.exit(1);
  }
});

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body = qs.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });

    const req = https.request({
      hostname: 'accounts.spotify.com',
      path:     '/api/token',
      method:   'POST',
      headers:  {
        Authorization:    `Basic ${credentials}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          json.error ? reject(new Error(`${json.error}: ${json.error_description}`)) : resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
