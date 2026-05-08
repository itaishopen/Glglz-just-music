#!/usr/bin/env node
/**
 * One-time helper to obtain a Spotify refresh token via the OAuth 2.0
 * Authorization Code flow over HTTPS.
 *
 * Prerequisites:
 *   1. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env
 *   2. In your Spotify Developer Dashboard add the redirect URI:
 *        https://localhost:8888/callback
 *   3. Run:  node scripts/get-token.js
 *   4. Open the printed URL in a browser and authorise the app.
 *      Your browser will warn about a self-signed certificate — this is expected:
 *        Chrome  → click "Advanced" then "Proceed to localhost (unsafe)"
 *                  (if no link appears, click anywhere on the page and type: thisisunsafe)
 *        Firefox → click "Advanced" then "Accept the Risk and Continue"
 *   5. Copy the SPOTIFY_REFRESH_TOKEN printed in the terminal into your .env
 */

'use strict';

require('dotenv').config();

const https       = require('https');
const crypto      = require('crypto');
const querystring = require('querystring');
const { generateCert } = require('./lib/cert');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = 'https://localhost:8888/callback';
const PORT          = 8888;

const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\n❌  SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set.\n' +
    '    Copy .env.example to .env and fill in those two values first.\n'
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
  'https://accounts.spotify.com/authorize?' +
  querystring.stringify({
    response_type: 'code',
    client_id:     CLIENT_ID,
    scope:         SCOPES,
    redirect_uri:  REDIRECT_URI,
    state,
  });

console.log('\n══════════════════════════════════════════════════');
console.log(' Spotify Refresh Token Helper');
console.log('══════════════════════════════════════════════════\n');
console.log('Step 1 — Open this URL in your browser:\n');
console.log('  ' + authUrl + '\n');
console.log('Step 2 — Click "Agree" / "Authorise" in Spotify');
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
    res.end('State mismatch — possible CSRF. Please try again.');
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
    console.log(`SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.warn(
        '⚠️  No refresh_token returned. Try revoking access in\n' +
        '    https://www.spotify.com/account/apps and re-running this script.\n'
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
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body = querystring.stringify({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });

    const req = https.request(
      {
        hostname: 'accounts.spotify.com',
        path:     '/api/token',
        method:   'POST',
        headers:  {
          Authorization:    `Basic ${credentials}`,
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
