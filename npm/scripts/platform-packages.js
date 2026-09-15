#!/usr/bin/env node
'use strict';

// Manage the per-platform npm packages that carry maactl's prebuilt executables.
//
// The published `maactl` package has no binary of its own. It declares one
// optional dependency per platform, and npm installs only the one matching the
// machine it runs on. That is what makes `npx maactl` work right after install,
// on every platform, without downloading anything.
//
// Subcommands:
//   prepare --dist <dir>   build the platform packages from the release zips
//   link <exe>             install this host's platform package into node_modules
//   sync-version           pin optionalDependencies to this package's version
//   check                  assert the manifest lists exactly the known platforms
//   publish [--tag <t>]    npm publish every prepared platform package
//
// `prepare` is what the release pipeline runs; `link` is for working on the
// wrapper locally, where no published platform package exists yet.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { MIN_BINARY_BYTES } = require('../lib/binary');
const platforms = require('../lib/platforms');
const zip = require('../lib/zip');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'package.json');
const DEFAULT_OUT = path.join(ROOT, 'platforms');

const OS_TITLES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
const CPU_TITLES = { x64: 'x64', arm64: 'arm64' };

class UsageError extends Error {}

/** The wrapper's own manifest, re-read so concurrent bumps are picked up. */
function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Human readable platform name for descriptions and log lines. */
function describe(entry) {
  return `${OS_TITLES[entry.os] || entry.os} ${CPU_TITLES[entry.cpu] || entry.cpu} (${entry.id})`;
}

/** The manifest published for one platform package. */
function platformManifest(entry, version, wrapper) {
  return {
    name: entry.package,
    version,
    description: `maactl prebuilt executable for ${describe(entry)}; installed automatically by the maactl package`,
    license: wrapper.license,
    homepage: wrapper.homepage,
    repository: wrapper.repository,
    bugs: wrapper.bugs,
    os: [entry.os],
    cpu: [entry.cpu],
    files: ['bin/'],
    // Yarn PnP has to unpack the executable before it can be run from a zip.
    preferUnplugged: true,
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  };
}

function platformReadme(entry, executable) {
  return [
    `# ${entry.package}`,
    '',
    `The maactl executable for ${describe(entry)}.`,
    '',
    'This package is installed automatically as an optional dependency of',
    '[`maactl`](https://www.npmjs.com/package/maactl); install that one instead:',
    '',
    '```sh',
    'npx maactl --version',
    '```',
    '',
    `It ships a single file, \`bin/${executable}\`, built from the MaaCtl release it`,
    'is versioned with.',
    '',
  ].join('\n');
}

/** Write one platform package directory under `out`. */
function writePlatformPackage(entry, version, wrapper, executable, data, out) {
  const dir = path.join(out, entry.package);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const binaryPath = path.join(dir, 'bin', executable);
  fs.writeFileSync(binaryPath, data, { mode: 0o755 });
  if (process.platform !== 'win32') {
    // Publishing from a POSIX host then records the execute bits in the tarball.
    // (The wrapper also fixes them after an install, because a tarball packed on
    // Windows carries no Unix mode at all.)
    fs.chmodSync(binaryPath, 0o755);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(platformManifest(entry, version, wrapper), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), platformReadme(entry, executable));
  return dir;
}

/** Reject a member that is not a plausible executable of that platform. */
function assertExecutable(data, entry, source, executable) {
  if (data.length < MIN_BINARY_BYTES) {
    throw new Error(`${source}: ${executable} is truncated (${data.length} bytes)`);
  }
  if (!platforms.matchesFormat(data.subarray(0, 4), entry.os)) {
    throw new Error(`${source}: ${executable} is not a ${platforms.formatName(entry.os)} executable`);
  }
}

/**
 * Build every platform package from the release archives of this version.
 * Nothing is executed here: the release workflow already ran each executable on
 * its own runner, and a runner can only execute its own platform's binaries.
 */
function prepare({ dist, out }) {
  const wrapper = readManifest();
  const version = wrapper.version;
  if (!version) {
    throw new Error('package.json has no version');
  }
  fs.mkdirSync(out, { recursive: true });

  const built = [];
  for (const entry of platforms.all()) {
    const executable = platforms.executable(entry.os);
    const archive = path.join(dist, `maactl-${version}-${entry.id}.zip`);
    if (!fs.existsSync(archive)) {
      throw new Error(`missing release archive ${archive}; publish the release for v${version} first`);
    }
    const container = fs.readFileSync(archive);
    const member = zip.readEntry(container, executable);
    if (!member) {
      throw new Error(`${archive} holds no ${executable} (contains: ${zip.entryNames(container).join(', ') || 'nothing'})`);
    }
    assertExecutable(member.data, entry, archive, executable);
    const dir = writePlatformPackage(entry, version, wrapper, executable, member.data, out);
    built.push(`${entry.package} (${(member.data.length / (1024 * 1024)).toFixed(1)} MiB)`);
    process.stdout.write(`prepared ${entry.package} for ${describe(entry)} -> ${dir}\n`);
  }
  process.stdout.write(`\n${built.length} platform packages at version ${version} in ${out}\n`);
  return 0;
}

/**
 * Install this host's platform package into node_modules from a local
 * executable, so the wrapper resolves it exactly as it would after an install.
 */
