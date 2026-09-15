'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const platforms = require('../lib/platforms');

test('every platform has a unique Node key, package name and MaaFramework id', () => {
  const all = platforms.all();
  assert.equal(all.length, 6);
  for (const field of ['key', 'package', 'id']) {
    assert.equal(new Set(all.map((entry) => entry[field])).size, all.length, `${field} must be unique`);
  }
  for (const entry of all) {
    assert.equal(entry.key, `${entry.os}-${entry.cpu}`);
    assert.equal(entry.package, `maactl-${entry.key}`);
    assert.match(entry.id, /^(win|linux|macos)-(x86_64|aarch64)$/);
  }
});

test('the platform ids are exactly the ones MaaFramework publishes releases for', () => {
  assert.deepEqual(
    platforms.all().map((entry) => entry.id).sort(),
    ['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64', 'win-aarch64', 'win-x86_64'],
  );
});

test('the Node keys cover both architectures of the three desktop systems', () => {
  assert.deepEqual(
    platforms.all().map((entry) => entry.key).sort(),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'],
  );
});

test('lookup returns the same enriched record as all(), package name included', () => {
  const host = platforms.lookup();
  assert.deepEqual(host, platforms.all().find((entry) => entry.key === host.key));
  assert.equal(platforms.lookup('win32', 'x64').package, 'maactl-win32-x64');
});

test('lookup maps a host onto its platform, and unknown hosts onto null', () => {
  assert.equal(platforms.lookup('win32', 'x64').id, 'win-x86_64');
  assert.equal(platforms.lookup('darwin', 'arm64').id, 'macos-aarch64');
  assert.deepEqual(platforms.lookup(), platforms.lookup(process.platform, process.arch));
  assert.equal(platforms.key('win32', 'arm64'), 'win32-arm64');
  assert.equal(platforms.packageName('linux', 'arm64'), 'maactl-linux-arm64');
  assert.equal(platforms.lookup('freebsd', 'x64'), null);
  assert.equal(platforms.lookup('linux', 'ia32'), null);
});

test('executable names carry the Windows suffix only on Windows', () => {
  assert.equal(platforms.executable('win32'), 'maactl.exe');
  assert.equal(platforms.executable('linux'), 'maactl');
  assert.equal(platforms.executable('darwin'), 'maactl');
});

test('matchesFormat accepts the native format and rejects every other one', () => {
  const samples = {
    win32: Buffer.from('MZ..'),
    linux: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    darwin: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  };
  for (const [os, magic] of Object.entries(samples)) {
    assert.ok(platforms.matchesFormat(magic, os), `the ${os} magic must match ${os}`);
    for (const other of Object.keys(samples)) {
      if (other !== os) {
        assert.ok(!platforms.matchesFormat(magic, other), `the ${os} magic must not match ${other}`);
      }
    }
  }
});

test('matchesFormat rejects universal Mach-O, HTML errors and short reads', () => {
  assert.ok(platforms.matchesFormat(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 'darwin'), 'a fat binary is still Mach-O');
  assert.ok(!platforms.matchesFormat(Buffer.from('<!DO'), 'linux'), 'an error page is not an executable');
  assert.ok(!platforms.matchesFormat(Buffer.alloc(0), 'win32'));
  assert.ok(!platforms.matchesFormat('MZ', 'win32'), 'a string is not a buffer');
});
