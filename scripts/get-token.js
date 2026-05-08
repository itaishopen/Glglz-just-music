#!/usr/bin/env node
/**
 * One-time helper to obtain a Spotify refresh token.
 *
 * How it works:
 *   1. This script starts a temporary local HTTP server on port 8888.
 *   2. It prints an auth URL — open it in your browser and log in.
 *   3. Click "Agree". Spotify redirects back to localhost:8888/callback.
 *   4. The script captures the code, exchanges it for tokens, and prints
 *      the SPOTIFY_REFRESH_TOKEN line to add to your .env file.
 *   5. The local server shuts down automatically.
 *
 * Make sure http://localhost:8888/callback is listed as a Redirect URI in
 * your Spotify Developer Dashboard app settings before running this script.
 */

'use strict';

require('dotenv').config();

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const qs     = require('querystring');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const PORT          = 8888;
const REDIRECT_URI  = `http://127.0.0.1:${PORT}/callback`;

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
console.log(`  ${REDIRECT_URI}\n`);
console.log('Step 1 — Open this URL in your browser:\n');
console.log('  ' + authUrl + '\n');
console.log('Step 2 — Log in and click "Agree"');
console.log('Step 3 — The browser will redirect to localhost. This script will capture');
console.log('         the code automatically and print your refresh token.\n');
console.log('Waiting for Spotify to redirect to localhost…\n');

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const error         = url.searchParams.get('error');
  const returnedState = url.searchParams.get('state');
  const code          = url.searchParams.get('code');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Spotify returned an error: ${error}\nYou can close this tab.`);
    server.close();
    console.error(`\n❌  Spotify returned an error: ${error}\n`);
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('State mismatch — possible CSRF. Please run the script again.');
    server.close();
    console.error('\n❌  State mismatch — possible CSRF. Run the script again.\n');
    process.exit(1);
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('No code returned. Please run the script again.');
    server.close();
    console.error('\n❌  No code in callback URL.\n');
    process.exit(1);
  }

  try {
    const tokens = await exchangeCode(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('✅  Authorization successful! You can close this tab and check your terminal.');
    server.close();

    console.log('══════════════════════════════════════════════════');
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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Token exchange failed: ${err.message}`);
    server.close();
    console.error(`\n❌  Token exchange failed: ${err.message}\n`);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n❌  Port ${PORT} is already in use. Stop whatever is running on it and try again.\n`
    );
  } else {
    console.error(`\n❌  Server error: ${err.message}\n`);
  }
  process.exit(1);
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
