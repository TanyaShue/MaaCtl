'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const platforms = require('../lib/platforms');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');

test('the package exposes the maactl bin shim', () => {
  assert.equal(pkg.name, 'maactl');
  assert.equal(pkg.bin.maactl, 'bin/maactl.js');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin.maactl)));
});

test('the bin shim is executable-looking and dependency free', () => {
  const source = fs.readFileSync(path.join(ROOT, pkg.bin.maactl), 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node'), 'shebang is required for the POSIX wrapper');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('the package runs everywhere and needs Node 22+', () => {
  // The wrapper itself is portable; which platforms can actually run is decided
  // by the optional dependencies below, not by an "os" restriction here.
  assert.equal(pkg.os, undefined);
  assert.equal(pkg.engines.node, '>=22');
});

test('one optional dependency carries the executable of every known platform', () => {
  const expected = Object.fromEntries(platforms.all().map((entry) => [entry.package, pkg.version]));
  assert.deepEqual(pkg.optionalDependencies, expected);
});

test('no postinstall hook: installing never has to touch the network', () => {
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.scripts.install, undefined);
});

test('bumping the version re-pins the platform packages', () => {
  assert.equal(pkg.scripts.version, 'node scripts/platform-packages.js sync-version');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'platform-packages.js')));
});

test('the tarball publishes the wrapper only, not the tooling or a vendored exe', () => {
  assert.deepEqual([...pkg.files].sort(), ['README.md', 'bin/', 'lib/']);
});

test('the version is a publishable semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
