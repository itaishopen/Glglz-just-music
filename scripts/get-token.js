#!/usr/bin/env node
/**
 * One-time helper to obtain a Spotify refresh token.
 *
 * No local server or certificate needed.
 *
 * How it works:
 *   1. Register  https://localhost:8888/callback  in the Spotify dashboard
 *      (Spotify accepts HTTPS localhost — HTTP is what it blocks).
 *   2. This script prints an auth URL.  Open it in your browser and log in.
 *   3. Spotify redirects your browser to https://localhost:8888/callback?code=…
 *      The browser shows "This site can't be reached" — that is expected.
 *   4. Copy the full URL from the browser address bar and paste it here.
 *   5. The script extracts the code, exchanges it, and prints the refresh token.
 */

'use strict';

require('dotenv').config();

const https    = require('https');
const crypto   = require('crypto');
const qs       = require('querystring');
const readline = require('readline');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = 'https://localhost:8888/callback';

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
});

console.log('\n══════════════════════════════════════════════════');
console.log(' Spotify Refresh Token Helper');
console.log('══════════════════════════════════════════════════\n');
console.log('Make sure your Spotify Developer Dashboard has this redirect URI saved:');
console.log('  https://localhost:8888/callback\n');
console.log('Step 1 — Open this URL in your browser:\n');
console.log('  ' + authUrl + '\n');
console.log('Step 2 — Log in and click "Agree"');
console.log('Step 3 — Your browser will show "This site can\'t be reached" — that\'s expected.');
console.log('Step 4 — Copy the FULL URL from the browser address bar (starts with https://localhost…)\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the full redirect URL here: ', async (input) => {
  rl.close();
  input = input.trim();

  let url;
  try {
    url = new URL(input);
  } catch {
    console.error('\n❌  That does not look like a valid URL. Please try again.\n');
    process.exit(1);
  }

  const code          = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const error         = url.searchParams.get('error');

  if (error) {
    console.error(`\n❌  Spotify returned an error: ${error}\n`);
    process.exit(1);
  }

  if (!code) {
    console.error('\n❌  No "code" found in the URL. Make sure you copied the full redirect URL.\n');
    process.exit(1);
  }

  if (returnedState !== state) {
    console.error('\n❌  State mismatch — the URL may be from a previous session. Run the script again.\n');
    process.exit(1);
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