function link({ executable, force }) {
  const entry = platforms.lookup();
  if (!entry) {
    throw new Error(`no platform package is defined for ${platforms.key()}`);
  }
  const source = path.resolve(executable);
  if (!fs.existsSync(source)) {
    throw new Error(`executable not found: ${source}\nbuild it first, e.g. go build -tags bundled -o ${platforms.executable()} ./cmd/maactl`);
  }
  const dir = path.join(ROOT, 'node_modules', entry.package);
  if (fs.existsSync(dir) && !force) {
    throw new Error(`${dir} already exists; pass --force to replace it`);
  }
  const wrapper = readManifest();
  const name = platforms.executable();
  const data = fs.readFileSync(source);
  writePlatformPackage(entry, wrapper.version, wrapper, name, data, path.join(ROOT, 'node_modules'));
  process.stdout.write(`linked ${source} as ${entry.package}\n  ${path.join(dir, 'bin', name)}\n`);
  return 0;
}

/** Pin every optional dependency to this package's own version. */
function syncVersion() {
  const wrapper = readManifest();
  const dependencies = {};
  for (const entry of platforms.all()) {
    dependencies[entry.package] = wrapper.version;
  }
  wrapper.optionalDependencies = dependencies;
  writeManifest(wrapper);
  process.stdout.write(`optionalDependencies pinned to ${wrapper.version}\n`);
  return 0;
}

/** Assert the manifest matches the platform table; the publish gate. */
function check() {
  const wrapper = readManifest();
  const dependencies = wrapper.optionalDependencies || {};
  const problems = [];

  for (const entry of platforms.all()) {
    const pinned = dependencies[entry.package];
    if (pinned === undefined) {
      problems.push(`optionalDependencies is missing ${entry.package}`);
    } else if (pinned !== wrapper.version) {
      problems.push(`${entry.package} is pinned to ${pinned}, expected ${wrapper.version}`);
    }
  }
  for (const name of Object.keys(dependencies)) {
    if (!platforms.all().some((entry) => entry.package === name)) {
      problems.push(`optionalDependencies has an unknown entry ${name}`);
    }
  }
  if (wrapper.os) {
    problems.push('"os" must not be set: the wrapper runs on every platform (the platform packages restrict it)');
  }
  if (wrapper.scripts && wrapper.scripts.postinstall) {
    problems.push('the postinstall hook is gone: platform packages deliver the executable');
  }

  if (problems.length > 0) {
    throw new Error(`package.json is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  process.stdout.write(`package.json lists all ${platforms.all().length} platform packages at ${wrapper.version}\n`);
  return 0;
}

/** The npm CLI to run: npm runs this script, so npm_execpath points at it. */
function npmInvocation() {
  const execpath = process.env.npm_execpath;
  if (execpath && fs.existsSync(execpath)) {
    return { command: process.execPath, args: [execpath] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

/** Publish every prepared platform package, then leave the wrapper to the caller. */
function publish({ dir, tag, dryRun }) {
  const wrapper = readManifest();
  const invocation = npmInvocation();
  for (const entry of platforms.all()) {
    const packageDir = path.join(dir, entry.package);
    if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
      throw new Error(`${packageDir} is not prepared; run prepare first`);
    }
    const args = [...invocation.args, 'publish', packageDir, '--access', 'public', '--tag', tag];
    if (process.env.GITHUB_ACTIONS === 'true') {
      // Provenance needs an OIDC token, which only the CI providers hand out.
      args.push('--provenance');
    }
    if (dryRun) {
      args.push('--dry-run');
    }
    process.stdout.write(`$ npm ${args.slice(invocation.args.length).join(' ')}\n`);
    const result = spawnSync(invocation.command, args, { stdio: 'inherit', shell: invocation.shell });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`npm publish failed for ${entry.package} (exit ${result.status})`);
    }
  }
  process.stdout.write(`\npublished ${platforms.all().length} platform packages at ${wrapper.version} (dist-tag ${tag})\n`);
  return 0;
}

const USAGE = `usage: node scripts/platform-packages.js <command> [options]

commands:
  prepare [--dist <dir>] [--out <dir>]   build the platform packages from the release zips (default: ../dist, ./platforms)
  link <executable> [--force]            install this host's platform package from a local build
  sync-version                           pin optionalDependencies to this package's version
  check                                  assert package.json lists exactly the known platforms
  publish [--dir <dir>] [--tag <tag>] [--dry-run]
                                         npm publish every prepared platform package (default dist-tag: latest)
`;

/** Parse `--name value` / `--flag` arguments into options plus positionals. */
function parseArgs(argv, flags) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${arg} needs a value`);
    }
    options[name] = value;
    index += 1;
  }
  return { options, positionals };
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'prepare': {
      const { options } = parseArgs(rest, new Set());
      return prepare({ dist: path.resolve(options.dist || path.join(ROOT, '..', 'dist')), out: path.resolve(options.out || DEFAULT_OUT) });
    }
    case 'link': {
      const { options, positionals } = parseArgs(rest, new Set(['force']));
      if (positionals.length !== 1) {
        throw new UsageError('link needs exactly one executable path');
      }
      return link({ executable: positionals[0], force: Boolean(options.force) });
    }
    case 'sync-version':
      return syncVersion();
    case 'check':
      return check();
    case 'publish': {
      const { options } = parseArgs(rest, new Set(['dry-run']));
      return publish({
        dir: path.resolve(options.dir || DEFAULT_OUT),
        tag: options.tag || 'latest',
        dryRun: Boolean(options['dry-run']),
      });
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`platform-packages: ${error.message}\n\n${USAGE}`);
  } else {
    process.stderr.write(`platform-packages: ${error.message}\n`);
    if (process.env.MAACTL_DEBUG) {
      process.stderr.write(`${error.stack}\n`);
    }
  }
  process.exitCode = 1;
}
