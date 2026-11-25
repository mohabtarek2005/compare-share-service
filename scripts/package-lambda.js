#!/usr/bin/env node
// Builds the AWS Lambda ZIP for the Compare & Share service.
//
//   node scripts/package-lambda.js [--out <folder>]
//
// The ZIP contains only what the service needs at run time:
//   src/, public/, package.json, package-lock.json and the production
//   node_modules (every dependency of this package is a production one).
// It never contains tests, test fixtures, .env files, keys or credentials;
// the script stops if any such file would be packaged.
//
// Default output folder is OUTSIDE the Git repository, so the ZIP can never be
// committed by accident: D:/Downloadss/class-tt-local-test/lambda
// (override with --out or LAMBDA_OUT_DIR).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT_DIR = path.resolve(
  outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : process.env.LAMBDA_OUT_DIR || 'D:/Downloadss/class-tt-local-test/lambda'
);
const STAGING = path.join(OUT_DIR, 'staging');
const ZIP_PATH = path.join(OUT_DIR, 'compare-share-lambda.zip');

// Refuse to write the ZIP inside the repository.
const repoRoot = path.resolve(ROOT, '..');
if (OUT_DIR.toLowerCase().startsWith(repoRoot.toLowerCase() + path.sep) || OUT_DIR.toLowerCase() === repoRoot.toLowerCase()) {
  console.error(`Refusing to write the Lambda package inside the Git repository (${OUT_DIR}).`);
  process.exit(1);
}

const INCLUDE = ['src', 'public', 'package.json', 'package-lock.json', 'node_modules'];
// Anything that looks like a secret, a test or a fixture is never packaged.
const FORBIDDEN = [/(^|[\\/])\.env(\.|$)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /(^|[\\/])id_rsa/i, /(^|[\\/])\.aws([\\/]|$)/i, /credentials(\.json)?$/i];
const SKIP_DIRS = new Set(['test', 'tests', '__tests__', 'fixtures', '.git', '.github', 'coverage']);

let fileCount = 0;
let byteCount = 0;

function copy(src, dest, relative) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const name = path.basename(src);
    // Skip test folders in our own code. Inside node_modules only skip test
    // folders too; packages never need them at run time.
    if (relative !== '' && SKIP_DIRS.has(name.toLowerCase())) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copy(path.join(src, entry), path.join(dest, entry), path.join(relative, entry));
    }
    return;
  }
  if (FORBIDDEN.some((pattern) => pattern.test(relative))) {
    console.error(`Refusing to package a file that looks like a secret: ${relative}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  fileCount += 1;
  byteCount += stat.size;
}

fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.error(`Missing ${item}. Run "npm install" in the mohab folder first.`);
    process.exit(1);
  }
  copy(src, path.join(STAGING, item), item);
}

// Sanity check: the handler and the adapter must be inside the package.
for (const required of ['src/lambda.js', 'src/appFromEnv.js', 'node_modules/serverless-http/package.json', 'node_modules/express/package.json']) {
  if (!fs.existsSync(path.join(STAGING, required))) {
    console.error(`Package is missing ${required}`);
    process.exit(1);
  }
}

fs.rmSync(ZIP_PATH, { force: true });
// "tar -a" picks the ZIP format from the .zip extension (bsdtar, built into
// Windows 10/11 and available on macOS/Linux).
// On Windows the built-in bsdtar is used by full path, because Git Bash puts
// GNU tar (which cannot write ZIP files) first on PATH.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(TAR, ['-a', '-c', '-f', ZIP_PATH, '-C', STAGING, ...INCLUDE], { stdio: 'inherit' });
fs.rmSync(STAGING, { recursive: true, force: true });

const zipBytes = fs.statSync(ZIP_PATH).size;
console.log(`Packaged ${fileCount} files (${(byteCount / 1048576).toFixed(1)} MB unpacked)`);
console.log(`Wrote ${ZIP_PATH} (${(zipBytes / 1048576).toFixed(1)} MB)`);
