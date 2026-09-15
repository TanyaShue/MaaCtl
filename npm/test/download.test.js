'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { download, downloadWithRetry, formatBytes } = require('../lib/download');
const shared = require('../lib/binary');
const { tempDir, withEnv, withEnvAsync, isolatedPackage, withServer, zipBuffer, nativeExecutable } = require('../test-support/helpers');

test('download writes the body and removes the .part file', async () => {
  const dest = path.join(tempDir(), 'maactl.exe');
  const body = Buffer.from('MZ fake executable payload');

  await withServer(
    {
      '/maactl.exe': (request, response) => {
        response.writeHead(200, { 'content-length': body.length }).end(body);
      },
    },
    async (base) => {
      await download(`${base}/maactl.exe`, dest);
    },
  );

  assert.deepEqual(fs.readFileSync(dest), body);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('download follows redirects', async () => {
  const dest = path.join(tempDir(), 'maactl.exe');
  const body = Buffer.from('MZ redirected payload');

  await withServer(
    {
      '/start': (request, response) => {
        response.writeHead(302, { location: '/redirected' }).end();
      },
      '/redirected': (request, response) => {
        response.writeHead(200).end(body);
      },
    },
    async (base) => {
      await download(`${base}/start`, dest);
    },
  );

  assert.deepEqual(fs.readFileSync(dest), body);
});

test('download reports progress and fails on HTTP errors', async () => {
  const dir = tempDir();
  const dest = path.join(dir, 'maactl.exe');
  const seen = [];

  await withServer(
    {
      '/ok': (request, response) => {
        response.writeHead(200, { 'content-length': 8 }).end('MZabcdef');
      },
    },
    async (base) => {
      await download(`${base}/ok`, dest, { onProgress: (received, total) => seen.push([received, total]) });
      await assert.rejects(download(`${base}/missing`, path.join(dir, 'other.exe')), /HTTP 404/);
    },
  );

  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1)[1], 8);
  assert.equal(fs.existsSync(path.join(dir, 'other.exe')), false);
  assert.equal(fs.existsSync(path.join(dir, 'other.exe.part')), false);
});

