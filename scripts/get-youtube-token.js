#!/usr/bin/env node
/**
 * One-time helper to obtain a YouTube (Google) refresh token via OAuth 2.0
 * over HTTPS.
 *
 * Prerequisites:
 *   1. Create a Google Cloud project and enable YouTube Data API v3.
 *   2. Create an OAuth 2.0 "Web application" credential.
 *   3. Add  https://localhost:8889/callback  as an Authorised Redirect URI.
 *   4. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env.
 *
 * Usage:
 *   node scripts/get-youtube-token.js
 *
 * Browser certificate warning (expected — self-signed cert):
 *   Chrome  → Advanced → Proceed to localhost (unsafe)
 *             (or type  thisisunsafe  if no link appears)
 *   Firefox → Advanced → Accept the Risk and Continue
 */

'use strict';

require('dotenv').config();

const https       = require('https');
const crypto      = require('crypto');
const querystring = require('querystring');
const { generateCert } = require('./lib/cert');

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = 'https://localhost:8889/callback';
const PORT          = 8889;   // different from Spotify helper (8888)

const SCOPES = 'https://www.googleapis.com/auth/youtube';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\n❌  YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set.\n' +
    '    Copy .env.example to .env and fill in those values first.\n'
  );
  process.exit(1);
}

// Generate a temporary self-signed cert so the local server can use HTTPS
let sslCreds;
try {
  console.log('Generating self-signed certificate…');
  sslCreds = generateCert();
} catch (err) {
  console.error(`\n❌  ${err.message}`);
  process.exit(1);
}

const state   = crypto.randomBytes(16).toString('hex');
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  querystring.stringify({
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
console.log('Step 1 — Open this URL in your browser:\n');
console.log('  ' + authUrl + '\n');
console.log('Step 2 — Sign in and click "Allow"');
console.log('Step 3 — Your browser will warn about the certificate (self-signed):');
console.log('           Chrome  → Advanced → Proceed to localhost (unsafe)');
console.log('                     (or type  thisisunsafe  if no link appears)');
console.log('           Firefox → Advanced → Accept the Risk and Continue');
console.log('Step 4 — The token will print here automatically.\n');

const server = https.createServer(sslCreds, async (req, res) => {
  if (!req.url?.startsWith('/callback')) return;

  const params        = new URLSearchParams(req.url.split('?')[1] || '');
  const code          = params.get('code');
  const returnedState = params.get('state');
  const error         = params.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization error: ${error}`);
    console.error(`\n❌  Authorization denied: ${error}\n`);
    server.close();
    return;
  }

  if (returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('State mismatch. Please try again.');
    server.close();
    return;
  }

  try {
    const tokens = await exchangeCode(code);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<body style="font-family:sans-serif;padding:40px">' +
      '<h2>✅ Success!</h2><p>You can close this tab and check your terminal.</p>' +
      '</body>'
    );

    console.log('══════════════════════════════════════════════════');
    console.log('✅  SUCCESS — add this line to your .env file:');
    console.log('══════════════════════════════════════════════════\n');
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.warn(
        '⚠️  No refresh_token in response.\n' +
        '   Revoke the app at https://myaccount.google.com/permissions\n' +
        '   and re-run this script.\n'
      );
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Token exchange failed: ${err.message}`);
    console.error(`\n❌  Token exchange failed: ${err.message}\n`);
  }

  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HTTPS server listening on https://localhost:${PORT}/callback\n`);
});

// ── Token exchange ────────────────────────────────────────────────────────────

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path:     '/token',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) reject(new Error(`${json.error}: ${json.error_description}`));
            else            resolve(json);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
