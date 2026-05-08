'use strict';

/**
 * Generates an ephemeral self-signed TLS certificate for localhost using the
 * system openssl binary.  The cert is valid for 1 day and deleted immediately
 * after being read into memory — nothing is written permanently to disk.
 *
 * openssl is pre-installed on macOS and most Linux distros.
 * On Windows, install Git for Windows (which bundles openssl) and run the
 * token scripts from Git Bash.
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

function generateCert() {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'glglz-cert-'));
  const keyFile  = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');

  // Windows Git openssl needs a double-slash prefix in -subj
  const subj = process.platform === 'win32' ? '//CN=localhost' : '/CN=localhost';

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 ` +
      `-keyout "${keyFile}" -out "${certFile}" ` +
      `-days 1 -nodes -subj "${subj}"`,
      { stdio: 'pipe' }   // suppress openssl's own output
    );
  } catch {
    throw new Error(
      'openssl is required but was not found.\n' +
      '  macOS / Linux : openssl is pre-installed\n' +
      '  Windows       : install Git for Windows and run from Git Bash\n'
    );
  }

  const key  = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile);

  // Clean up temp files immediately
  try { fs.unlinkSync(keyFile);  } catch {}
  try { fs.unlinkSync(certFile); } catch {}
  try { fs.rmdirSync(dir);       } catch {}

  return { key, cert };
}

module.exports = { generateCert };
