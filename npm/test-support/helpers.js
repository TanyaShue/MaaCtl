'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const platforms = require('../lib/platforms');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

const ENV_KEYS = [
  'MAACTL_BINARY',
  'MAACTL_HOME',
  'MAACTL_VERSION',
  'MAACTL_BINARY_URL',
  'MAACTL_MIRROR',
  'MAACTL_REPO',
  'MAACTL_ASSET',
  'MAACTL_PLATFORM',
  'MAACTL_SKIP_DOWNLOAD',
  'MAACTL_QUIET',
  'MAACTL_VERBOSE',
  'MAACTL_LANG',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'LOCALAPPDATA',
  'XDG_CACHE_HOME',
];

function tempDir(prefix = 'maactl-npm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Clear the wrapper's environment variables, apply `values`, and return a
 * function that puts the previous values back.
 */
function swapEnv(values) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/** Run `body` with the wrapper's environment variables cleared, restoring them afterwards. */
function withEnv(values, body) {
  const restore = swapEnv(values);
  try {
    return body();
  } finally {
    restore();
  }
}

/** `withEnv` for async bodies: clears and restores around an await. */
async function withEnvAsync(values, body) {
  const restore = swapEnv(values);
  try {
    return await body();
  } finally {
    restore();
  }
}

/**
 * Load a private copy of the wrapper in a fresh directory.
 *
 * Tests that exercise `resolveBinary()` / `ensureBinary()` must not be affected
 * by what happens to be installed in the working copy's node_modules or by a
 * developer's local platform package, so they run against a copy of the package
 * that only has what the test puts there. Each call returns a distinct module
 * instance.
 *
 * Pass `platformPackage` to also install this host's optional dependency, which
 * is what a real `npm install` of the published package leaves behind.
 */
function isolatedPackage({ platformPackage } = {}) {
  const root = tempDir('maactl-npm-pkg-');
  fs.cpSync(path.join(PACKAGE_ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(root, 'package.json'));
  if (platformPackage) {
    writePlatformPackage(root, platformPackage);
  }
  return { root, binary: require(path.join(root, 'lib', 'binary.js')) };
}

/** Install this host's platform package below `root`, as npm would. */
function writePlatformPackage(root, contents) {
  const name = platforms.packageName();
  const dir = path.join(root, 'node_modules', name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0' })}\n`);
  fs.writeFileSync(path.join(dir, 'bin', platforms.executable()), contents);
  return path.join(dir, 'bin', platforms.executable());
}

/** The magic bytes an executable of `platform` starts with. */
function nativeMagic(platform = process.platform) {
  switch (platform) {
    case 'win32':
      return Buffer.from('MZ');
    case 'linux':
      return Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
    default:
      return Buffer.from([0xcf, 0xfa, 0xed, 0xfe]); // 64-bit little-endian Mach-O
  }
}

/**
 * A byte payload that passes the format and size sanity checks of this host, so
 * tests do not have to care which platform they run on.
 */
function nativeExecutable(platform = process.platform) {
  return Buffer.concat([nativeMagic(platform), Buffer.alloc((1 << 20) + 4, 0x41)]);
}

/** Serve `routes` (path -> handler) on a loopback port, then close it. */
async function withServer(routes, body) {
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    const handler = routes[request.url];
    if (!handler) {
      response.writeHead(404).end('not found');
      return;
    }
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await body(base, server);
  } finally {
    // Keep-alive sockets would otherwise keep server.close() pending forever.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Build a zip archive in memory.
 *
 * Node can read zips but not write them, so the wrapper's tests build their own.
 * `method` picks deflate (the default, as release archives use) or stored.
 * `mode` records Unix permission bits the way an archive written on Linux or
 * macOS does, which is how the release archives spell "this is executable".
 */
function zipBuffer(files, { method = 'deflate', mode = null } = {}) {
  const crc32 = zlib.crc32 || (() => 0);
  const parts = [];
  const central = [];
  let offset = 0;
  // Host system 3 is Unix; entries written elsewhere carry no permission bits.
  const versionMadeBy = mode === null ? 20 : (3 << 8) | 20;
  const externalAttributes = mode === null ? 0 : (mode & 0o7777) << 16;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content);
    const deflated = zlib.deflateRawSync(raw);
    const stored = method === 'stored' || deflated.length >= raw.length;
    const data = stored ? raw : deflated;
    const checksum = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(stored ? 0 : 8, 8); // compression method
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(versionMadeBy, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(externalAttributes, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

module.exports = {
  PACKAGE_ROOT,
  ENV_KEYS,
  tempDir,
  withEnv,
  withEnvAsync,
  isolatedPackage,
  writePlatformPackage,
  nativeMagic,
  nativeExecutable,
  withServer,
  zipBuffer,
};
