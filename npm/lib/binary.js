'use strict';

// Locating (and if necessary fetching) the maactl executable the wrapper hands
// over to.
//
// Resolution order:
//   1. MAACTL_BINARY            – an explicit path supplied by the user;
//   2. the maactl-<platform> optional dependency npm installed alongside this
//      package, which carries the prebuilt executable of this platform;
//   3. <cache>/npm/<version>/<exe> – a previous download, reused across runs.
//
// When none of them exists the release archive of this platform is downloaded
// from the GitHub release that matches the package version, the executable is
// unpacked out of it, and the result is verified and cached for the next run.
// That path only runs for hosts without a platform package (an unsupported
// platform, or an install that skipped optional dependencies).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { downloadWithRetry, formatBytes, progressReporter } = require('./download');
const env = require('./env');
const { MaactlError } = require('./errors');
const messages = require('./messages');
const platforms = require('./platforms');
const zip = require('./zip');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const PACKAGE = require(path.join(PACKAGE_ROOT, 'package.json'));

// Anything smaller than this floor is a truncated download, an HTML error page
// or a git-lfs pointer rather than an executable.
const MIN_BINARY_BYTES = 1 << 20;

// How much of a file is read to identify its format: enough for the PE, ELF,
// and Mach-O headers.
const HEADER_BYTES = 4;

const DEFAULT_REPO = 'TanyaShue/MaaCtl';

function version() {
  return (env.value('MAACTL_VERSION') || PACKAGE.version).replace(/^v/, '');
}

function tag() {
  return `v${version()}`;
}

function repo() {
  return env.value('MAACTL_REPO') || DEFAULT_REPO;
}

/** The MaaFramework platform id this run targets, or null on a host maactl has no build for. */
function platform() {
  const explicit = env.value('MAACTL_PLATFORM');
  if (explicit) {
    return explicit;
  }
  const entry = platforms.lookup();
  return entry ? entry.id : null;
}

/** File name of the executable on this host, e.g. "maactl.exe" on Windows. */
function executableName(host = process.platform) {
  return platforms.executable(host);
}

/**
 * The release asset the executable comes in: one archive per platform, holding
 * both the self-contained and the lite executable.
 */
function assetName() {
  const explicit = env.value('MAACTL_ASSET');
  if (explicit) {
    return explicit;
  }
  const id = platform();
  if (!id) {
    throw new MaactlError(messages.text('unsupportedPlatform', platforms.key()));
  }
  return `maactl-${version()}-${id}.zip`;
}

/** Cache root mirroring the CLI's own layout: %LOCALAPPDATA%\maactl on Windows. */
function home() {
  const explicit = env.value('MAACTL_HOME');
  if (explicit) {
    return path.resolve(explicit);
  }
  if (process.platform === 'win32') {
    const localAppData = env.value('LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'maactl');
  }
  const cacheHome = env.value('XDG_CACHE_HOME') || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'maactl');
}

function cacheExePath(versionOverride, host = process.platform) {
  return path.join(home(), 'npm', versionOverride || version(), executableName(host));
}

/**
 * Where the release archive is unpacked. It sits next to the cached executable
 * and is deleted as soon as the executable is written out.
 */
function archivePath(exePath = cacheExePath()) {
  return path.join(path.dirname(exePath), assetName());
}

/**
 * Path of the executable shipped by the platform package npm installed next to
 * this one, or null when it is not there.
 *
 * The platform packages are optional dependencies, so a host maactl has no build
 * for simply does not get one; `npm install --omit=optional` skips them too.
 * Resolution goes through require.resolve so that the package is found the same
 * way npm placed it, including under pnpm's or Yarn PnP's layouts.
 */
function platformPackageExePath() {
  const name = platforms.packageName();
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    return null;
  }
  const executable = path.join(path.dirname(manifest), 'bin', executableName());
  ensureExecutable(executable);
  return executable;
}

/**
 * Make sure a binary that came out of an npm install can actually be run.
 *
 * The executable bit does not survive every publish/install round trip: a
 * tarball packed on Windows records no Unix mode at all. Setting it here keeps
 * the promise that installing the package is enough to run it, whatever npm
 * did with the mode. A failure is not fatal—the file may already be executable
 * or the install read-only—so the run that follows reports the real problem.
 */
function ensureExecutable(file, host = process.platform) {
  if (host === 'win32') {
    return;
  }
  try {
    if ((fs.statSync(file).mode & 0o111) === 0) {
      fs.chmodSync(file, 0o755);
    }
  } catch {
    // Nothing to fix: the caller reports a missing or unusable file.
  }
}

function binaryUrl() {
  const direct = env.value('MAACTL_BINARY_URL');
  if (direct) {
    return direct;
  }
  const github = `https://github.com/${repo()}/releases/download/${tag()}/${assetName()}`;
  const mirror = env.value('MAACTL_MIRROR').replace(/\/+$/, '');
  return mirror ? `${mirror}/${github}` : github;
}

