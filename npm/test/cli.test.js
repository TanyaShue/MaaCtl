'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');

const { main, runBinary } = require('../lib/cli');

/** A child-process stand-in that records how it was started. */
function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal);
    return true;
  };
  return child;
}

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.killed = [];
  proc.kill = (pid, signal) => {
    proc.killed.push([pid, signal]);
    return true;
  };
  return proc;
}

function spawnRecorder(child) {
  const calls = [];
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    markSpawned();
    return child;
  };
  return { spawnImpl, calls, spawned };
}

const EXE = 'C:\\cache\\maactl.exe';

test('runBinary forwards every argument verbatim and inherits stdio', async () => {
  const child = fakeChild();
  const { spawnImpl, calls, spawned } = spawnRecorder(child);
  const argv = ['run', 'task', '自动挂机卖蛋', '-f', 'D:\\01_Projects\\github\\MaaMio', '--stop-after', '10s'];

  const pending = runBinary(EXE, argv, { spawn: spawnImpl, platform: 'win32', process: fakeProcess() });
  await spawned;
  child.exitCode = 0;
  child.emit('exit', 0, null);

  assert.equal(await pending, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, EXE);
  assert.deepEqual(calls[0].args, argv);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.windowsHide, false);
});

test('runBinary relays the child exit code', async () => {
  const child = fakeChild();
  const { spawnImpl, spawned } = spawnRecorder(child);

  const pending = runBinary(EXE, ['--version'], { spawn: spawnImpl, platform: 'win32', process: fakeProcess() });
  await spawned;
  child.exitCode = 3;
  child.emit('exit', 3, null);

  assert.equal(await pending, 3);
});

test('runBinary reports spawn failures with the executable path', async () => {
  const child = fakeChild();
  const { spawnImpl, spawned } = spawnRecorder(child);

  const pending = runBinary(EXE, [], { spawn: spawnImpl, platform: 'win32', process: fakeProcess() });
  await spawned;
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  child.emit('error', error);

  await assert.rejects(pending, /could not start maactl|无法启动 maactl/);
});

test('runBinary keeps the shim alive for the first Ctrl+C on Windows', async () => {
  const child = fakeChild();
  const { spawnImpl, spawned } = spawnRecorder(child);
  const proc = fakeProcess();

  const pending = runBinary(EXE, [], { spawn: spawnImpl, platform: 'win32', process: proc });
  await spawned;
  assert.equal(proc.listenerCount('SIGINT'), 1);

  // The console already told the child; the shim stays alive to report its exit
  // code and re-arms the default behaviour so a second Ctrl+C can force-quit.
  proc.emit('SIGINT');
  assert.deepEqual(child.killed, []);
  assert.equal(proc.listenerCount('SIGINT'), 0);
  assert.equal(proc.listenerCount('SIGBREAK'), 0);

  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(await pending, 0);
});

test('runBinary forwards POSIX signals to the child', async () => {
  const child = fakeChild();
  const { spawnImpl, spawned } = spawnRecorder(child);
  const proc = fakeProcess();

  const pending = runBinary(EXE, [], { spawn: spawnImpl, platform: 'linux', process: proc });
  await spawned;
  proc.emit('SIGTERM');
  assert.deepEqual(child.killed, ['SIGTERM']);

  child.exitCode = 0;
  child.emit('exit', 0, null);
  await pending;
});

test('runBinary re-raises the signal when the child is killed', async () => {
  const child = fakeChild();
  const { spawnImpl, spawned } = spawnRecorder(child);
  const proc = fakeProcess();

  const pending = runBinary(EXE, [], { spawn: spawnImpl, platform: 'linux', process: proc });
  await spawned;
  child.signalCode = 'SIGTERM';
  child.emit('exit', null, 'SIGTERM');

  assert.equal(await pending, 1);
  assert.deepEqual(proc.killed, [[proc.pid, 'SIGTERM']]);
});

test('main runs the resolved executable without downloading', async () => {
  const child = fakeChild();
  const { spawnImpl, calls, spawned } = spawnRecorder(child);
  let downloaded = 0;

  const pending = main(['interface', '--tasks'], {
    resolveBinary: () => EXE,
    ensureBinary: async () => {
      downloaded += 1;
      return EXE;
    },
    spawn: spawnImpl,
    platform: 'win32',
    process: fakeProcess(),
    write: () => {},
  });
  await spawned;
  child.exitCode = 0;
  child.emit('exit', 0, null);

  assert.equal(await pending, 0);
  assert.equal(downloaded, 0);
  assert.deepEqual(calls[0].args, ['interface', '--tasks']);
});

test('main downloads once when no local executable exists', async () => {
  const child = fakeChild();
  const { spawnImpl, spawned } = spawnRecorder(child);
  const lines = [];
  let downloads = 0;

  const pending = main(['-v'], {
    resolveBinary: () => null,
    ensureBinary: async ({ write }) => {
      downloads += 1;
      write('maactl: downloading');
      return EXE;
    },
    spawn: spawnImpl,
    platform: 'win32',
    process: fakeProcess(),
    write: (line) => lines.push(line),
  });
  await spawned;
  child.exitCode = 0;
  child.emit('exit', 0, null);

  assert.equal(await pending, 0);
  assert.equal(downloads, 1);
  assert.deepEqual(lines, ['maactl: downloading']);
});

test('main explains how to recover when the executable cannot be fetched', async () => {
  await assert.rejects(
    main([], {
      resolveBinary: () => null,
      ensureBinary: async () => {
        throw new Error('HTTP 404 Not Found');
      },
      write: () => {},
    }),
    (error) => {
      assert.match(error.message, /HTTP 404 Not Found/);
      assert.match(error.message, /MAACTL_BINARY/);
      return true;
    },
  );
});
