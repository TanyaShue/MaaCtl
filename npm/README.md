# maactl (npm)

通过 `npx` 运行 MaaCtl 的命令行客户端。这个包是一个很薄的转发器：它找到本平台的
`maactl` 可执行文件，把命令行参数原样传给它，再把退出码回传给 shell。

```bash
# 直接运行，无需全局安装
npx maactl --version
npx maactl device adb
npx maactl pi t -if /path/to/project

# 若某些 npx 版本吞掉了参数，用 -- 显式分隔
npx maactl -- run -t "签到" -if ./project -sa 30s
```

`npx maactl ...` 之后的所有参数都会原样传给它，包括 `-f/--interface`、
`--adb-address`、`--json` 等；工作目录也不会被改变，因此默认的 `./interface.json`
仍然相对于你执行命令的目录解析。

## 平台

支持 Windows、Linux 与 macOS 上的 x64 与 arm64，共六个平台：

| 平台 | 可选依赖包 | 自带的 `maactl` |
| --- | --- | --- |
| Windows x64 / arm64 | `maactl-win32-x64` / `maactl-win32-arm64` | `bin/maactl.exe` |
| Linux x64 / arm64 | `maactl-linux-x64` / `maactl-linux-arm64` | `bin/maactl` |
| macOS x64 / arm64 | `maactl-darwin-x64` / `maactl-darwin-arm64` | `bin/maactl` |

`maactl` 本身不含任何二进制，只有一份包装器代码（约 15 kB）。它用
`optionalDependencies` 声明上面六个平台包，每个平台包用 `os`/`cpu` 限定自己，
因此 npm 只会安装当前机器需要的那个：

```bash
npm install maactl        # 只下载当前平台的包，装完即可用，无需联网下载二进制
npx maactl --version
```

平台包里的 `maactl` 是**自带 MaaFramework 运行库**的版本，所以一次安装就能跑。
仅要求 `"engines": { "node": ">=22" }`（包装器只用 Node 22 及以上提供的内置能力，
包括读取 release 压缩包所需的 `zlib.crc32`）。

被 `--omit=optional` 跳过、或在不支持的平台上安装时，包装器会在首次运行时退回
从 [Releases](https://github.com/TanyaShue/MaaCtl/releases/latest) 下载
`maactl-<version>-<platform>.zip` 并缓存（压缩包里另有轻量版 `maactl-lite`）。

Linux 需要系统提供 `libdbus-1-3` 与 `libatomic1`（MaaToolkit 与发布包内 libc++ 的
依赖）；macOS 需要录屏权限（截图）与辅助功能权限（输入）。

## 可执行文件的来源

按以下顺序查找，第一个命中的会被使用：

1. 环境变量 `MAACTL_BINARY` 指向的文件；
2. 当前平台的 npm 包（`node_modules/maactl-<platform>/bin/...`，正常安装都有）；
3. 缓存目录里的上一次下载（`%LOCALAPPDATA%\maactl` 或 `$XDG_CACHE_HOME/maactl`）；
4. 都找不到时，下载该版本的 `maactl-<version>-<platform>.zip`，解出可执行文件、
   校验后缓存（下次直接复用）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `MAACTL_BINARY` | 指定要执行的可执行文件，跳过查找与下载。 |
| `MAACTL_HOME` | 覆盖缓存根目录，默认 `%LOCALAPPDATA%\maactl`（Windows）或 `$XDG_CACHE_HOME/maactl`。 |
| `MAACTL_VERSION` | 覆盖下载时使用的版本，默认取包的 `version`。 |
| `MAACTL_BINARY_URL` | 直接指定下载地址，完全跳过 GitHub 拼接。 |
| `MAACTL_MIRROR` | 镜像前缀，最终地址为 `<mirror>/https://github.com/<repo>/releases/download/<tag>/<asset>`。 |
| `MAACTL_REPO` | 覆盖仓库，默认 `TanyaShue/MaaCtl`。 |
| `MAACTL_PLATFORM` / `MAACTL_ASSET` | 覆盖平台 id（默认按当前系统推导）与资产名（默认 `maactl-<version>-<platform>.zip`）。 |
| `MAACTL_SKIP_DOWNLOAD=1` | 禁止下载：本地找不到就直接报错。 |
| `MAACTL_QUIET=1` | 静默模式，不输出下载进度。 |
| `MAACTL_VERBOSE=1` | 输出实际使用的可执行文件路径。 |
| `MAACTL_LANG` | 包装器的提示语言（`zh_CN`/`en`），与 CLI 自身一致。 |

## 从源码使用

```bash
# 直接用 shim，无需安装
node npm/bin/maactl.js --help

# 把本地构建的可执行文件装成当前平台的包，然后照常运行
cd npm
go build -tags bundled -o ../maactl.exe ./cmd/maactl
node scripts/platform-packages.js link ../maactl.exe
node bin/maactl.js --version
```

平台包的构建与发布由 `npm/scripts/platform-packages.js` 负责（`prepare` /
`publish` / `check`），细节见
[发布文档](https://github.com/TanyaShue/MaaCtl/blob/main/docs/npm-package.md)。

完整的命令说明见 [MaaCtl 命令行参考](https://github.com/TanyaShue/MaaCtl/blob/main/docs/cli.md)，
安装方式见 [主仓库 README](https://github.com/TanyaShue/MaaCtl#readme)。
