'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const binary = require('../lib/binary');
const platforms = require('../lib/platforms');
const { tempDir, withEnv, isolatedPackage, nativeExecutable } = require('../test-support/helpers');

/** The platform id and executable name of the machine running the tests. */
const HOST = platforms.lookup();
const EXE = platforms.executable();

test('binaryUrl builds the GitHub release URL of the platform archive', () => {
  withEnv({}, () => {
    assert.equal(
      binary.binaryUrl(),
      `https://github.com/TanyaShue/MaaCtl/releases/download/v${binary.version()}/maactl-${binary.version()}-${binary.platform()}.zip`,
    );
  });
});

test('the platform follows the host unless MAACTL_PLATFORM overrides it', () => {
  withEnv({}, () => {
    assert.equal(binary.platform(), HOST.id);
    assert.equal(binary.assetName(), `maactl-${binary.version()}-${HOST.id}.zip`);
  });
  withEnv({ MAACTL_PLATFORM: 'win-aarch64' }, () => {
    assert.equal(binary.platform(), 'win-aarch64');
    assert.equal(binary.assetName(), `maactl-${binary.version()}-win-aarch64.zip`);
  });
});

test('MAACTL_ASSET bypasses the platform archive name entirely', () => {
  withEnv({ MAACTL_ASSET: 'custom.zip' }, () => {
    assert.equal(binary.assetName(), 'custom.zip');
  });
});

test('binaryUrl honours version, repo, asset and mirror overrides', () => {
  withEnv({ MAACTL_VERSION: '1.2.3-beta.1', MAACTL_REPO: 'someone/fork', MAACTL_ASSET: 'maactl-1.2.3-win-x86_64.zip' }, () => {
    assert.equal(
      binary.binaryUrl(),
      'https://github.com/someone/fork/releases/download/v1.2.3-beta.1/maactl-1.2.3-win-x86_64.zip',
    );
  });
  withEnv({ MAACTL_VERSION: 'v9.9.9', MAACTL_MIRROR: 'https://ghproxy.example/', MAACTL_PLATFORM: 'win-x86_64' }, () => {
    assert.equal(
      binary.binaryUrl(),
      'https://ghproxy.example/https://github.com/TanyaShue/MaaCtl/releases/download/v9.9.9/maactl-9.9.9-win-x86_64.zip',
    );
  });
  withEnv({ MAACTL_BINARY_URL: 'https://example.test/custom.zip', MAACTL_MIRROR: 'https://mirror.test' }, () => {
    assert.equal(binary.binaryUrl(), 'https://example.test/custom.zip');
  });
});

test('archivePath keeps the downloaded archive next to the cached executable', () => {
  withEnv({}, () => {
    const dir = path.join(os.tmpdir(), 'maactl-cache', 'npm', '1.2.3');
    assert.equal(binary.archivePath(path.join(dir, EXE)), path.join(dir, binary.assetName()));
  });
});

test('home() follows LOCALAPPDATA on Windows and XDG_CACHE_HOME elsewhere', () => {
  withEnv({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, () => {
    if (process.platform === 'win32') {
      assert.equal(binary.home(), path.resolve(path.join('C:\\Users\\tester\\AppData\\Local', 'maactl')));
    }
  });
  withEnv({ XDG_CACHE_HOME: path.join(os.tmpdir(), 'xdg-cache') }, () => {
    if (process.platform !== 'win32') {
      assert.equal(binary.home(), path.join(os.tmpdir(), 'xdg-cache', 'maactl'));
    }
  });
  withEnv({ MAACTL_HOME: path.join(os.tmpdir(), 'maactl-home') }, () => {
    assert.equal(binary.home(), path.resolve(path.join(os.tmpdir(), 'maactl-home')));
  });
});

test('cacheExePath is versioned so upgrades never reuse an old executable', () => {
  withEnv({ MAACTL_HOME: 'C:\\cache' }, () => {
    assert.equal(
      binary.cacheExePath('1.2.3'),
      path.join(path.resolve('C:\\cache'), 'npm', '1.2.3', EXE),
    );
  });
});

test('resolveBinary honours MAACTL_VERSION when picking the cache directory', () => {
  const home = tempDir();
  const { binary: subject } = isolatedPackage();
  withEnv({ MAACTL_HOME: home, MAACTL_VERSION: 'v9.9.9' }, () => {
    const cached = subject.cacheExePath();
    assert.equal(cached, path.join(home, 'npm', '9.9.9', EXE));
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, 'fake');
    assert.equal(subject.resolveBinary(), cached);
  });
});

