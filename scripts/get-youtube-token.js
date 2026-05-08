#!/usr/bin/env node
/**
 * One-time helper to obtain a YouTube (Google) refresh token.
 *
 * No local server or certificate needed.
 *
 * How it works:
 *   1. Register  https://localhost:8889/callback  in Google Cloud Console.
 *   2. This script prints an auth URL.  Open it in your browser and log in.
 *   3. Google redirects your browser to https://localhost:8889/callback?code=…
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

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = 'https://localhost:8889/callback';

const SCOPES = 'https://www.googleapis.com/auth/youtube';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\n❌  YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in .env first.\n'
  );
  process.exit(1);
}

const state   = crypto.randomBytes(16).toString('hex');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + qs.stringify({
  client_id:     CLIENT_ID,
  redirect_uri:  REDIRECT_URI,
  response_type: 'code',
  scope:         SCOPES,
  access_type:   'offline',
  prompt:        'consent',
  state,
});

console.log('\n══════════════════════════════════════════════════');
console.log(' YouTube Refresh Token Helper');
console.log('══════════════════════════════════════════════════\n');
console.log('Make sure your Google Cloud Console has this redirect URI saved:');
console.log('  https://localhost:8889/callback\n');
console.log('Step 1 — Open this URL in your browser:\n');
console.log('  ' + authUrl + '\n');
console.log('Step 2 — Log in and click "Allow"');
console.log('Step 3 — Your browser will show "This site can\'t be reached" — that\'s expected.');
console.log('Step 4 — You can paste EITHER:');
console.log('           a) The full URL from the address bar: https://localhost:8889/callback?code=4/0A...');
console.log('           b) Just the "code" value from the URL\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the URL or code here: ', async (input) => {
  rl.close();
  input = input.trim();

  let code;

  if (input.startsWith('http')) {
    let url;
    try { url = new URL(input); } catch {
      console.error('\n❌  That does not look like a valid URL. Please try again.\n');
      process.exit(1);
    }

    const error         = url.searchParams.get('error');
    const returnedState = url.searchParams.get('state');
    code                = url.searchParams.get('code');

    if (error) { console.error(`\n❌  Google returned an error: ${error}\n`); process.exit(1); }
    if (!code)  { console.error('\n❌  No "code" in URL. Make sure you copied the full redirect URL.\n'); process.exit(1); }

    if (returnedState !== state) {
      console.error('\n❌  State mismatch — URL may be from a previous session. Run the script again.\n');
      process.exit(1);
    }
  } else {
    code = input;
    if (!code) { console.error('\n❌  Nothing was pasted. Please try again.\n'); process.exit(1); }
  }

  try {
    const tokens = await exchangeCode(code);
    console.log('\n══════════════════════════════════════════════════');
    console.log('✅  SUCCESS — add this line to your .env file:');
    console.log('══════════════════════════════════════════════════\n');
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.warn(
        '⚠️  No refresh_token returned. Revoke the app at\n' +
        '    https://myaccount.google.com/permissions and re-run this script.\n'
      );
    }
  } catch (err) {
    console.error(`\n❌  Token exchange failed: ${err.message}\n`);
    process.exit(1);
  }
});

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = qs.stringify({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  {
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
