'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const platforms = require('../lib/platforms');
const pkg = require('../package.json');
const { tempDir, zipBuffer, nativeMagic } = require('../test-support/helpers');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'platform-packages.js');

/** Run the packaging tool exactly as the release pipeline does. */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** A release archive for one platform, as build_release.py produces it. */
function releaseArchive(entry) {
  const name = platforms.executable(entry.os);
  const payload = Buffer.concat([nativeMagic(entry.os), Buffer.alloc((1 << 20) + 4, 0x41)]);
  return zipBuffer({ [name]: payload, 'maactl-lite': Buffer.from('lite') }, { mode: 0o755 });
}

/** Fill a directory with the release archive of every platform of this version. */
function writeReleaseArchives(dist, { payload = null } = {}) {
  for (const entry of platforms.all()) {
    const name = platforms.executable(entry.os);
    const body = payload
      ? Buffer.concat([payload, Buffer.alloc((1 << 20) + 4, 0x41)])
      : null;
    const archive = body
      ? zipBuffer({ [name]: body }, { mode: 0o755 })
      : releaseArchive(entry);
    fs.writeFileSync(path.join(dist, `maactl-${pkg.version}-${entry.id}.zip`), archive);
  }
}

test('check accepts the committed manifest', () => {
  const result = run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 platform packages/);
});

test('prepare builds one package per platform from the release archives', () => {
  const dist = tempDir('maactl-dist-');
  const out = tempDir('maactl-platforms-');
  writeReleaseArchives(dist);

  const result = run(['prepare', '--dist', dist, '--out', out]);
  assert.equal(result.status, 0, result.stderr);

  for (const entry of platforms.all()) {
    const dir = path.join(out, entry.package);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, entry.package);
    assert.equal(manifest.version, pkg.version);
    assert.deepEqual(manifest.os, [entry.os]);
    assert.deepEqual(manifest.cpu, [entry.cpu]);
    assert.deepEqual(manifest.files, ['bin/']);
    assert.equal(manifest.private, undefined, 'platform packages must be publishable');

    const executable = path.join(dir, 'bin', platforms.executable(entry.os));
    assert.ok(fs.statSync(executable).size >= 1 << 20, `${executable} must carry the executable`);
    assert.ok(platforms.matchesFormat(fs.readFileSync(executable).subarray(0, 4), entry.os));
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  }
});

test('prepare fails when a platform archive is missing', () => {
  const result = run(['prepare', '--dist', tempDir('maactl-dist-'), '--out', tempDir('maactl-platforms-')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing release archive/);
});

test('prepare rejects an archive whose executable is not native to that platform', () => {
  const dist = tempDir('maactl-dist-');
  // Every archive gets a Windows payload, so the ELF and Mach-O platforms are wrong.
  writeReleaseArchives(dist, { payload: nativeMagic('win32') });

  const result = run(['prepare', '--dist', dist, '--out', tempDir('maactl-platforms-')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a (ELF|Mach-O) executable/);
});

test('publish refuses to run before prepare', () => {
  const result = run(['publish', '--dir', tempDir('maactl-platforms-')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not prepared/);
});
