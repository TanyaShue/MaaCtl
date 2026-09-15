# 构建与打包

本文面向开发者：如何从源码构建 `maactl`、如何把 MaaFramework 打包进 exe，以及运行库的查找顺序。
只想使用 `maactl` 的话看 [README](../README.md) 即可。

## 支持平台

`maactl` 的两条构建路径都支持 MaaFramework 发布桌面版 release 的全部平台：

| 平台 id | 构建目标 | 自带运行库文件名 |
| --- | --- | --- |
| `win-x86_64` | Windows amd64 | `MaaFramework.dll` / `MaaToolkit.dll` |
| `win-aarch64` | Windows arm64 | 同上 |
| `linux-x86_64` | Linux amd64 | `libMaaFramework.so` / `libMaaToolkit.so` |
| `linux-aarch64` | Linux arm64 | 同上 |
| `macos-x86_64` | macOS amd64 | `libMaaFramework.dylib` / `libMaaToolkit.dylib` |
| `macos-aarch64` | macOS arm64 | 同上 |

MaaFramework 也为 Android 发布 release，但它面向「集成进 APK」，不是命令行客户端的目标，因此
`maactl` 不为 Android 构建。控制器类型同样按平台选取：Windows 可用 `Win32`/`Gamepad`，
macOS 可用 `MacOS`/`PlayCover`，Linux 可用 `Linux`（wlroots），`Adb` 则全平台可用。

## 构建两种 exe

同一个源码树通过 `bundled` 编译标签产出两种可执行文件：

```bash
# 自带 MaaFramework（自包含，开箱即用）：先把运行库放到 maafw/bin，再生成 payload
python3 .github/scripts/fetch_maafw.py --platform linux-x86_64   # 解包 release 到 maafw/
go run ./tools/packmaafw
go build -tags bundled -o maactl ./cmd/maactl

# 轻量版：不内嵌，运行时从 ./maafw/bin 或 --lib-dir 加载
go build -o maactl-lite ./cmd/maactl

# 运行全部测试（两种构建各跑一遍）
go test ./...
go test -tags bundled ./...

# npm 转发器（npx maactl）的测试，不联网、不依赖 exe
cd npm; npm test; cd ..
```

自带 MaaFramework 的构建约 31 MiB，轻量版约 5 MiB；两者的命令行行为完全一致，区别只在运行库来源。
`tools/packmaafw` 按当前平台校验运行库，所以交叉编译时（`GOOS`/`GOARCH` 与主机不同）无法把
运行库打进 exe：请在目标平台上构建，CI 就是这么做的。

## 运行库查找顺序

`maactl` 按以下顺序定位 MaaFramework 运行库，第一个命中的生效：

1. `--lib-dir`（`-l`）显式指定的目录；
2. 内嵌在 exe 中的自带运行库（仅 `-tags bundled` 构建）；
3. 当前目录的 `./maafw/bin/`；
4. 可执行文件周边的 `maafw/bin`。

也就是说：自包含构建默认使用自带运行库，除非用户显式指定 `--lib-dir`；轻量版则按上述路径查找。
`--interface`（`-f`）只影响 PI 的加载位置，与运行库无关。

“运行库目录”就是 MaaFramework release 压缩包解包后的 `bin/`：Windows 是 DLL，Linux/macOS 是
`libMaaFramework.so`/`libMaaFramework.dylib` 及其依赖，且 Linux 与 macOS 的动态库都带
`$ORIGIN`/`@loader_path` rpath，因此把整个目录放到哪里都能直接加载。

MaaFramework 的 release 包已经自带大部分依赖（opencv、onnxruntime 等），但仍依赖少量系统库：

| 平台 | 启动所需 | 额外说明 |
| --- | --- | --- |
| Windows | VC++ 运行库（系统组件） | — |
| Linux | `libdbus-1-3`（MaaToolkit）、`libatomic1`（发布包内 libc++） | 创建 Linux（wlroots）控制器还需 `libpipewire-0.3-0`，用 Libei 输入还需 `libei1` |
| macOS | 系统自带（ScreenCaptureKit / Cocoa） | 截图需录屏权限，输入需辅助功能权限 |

不确定运行库能不能加载时，用隐藏命令 `selfcheck`：它会按与其它命令相同的方式加载
MaaFramework，打印实际加载到的版本与来源，失败则返回非零退出码。

```bash
./maactl selfcheck
# MaaFramework v5.13.0 (linux-x86_64, bundled) from /home/me/.cache/maactl/maafw/linux-x86_64-v5.13.0/bin
```

CI 在每个平台上都跑这个命令，因此“包里带了运行库”不是靠肉眼确认的。

## 自带 MaaFramework（打包）

