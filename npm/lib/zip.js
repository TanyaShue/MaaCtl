'use strict';

// Minimal ZIP reader for the maactl release archives.
//
// The release publishes one archive per platform, and the wrapper needs exactly
// one member out of it: maactl.exe. Node ships no zip API, but zlib covers the
// compression method release archives use, so a small central-directory reader
// is all that is missing.
//
// Only what the wrapper needs is implemented: no Zip64 (archives are far below
// 4 GiB), no encryption, and no writing.

const zlib = require('node:zlib');

const SIGNATURE_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SIGNATURE_CENTRAL_FILE = 0x02014b50;
const SIGNATURE_LOCAL_FILE = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
// Zip64 marks overflowing fields with this value instead of writing them here.
const ZIP64_MARKER = 0xffffffff;

/** Locate the end-of-central-directory record, which closes every archive. */
function endOfCentralDirectory(archive) {
  const earliest = Math.max(0, archive.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_SIZE);
  for (let offset = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === SIGNATURE_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error('not a zip archive: no end-of-central-directory record');
}

/** List the central directory entries, in file order. */
function entries(archive) {
  const end = endOfCentralDirectory(archive);
  let count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  if (offset === ZIP64_MARKER || archive.readUInt32LE(end + 12) === ZIP64_MARKER || count === 0xffff) {
    throw new Error('Zip64 archives are not supported');
  }
  const found = [];
  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(offset) !== SIGNATURE_CENTRAL_FILE) {
      throw new Error('corrupt zip archive: bad central directory entry');
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new Error(`Zip64 archives are not supported (${name})`);
    }
    found.push({
      name,
      method,
      checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
      mode: unixMode(versionMadeBy, externalAttributes),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/**
 * The Unix permission bits a central directory entry records, or null.
 *
 * The high byte of "version made by" names the host that wrote the entry, and
 * only Unix hosts store a mode in the high 16 bits of external_attr. Archives
 * written on Windows carry none, so callers must have a sensible default.
 */
function unixMode(versionMadeBy, externalAttributes) {
  if ((versionMadeBy >> 8) !== 3) {
    return null;
  }
  const mode = (externalAttributes >>> 16) & 0o7777;
  return mode === 0 ? null : mode;
}

/** Read one member of an archive, decompressing it. */
function extractEntry(archive, name) {
  const entry = readEntry(archive, name);
  return entry ? entry.data : null;
}

/**
 * Read one member of an archive, returning its bytes together with the Unix
 * mode it records (null when the archive was not written on a Unix host).
 */
function readEntry(archive, name) {
  const entry = entries(archive).find((candidate) => candidate.name === name);
  if (!entry) {
    return null;
  }
  const local = entry.localOffset;
  if (archive.readUInt32LE(local) !== SIGNATURE_LOCAL_FILE) {
    throw new Error(`corrupt zip archive: bad local header for ${name}`);
  }
  const nameLength = archive.readUInt16LE(local + 26);
  const extraLength = archive.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  let payload;
  switch (entry.method) {
    case METHOD_STORED:
      payload = Buffer.from(compressed);
      break;
    case METHOD_DEFLATE:
      payload = zlib.inflateRawSync(compressed);
      break;
    default:
      throw new Error(`unsupported compression method ${entry.method} for ${name}`);
  }
  if (payload.length !== entry.uncompressedSize) {
    throw new Error(`truncated zip member ${name}: got ${payload.length} of ${entry.uncompressedSize} bytes`);
  }
  // zlib.crc32 exists on Node 22; the explicit length check above already caught
  // truncation, so a missing implementation only loses an extra safety net.
  if (typeof zlib.crc32 === 'function' && zlib.crc32(payload) !== entry.checksum) {
    throw new Error(`checksum mismatch for ${name}`);
  }
  return { data: payload, mode: entry.mode };
}

/** List the member names of an archive, which is handy in error messages. */
function entryNames(archive) {
  return entries(archive).map((entry) => entry.name);
}

module.exports = { extractEntry, readEntry, entryNames };