test('download rejects truncated responses', async () => {
  const dest = path.join(tempDir(), 'maactl.exe');

  await withServer(
    {
      '/truncated': (request, response) => {
        // Promise 40 bytes, deliver 5, then drop the connection.
        response.writeHead(200, { 'content-length': 40 });
        response.write('MZabc');
        response.destroy();
      },
    },
    async (base) => {
      await assert.rejects(download(`${base}/truncated`, dest), /truncated|aborted|socket hang up|ECONNRESET/);
    },
  );

  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('downloadWithRetry retries transient failures', async () => {
  const dest = path.join(tempDir(), 'maactl.exe');
  let attempts = 0;

  await withServer(
    {
      '/flaky': (request, response) => {
        attempts += 1;
        if (attempts < 3) {
          response.writeHead(500).end('boom');
          return;
        }
        response.writeHead(200).end('MZ ok');
      },
    },
    async (base) => {
      await downloadWithRetry(`${base}/flaky`, dest, { attempts: 3, retryDelayMs: 1 });
    },
  );

  assert.equal(attempts, 3);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'MZ ok');
});

/** The release archive the wrapper downloads: one platform, two executables. */
function fakeArchive(exe = nativeExecutable()) {
  const name = shared.executableName();
  return zipBuffer({ [name]: exe, 'maactl-lite': Buffer.from('lite') }, { mode: 0o755 });
}

test('ensureBinary downloads the release archive, unpacks and then reuses the cache', async () => {
  const payload = nativeExecutable();
  const archive = fakeArchive(payload);
  let hits = 0;
  // A fresh copy of the wrapper: no vendor/maactl.exe can short-circuit the
  // download path in a developer's working copy.
  const { binary } = isolatedPackage();
  const route = `/${binary.assetName()}`;

  await withEnvAsync({ MAACTL_HOME: tempDir() }, () => withServer(
    {
      [route]: (request, response) => {
        hits += 1;
        response.writeHead(200, { 'content-length': archive.length }).end(archive);
      },
    },
    async (base) => {
      process.env.MAACTL_BINARY_URL = `${base}${route}`;
      const lines = [];
      const verified = [];
      const downloaded = await binary.ensureBinary({
        write: (line) => lines.push(line),
        verify: (file) => verified.push(file),
      });

      assert.equal(downloaded, binary.cacheExePath());
      assert.equal(fs.statSync(downloaded).size, payload.length);
      assert.deepEqual(verified, [downloaded]);
      assert.equal(lines.length, 2, 'download start and completion are reported');
      assert.equal(fs.existsSync(binary.archivePath(downloaded)), false, 'the archive is not kept around');

      const again = await binary.ensureBinary({ verify: () => assert.fail('must not re-download') });
      assert.equal(again, downloaded);
    },
  ));

  assert.equal(hits, 1);
});

test('ensureBinary unpacks the executable with the mode the archive records', async () => {
  const { binary } = isolatedPackage();
  const archive = fakeArchive();
  const route = `/${binary.assetName()}`;

  await withEnvAsync({ MAACTL_HOME: tempDir() }, () => withServer(
    {
      [route]: (request, response) => {
        response.writeHead(200, { 'content-length': archive.length }).end(archive);
      },
    },
    async (base) => {
      process.env.MAACTL_BINARY_URL = `${base}${route}`;
      const downloaded = await binary.ensureBinary({ quiet: true, verify: () => {} });
      if (process.platform !== 'win32') {
        const mode = fs.statSync(downloaded).mode & 0o777;
        assert.ok(mode & 0o100, `the cached executable must be executable, mode is ${mode.toString(8)}`);
      }
    },
  ));
});

test('ensureBinary rejects an archive without this platform executable', async () => {
  const { binary } = isolatedPackage();
  const name = shared.executableName();
  const archive = zipBuffer({ 'maactl-lite': Buffer.from('lite') }, { mode: 0o755 });
  const route = `/${binary.assetName()}`;

  await withEnvAsync({ MAACTL_HOME: tempDir() }, () => withServer(
    {
      [route]: (request, response) => {
        response.writeHead(200, { 'content-length': archive.length }).end(archive);
      },
    },
    async (base) => {
      process.env.MAACTL_BINARY_URL = `${base}${route}`;
      await assert.rejects(binary.ensureBinary({ quiet: true }), new RegExp(`holds no ${name.replace('.', '\\.')}`));
      assert.equal(fs.existsSync(binary.archivePath()), false, 'a failed unpack must not leave the archive');
    },
  ));
});

test('ensureBinary refuses to download when MAACTL_SKIP_DOWNLOAD is set', async () => {
  const { binary } = isolatedPackage();
  await withEnvAsync({ MAACTL_HOME: tempDir(), MAACTL_SKIP_DOWNLOAD: '1' }, async () => {
    await assert.rejects(binary.ensureBinary({ quiet: true }), /MAACTL_SKIP_DOWNLOAD/);
  });
});

test('ensureBinary discards a downloaded binary that fails verification', async () => {
  const { binary } = isolatedPackage();
  const archive = fakeArchive();
  const route = `/${binary.assetName()}`;

  await withEnvAsync({ MAACTL_HOME: tempDir() }, () => withServer(
    {
      [route]: (request, response) => {
        response.writeHead(200, { 'content-length': archive.length }).end(archive);
      },
    },
    async (base) => {
      process.env.MAACTL_BINARY_URL = `${base}${route}`;
      await assert.rejects(
        binary.ensureBinary({ quiet: true, verify: () => { throw new Error('checksum mismatch'); } }),
        /checksum mismatch/,
      );
      assert.equal(fs.existsSync(binary.cacheExePath()), false, 'failed download must not be cached');
    },
  ));
});

test('formatBytes renders readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(34 * 1024 * 1024), '34.0 MiB');
});