test('resolveBinary returns null when nothing is available locally', () => {
  const { binary: subject } = isolatedPackage();
  withEnv({ MAACTL_HOME: tempDir() }, () => {
    assert.equal(subject.resolveBinary(), null);
  });
});

test('resolveBinary prefers the executable installed by the platform package', () => {
  const home = tempDir();
  const { root, binary: subject } = isolatedPackage({ platformPackage: 'installed' });
  const installed = path.join(root, 'node_modules', platforms.packageName(), 'bin', EXE);
  withEnv({ MAACTL_HOME: home }, () => {
    const cached = subject.cacheExePath();
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, 'cached');
    assert.equal(subject.resolveBinary(), installed);
  });
});

test('platformPackageExePath is null when npm installed no platform package', () => {
  const { binary: subject } = isolatedPackage();
  assert.equal(subject.platformPackageExePath(), null);
});

test('resolveBinary prefers MAACTL_BINARY and reports missing paths', () => {
  const dir = tempDir();
  const exe = path.join(dir, 'custom');
  fs.writeFileSync(exe, 'fake');

  withEnv({ MAACTL_BINARY: exe }, () => {
    assert.equal(binary.resolveBinary(), exe);
  });
  withEnv({ MAACTL_BINARY: path.join(dir, 'absent') }, () => {
    assert.throws(() => binary.resolveBinary(), /absent/);
  });
});

test('resolveBinary skips empty files', () => {
  const home = tempDir();
  const { binary: subject } = isolatedPackage();
  withEnv({ MAACTL_HOME: home }, () => {
    const cached = subject.cacheExePath();
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, '');
    assert.equal(subject.resolveBinary(), null);
  });
});

test('ensureExecutable gives an installed binary the execute bits', { skip: process.platform === 'win32' }, () => {
  const file = path.join(tempDir(), EXE);
  fs.writeFileSync(file, nativeExecutable(), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  binary.ensureExecutable(file, 'linux');
  assert.ok(fs.statSync(file).mode & 0o111, 'the binary must be executable');
});

test('ensureExecutable leaves a missing file to the caller', () => {
  assert.doesNotThrow(() => binary.ensureExecutable(path.join(tempDir(), 'absent'), 'linux'));
});

test('verifyBinary rejects a file that is not native to this platform', () => {
  const dir = tempDir();
  const bad = path.join(dir, EXE);
  fs.writeFileSync(bad, 'not an executable at all');
  assert.throws(
    () => binary.verifyBinary(bad),
    new RegExp(`not a ${platforms.formatName(process.platform)} executable`),
  );
});

test('verifyBinary rejects a truncated native executable', () => {
  const dir = tempDir();
  const small = path.join(dir, EXE);
  fs.writeFileSync(small, nativeExecutable().subarray(0, 64));
  assert.throws(() => binary.verifyBinary(small), /truncated/);
});

test('verifyBinary accepts an executable that reports its version', () => {
  const dir = tempDir();
  const fake = path.join(dir, EXE);
  fs.writeFileSync(fake, nativeExecutable());

  const calls = [];
  binary.verifyBinary(fake, {
    spawn: (file, args) => {
      calls.push([file, args]);
      return { status: 0, stdout: 'maactl version 1.2.3 (MaaFramework v5.13.0)' };
    },
  });

  assert.deepEqual(calls, [[fake, ['--version']]]);
});

test('verifyBinary surfaces a failing executable', () => {
  const dir = tempDir();
  const fake = path.join(dir, EXE);
  fs.writeFileSync(fake, nativeExecutable());

  assert.throws(
    () => binary.verifyBinary(fake, { spawn: () => ({ status: 1, stderr: 'boom' }) }),
    /unexpected output: boom/,
  );
});
