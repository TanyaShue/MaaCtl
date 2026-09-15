'use strict';

// The wrapper only prints text for error and progress paths, so the message
// catalogue stays small. Language follows MAACTL_LANG, the same variable the
// CLI itself honours; anything not starting with "zh" falls back to English.

const MESSAGES = {
  zh: {
    downloading: (url) => `maactl: 首次使用，正在下载 ${url.split('/').pop()}\n  ${url}`,
    downloaded: (size, dest) => `maactl: 已下载 ${size} 到 ${dest}`,
    downloadFailed: (url, reason) => `maactl: 下载发布包失败\n  ${url}\n  原因: ${reason}`,
    extractFailed: (archive, reason) => `maactl: 解压 release 压缩包失败\n  ${archive}\n  原因: ${reason}`,
    verifyFailed: (file, reason) => `maactl: 可执行文件校验失败 (${file})\n  原因: ${reason}`,
    explicitMissing: (file) => `maactl: MAACTL_BINARY 指向的文件不存在: ${file}`,
    spawnFailed: (file, reason) => `maactl: 无法启动 maactl (${file})\n  原因: ${reason}`,
    unsupportedPlatform: (host) =>
      `maactl: 当前平台没有预编译的可执行文件: ${host}\n  MaaCtl 只提供 win32/linux/darwin 上的 x64 与 arm64 构建。`,
    downloadDisabled: () => 'maactl: 已设置 MAACTL_SKIP_DOWNLOAD，本地没有可用的 maactl，且不允许联网下载',
    resolveHint: () =>
      [
        'maactl: 找不到可执行的 maactl。可用的解决办法：',
        '  1. 设置 MAACTL_BINARY 指向本地已有的可执行文件；',
        '  2. 重新安装（可选依赖可能被 --omit=optional 跳过或安装失败）：npm install maactl；',
        '  3. 检查网络后重试，或设置 MAACTL_MIRROR 使用镜像下载 maactl-<版本>-<平台>.zip。',
      ].join('\n'),
    usingBinary: (file) => `maactl: 使用 ${file}`,
  },
  en: {
    downloading: (url) => `maactl: downloading ${url.split('/').pop()} for first use\n  ${url}`,
    downloaded: (size, dest) => `maactl: downloaded ${size} to ${dest}`,
    downloadFailed: (url, reason) => `maactl: could not download the release archive\n  ${url}\n  reason: ${reason}`,
    extractFailed: (archive, reason) => `maactl: could not unpack the release archive\n  ${archive}\n  reason: ${reason}`,
    verifyFailed: (file, reason) => `maactl: the executable failed verification (${file})\n  reason: ${reason}`,
    explicitMissing: (file) => `maactl: MAACTL_BINARY points at a missing file: ${file}`,
    spawnFailed: (file, reason) => `maactl: could not start maactl (${file})\n  reason: ${reason}`,
    unsupportedPlatform: (host) =>
      `maactl: there is no prebuilt executable for this platform: ${host}\n  MaaCtl builds for x64 and arm64 on win32, linux and darwin.`,
    downloadDisabled: () => 'maactl: MAACTL_SKIP_DOWNLOAD is set, no local maactl is available, and downloading is not allowed',
    resolveHint: () =>
      [
        'maactl: no maactl executable could be located. Things to try:',
        '  1. set MAACTL_BINARY to an existing executable;',
        '  2. reinstall, in case the optional dependency was skipped (--omit=optional) or failed: npm install maactl;',
        '  3. check your network and retry, or set MAACTL_MIRROR to fetch maactl-<version>-<platform>.zip through a mirror.',
      ].join('\n'),
    usingBinary: (file) => `maactl: using ${file}`,
  },
};

function language() {
  const explicit = (process.env.MAACTL_LANG || '').trim().toLowerCase();
  if (explicit) {
    return explicit.startsWith('zh') ? 'zh' : 'en';
  }
  if (process.platform !== 'win32') {
    const posix = `${process.env.LC_ALL || ''}${process.env.LC_MESSAGES || ''}${process.env.LANG || ''}`.toLowerCase();
    if (posix) {
      return posix.includes('zh') ? 'zh' : 'en';
    }
  }
  let locale = '';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    locale = '';
  }
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Return the localized message for `key`, formatted with `args`. */
function text(key, ...args) {
  const catalogue = MESSAGES[language()] || MESSAGES.en;
  const entry = catalogue[key] || MESSAGES.en[key];
  return typeof entry === 'function' ? entry(...args) : String(entry ?? '');
}

module.exports = { text, language };
