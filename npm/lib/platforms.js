'use strict';

// Every platform maactl publishes a prebuilt executable for.
//
// The keys are Node's own names ("<process.platform>-<process.arch>"), because
// that is what the wrapper has to match at runtime and what the platform
// packages are named after. Each entry also carries the MaaFramework platform
// id, which is how the Go side and the release assets spell the same platform
// ("win-x86_64").
//
// This table is the single source of truth: lib/binary.js uses it to resolve
// the executable, scripts/platform-packages.js uses it to publish the optional
// dependencies, and the tests assert the manifest against it.

const PLATFORMS = {
  'win32-x64': { id: 'win-x86_64', os: 'win32', cpu: 'x64' },
  'win32-arm64': { id: 'win-aarch64', os: 'win32', cpu: 'arm64' },
  'linux-x64': { id: 'linux-x86_64', os: 'linux', cpu: 'x64' },
  'linux-arm64': { id: 'linux-aarch64', os: 'linux', cpu: 'arm64' },
  'darwin-x64': { id: 'macos-x86_64', os: 'darwin', cpu: 'x64' },
  'darwin-arm64': { id: 'macos-aarch64', os: 'darwin', cpu: 'arm64' },
};

// Mach-O magic numbers, read big-endian: thin 32/64-bit in both byte orders and
// the universal (fat) header. Prebuilt maactl executables are little-endian and
// thin, but accepting a universal binary costs nothing.
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

/** Node key of a platform, e.g. "win32-x64". */
function key(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * One platform as the flat record everything else works with:
 * `{ key, package, id, os, cpu }`, or null when maactl has no build for it.
 * `package` is the npm package carrying that platform's executable.
 */
function entry(platformKey) {
  const known = PLATFORMS[platformKey];
  if (!known) {
    return null;
  }
  return { key: platformKey, package: `maactl-${platformKey}`, ...known };
}

/** The entry for a platform, or null when maactl has no build for it. */
function lookup(platform = process.platform, arch = process.arch) {
  return entry(key(platform, arch));
}

/** Every known platform, in declaration order. */
function all() {
  return Object.keys(PLATFORMS).map(entry);
}

/** Name of the npm package carrying a platform's executable. */
function packageName(platform = process.platform, arch = process.arch) {
  return `maactl-${key(platform, arch)}`;
}

/** File name of the self-contained executable on a platform. */
function executable(platform = process.platform) {
  return platform === 'win32' ? 'maactl.exe' : 'maactl';
}

/** Human readable name of a platform's executable format. */
function formatName(platform) {
  switch (platform) {
    case 'win32':
      return 'Windows PE';
    case 'linux':
      return 'ELF';
    case 'darwin':
      return 'Mach-O';
    default:
      return 'native';
  }
}

/**
 * Whether the leading bytes of a file match the executable format of a
 * platform. The wrapper checks downloads with this before caching them, so a
 * truncated file, an HTML error page, or a release asset of the wrong platform
 * is rejected here instead of being handed to the shell much later.
 */
function matchesFormat(head, platform) {
  if (!Buffer.isBuffer(head)) {
    return false;
  }
  switch (platform) {
    case 'win32':
      // Every PE file starts with the DOS stub's "MZ".
      return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
    case 'linux':
      return head.length >= 4 && head.subarray(0, 4).equals(ELF_MAGIC);
    case 'darwin':
      return head.length >= 4 && MACHO_MAGICS.has(head.readUInt32BE(0));
    default:
      return false;
  }
}

module.exports = { all, executable, formatName, key, lookup, matchesFormat, packageName };