`tools/packmaafw` **只读本地文件**，不再下载任何东西：它把 `maafw/bin/`（即 MaaFramework release
解包后的运行库目录，可用 `-dir` 指定别处）重新压缩成
`internal/maafw/bundled/payload/bin.zip`，并写下 `version.txt` 与 `platform.txt`。带上
`-tags bundled` 构建时，这个 payload 会被 `go:embed` 进 exe。

```bash
# 1. 准备运行库：CI 用脚本下载，本地可以自己解压 release 压缩包
python3 .github/scripts/fetch_maafw.py --platform win-x86_64   # 解包到 maafw/
# 或
Expand-Archive MAA-win-x86_64-v5.13.0.zip -DestinationPath maafw

# 2. 生成 payload（缺失运行库、平台不匹配都会直接失败）
go run ./tools/packmaafw                                           # 用 maafw/bin
go run ./tools/packmaafw -dir /tmp/maa/bin                         # 运行库放在别处
go run ./tools/packmaafw -platform linux-x86_64 -version v5.14.0    # 断言平台与版本（须在 Linux 主机上）

# 3. 构建两种 exe（Windows 上可执行文件带 .exe 后缀）
go build -tags bundled -o maactl ./cmd/maactl    # 携带运行库，约 31 MiB
go build -o maactl-lite ./cmd/maactl             # 不携带运行库，约 5 MiB
```

`-platform` 默认取当前主机（`go run` 时的 GOOS/GOARCH），并会与 `maafw/bin` 里的文件核对：文件名
决定操作系统，库里 PE/ELF/Mach-O 头里的 machine 字段决定架构。任何一项对不上都会报错，避免把
macOS 的运行库打进 Windows 的 exe；显式指定 `-platform` 时还要求它等于当前主机（CI 用矩阵里的
平台 id 做这一层断言，免得 runner 选错也照样出包）。`-version` 默认读 `maafw.version`，只用于缓存
目录与版本显示。

运行时，内嵌的 payload 会解包到用户缓存目录并复用：

```text
%LOCALAPPDATA%\maactl\maafw\<platform>-<version>\bin\   # Windows
~/.cache/maactl/maafw/<platform>-<version>/bin/         # Linux（macOS 为 ~/Library/Caches）
```

平台主库（`MaaFramework.dll` / `libMaaFramework.so` / `libMaaFramework.dylib`）最后写入，所以
“该文件存在”即代表解包完整，中途中断会在下次运行时重做。payload 里记录的平台与当前构建不一致时，
`maactl` 会明确报错并回退到 `./maafw/bin`，不会去加载错误的运行库。自带版本会显示在版本信息里：

```bash
./maactl --version       # maactl version 0.1.1 (MaaFramework v5.13.0)
./maactl-lite --version  # maactl version 0.1.1
```

升级 MaaFramework 只需改 `maafw.version`（或加 `-version`）后重新下载、打包与构建；`--lib-dir`（`-l`）
始终可覆盖自带运行库。带 `-tags bundled` 但未先生成 payload 时，构建仍会成功，但运行时会输出
明确告警并回退到 `./maafw/bin`。

## 版本注入与本地验证

版本号由链接期注入，正式发布由 CI 用 tag 填入：

```bash
go run ./tools/packmaafw
go build -tags bundled -ldflags "-X main.version=1.2.3-beta.1" -o maactl ./cmd/maactl
go build -ldflags "-X main.version=1.2.3-beta.1" -o maactl-lite ./cmd/maactl
./maactl --version             # maactl version 1.2.3-beta.1 (MaaFramework v5.13.0)
./maactl-lite --version        # maactl version 1.2.3-beta.1
```

CI 用的同一套步骤可以本地跑：

```bash
python3 .github/scripts/build_release.py --platform linux-x86_64 --version 1.2.3-beta.1
# dist/maactl, dist/maactl-lite, dist/maactl-1.2.3-beta.1-linux-x86_64.zip
```

## 验证 npm 包装器

不需要发布就能验证包装器（细节见 [npm-package.md](npm-package.md)）：

```bash
cd npm
npm test                                   # 单元测试，离线可跑
node scripts/platform-packages.js check     # manifest 与平台表是否一致

# 把本地构建的可执行文件装成当前平台的可选依赖，模拟发布包
go build -tags bundled -o ../maactl.exe ./cmd/maactl
node scripts/platform-packages.js link ../maactl.exe
MAACTL_SKIP_DOWNLOAD=1 node bin/maactl.js -v
```

也可以跳过打包，直接让包装器使用本地可执行文件：

```bash
MAACTL_BINARY=../maactl.exe node npm/bin/maactl.js -v
```
