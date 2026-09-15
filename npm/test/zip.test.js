'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { extractEntry, readEntry, entryNames } = require('../lib/zip');
const { zipBuffer } = require('../test-support/helpers');

const PAYLOAD = Buffer.from('MZ'.padEnd(4096, '\0'));

test('extractEntry reads a deflated member', () => {
  const archive = zipBuffer({ 'maactl.exe': PAYLOAD, 'maactl-lite.exe': 'lite' }, { method: 'deflate' });
  assert.deepEqual(extractEntry(archive, 'maactl.exe'), PAYLOAD);
  assert.equal(extractEntry(archive, 'maactl-lite.exe').toString(), 'lite');
});

test('extractEntry reads a stored member', () => {
  const archive = zipBuffer({ 'maactl.exe': PAYLOAD }, { method: 'stored' });
  assert.deepEqual(extractEntry(archive, 'maactl.exe'), PAYLOAD);
});

test('extractEntry returns null for a missing member and lists the names', () => {
  const archive = zipBuffer({ 'maactl.exe': PAYLOAD });
  assert.equal(extractEntry(archive, 'nope.exe'), null);
  assert.deepEqual(entryNames(archive), ['maactl.exe']);
});

test('extractEntry rejects corrupt archives', () => {
  assert.throws(() => extractEntry(Buffer.from('not a zip file'), 'maactl.exe'), /not a zip archive/);
  const archive = zipBuffer({ 'maactl.exe': PAYLOAD });
  archive.writeUInt32LE(0x01020304, 0); // damage the local header signature
  assert.throws(() => extractEntry(archive, 'maactl.exe'), /bad local header/);
});

test('readEntry reports the Unix mode an archive recorded', () => {
  const archive = zipBuffer({ maactl: PAYLOAD }, { mode: 0o755 });
  const entry = readEntry(archive, 'maactl');
  assert.deepEqual(entry.data, PAYLOAD);
  assert.equal(entry.mode, 0o755);
});

test('readEntry reports no mode for an archive written without Unix attributes', () => {
  const archive = zipBuffer({ maactl: PAYLOAD });
  assert.equal(readEntry(archive, 'maactl').mode, null);
});

test('extractEntry detects truncation and checksum damage', () => {
  const archive = zipBuffer({ 'maactl.exe': PAYLOAD });
  const truncated = archive.subarray(0, archive.length - 22);
  assert.throws(() => extractEntry(truncated, 'maactl.exe'), /end-of-central-directory/);

  const damaged = zipBuffer({ 'maactl.exe': PAYLOAD }, { method: 'stored' });
  const dataOffset = damaged.indexOf(PAYLOAD);
  damaged[dataOffset] ^= 0xff;
  assert.throws(() => extractEntry(damaged, 'maactl.exe'), /checksum mismatch/);
});