function isUsable(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * Return the path of an existing executable without touching the network, or
 * `null` when nothing is available locally.
 */
function resolveBinary() {
  const explicit = env.value('MAACTL_BINARY');
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) {
      throw new MaactlError(messages.text('explicitMissing', resolved));
    }
    return resolved;
  }

  return [platformPackageExePath(), cacheExePath()].find(isUsable) || null;
}

/**
 * Sanity-check a freshly downloaded executable: it must have the native format
 * of this platform, be large enough to be real, and run.
 */
function verifyBinary(file, { spawn = spawnSync, platform: host = process.platform } = {}) {
  const header = Buffer.alloc(HEADER_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, HEADER_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!platforms.matchesFormat(header, host)) {
    throw new MaactlError(messages.text('verifyFailed', file, `not a ${platforms.formatName(host)} executable`));
  }
  if (fs.statSync(file).size < MIN_BINARY_BYTES) {
    throw new MaactlError(messages.text('verifyFailed', file, 'file is truncated'));
  }

  const result = spawn(file, ['--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error) {
    throw new MaactlError(messages.text('verifyFailed', file, result.error.message), { cause: result.error });
  }
  if (result.status !== 0 || !/maactl/i.test(output)) {
    throw new MaactlError(
      messages.text('verifyFailed', file, `unexpected output: ${output || '(empty)'}`),
    );
  }
  return output;
}

/**
 * Unpack the executable out of the downloaded release archive and write it to
 * dest, making sure it is executable.
 */
function writeExecutable(archive, dest, host = process.platform) {
  const data = fs.readFileSync(archive);
  const name = executableName(host);
  const entry = zip.readEntry(data, name);
  if (!entry) {
    throw new Error(`${archive} holds no ${name} (contains: ${zip.entryNames(data).join(', ') || 'nothing'})`);
  }
  fs.writeFileSync(dest, entry.data, { mode: entry.mode || 0o755 });
  if (host !== 'win32') {
    // The zip records 0755 for the executables the release builds, but an
    // archive written without Unix attributes has none, and the umask can strip
    // bits from the mode passed to writeFileSync. The binary has to be
    // executable, so make sure of it.
    ensureExecutable(dest, host);
  }
}

/**
 * Download the release archive and cache the executable inside it, unless a
 * local copy already exists. `write(text)` receives human readable progress
 * lines; pass `quiet` to suppress them.
 */
async function ensureBinary({ write = () => {}, quiet = false, verify = verifyBinary } = {}) {
  const existing = resolveBinary();
  if (existing) {
    return existing;
  }
  if (env.flag('MAACTL_SKIP_DOWNLOAD')) {
    throw new MaactlError(messages.text('downloadDisabled'));
  }

  const dest = cacheExePath();
  const archive = archivePath(dest);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (error) {
    throw new MaactlError(`${messages.text('downloadFailed', binaryUrl(), error.message)}\n  cache: ${dest}`, {
      cause: error,
    });
  }

  const url = binaryUrl();
  const showProgress = !quiet && Boolean(process.stderr.isTTY);
  if (!quiet) {
    write(messages.text('downloading', url));
  }

  const onProgress = showProgress ? progressReporter() : undefined;
  try {
    await downloadWithRetry(url, archive, {
      onProgress,
      onRetry: (attempt, attempts, error) => {
        if (!quiet) {
          write(`maactl: retrying download (${attempt}/${attempts - 1}) after: ${error.message}`);
        }
      },
    });
  } catch (error) {
    if (!quiet && onProgress) {
      process.stderr.write('\n');
    }
    throw new MaactlError(messages.text('downloadFailed', url, error.message), { cause: error });
  }
  if (onProgress) {
    process.stderr.write('\n');
  }

  try {
    writeExecutable(archive, dest);
  } catch (error) {
    throw new MaactlError(messages.text('extractFailed', archive, error.message), { cause: error });
  } finally {
    // The archive is only ever needed to produce the executable; keeping it
    // would double the cache size for nothing.
    fs.rmSync(archive, { force: true });
  }
  try {
    verify(dest);
  } catch (error) {
    fs.rmSync(dest, { force: true });
    throw error;
  }

  const size = formatBytes(fs.statSync(dest).size);
  if (!quiet) {
    write(messages.text('downloaded', size, dest));
  }
  return dest;
}

/** Print the executable the wrapper will hand over to, when MAACTL_VERBOSE is set. */
function verbose() {
  return env.flag('MAACTL_VERBOSE');
}

module.exports = {
  PACKAGE,
  PACKAGE_ROOT,
  MIN_BINARY_BYTES,
  executableName,
  version,
  tag,
  repo,
  platform,
  assetName,
  home,
  cacheExePath,
  archivePath,
  platformPackageExePath,
  ensureExecutable,
  binaryUrl,
  resolveBinary,
  ensureBinary,
  verifyBinary,
  verbose,
};
