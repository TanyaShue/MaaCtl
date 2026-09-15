# MaaCtl 的 npm 分发（npx maactl）

## 目标

让用户不必手动下载、解压、配置 PATH，就能把 `maactl` 当成普通命令使用，并且在
Windows、Linux、macOS 上都只要一次安装：

```bash
npx maactl -v
npx maactl pi t -if /path/to/project

npm install -g maactl
maactl -v
```

约束：

1. **参数必须原样透传。** `npx maactl run -t "签到" -if D:\proj -sa 30s` 与
   `.\maactl.exe run -t "签到" -if D:\proj -sa 30s` 完全等价，包括中文参数、
   含空格的路径和 `-`/`--` 前缀的选项。
2. **工作目录不变。** 包装器不改 `cwd`，因此 `maactl` 默认从**调用者所在目录**读取
   `./interface.json`，与直接运行可执行文件一致。
3. **退出码原样返回。** 脚本和 CI 可以按可执行文件的退出码判断成败。
4. **零运行时依赖。** 只用 Node 内置模块，避免为一个转发器引入依赖树。
5. **一次安装即用。** 安装不联网下载二进制：每个平台的可执行文件由该平台的
   可选依赖包提供，npm 只装当前机器需要的那个。

## 平台包（optionalDependencies）模型

`maactl` 包本身**不含任何二进制**（打包后约 15 kB），它声明六个平台包作为可选依赖：

| 平台 | 包 | 可执行文件 |
| --- | --- | --- |
| Windows x64 / arm64 | `maactl-win32-x64` / `maactl-win32-arm64` | `bin/maactl.exe` |
| Linux x64 / arm64 | `maactl-linux-x64` / `maactl-linux-arm64` | `bin/maactl` |
| macOS x64 / arm64 | `maactl-darwin-x64` / `maactl-darwin-arm64` | `bin/maactl` |

每个平台包用 `os` / `cpu` 限定自己，npm 在安装时只会解包匹配当前机器的那一个，
其余的在依赖树里根本不落地。这就是「装完即可用」的来源，也是这个方案相对于
「运行时下载」和「tarball 里塞进六个平台二进制」的取舍：

- 相比运行时下载：`install` 与第一次运行都不依赖 GitHub 可达性，国内网络环境最稳；
- 相比塞进一个包：用户只付出自己平台那份体积（约 30 MiB），而不是 150 MiB；
- 代价：发布时要多发六个包，且必须**先发平台包再发主包**（否则首批安装会静默跳过可选依赖）。

平台包里的 `maactl` 是**自带 MaaFramework 运行库**的版本；轻量版 `maactl-lite`
只出现在 Release 压缩包里，不进入 npm。

`maactl` 的包装器仍然保留「下载并缓存」这条兜底路径，覆盖两种退化情况：可选依赖被
`--omit=optional` 跳过，或在不支持的平台上安装。此时首次运行会下载
`maactl-<version>-<platform>.zip` 并缓存。

### 可执行位

npm 的 tarball 是否记录可执行位取决于打包主机：在 Windows 上打包完全不带 Unix mode。
因此包装器在解析到平台包的可执行文件后会补一次 `chmod 0o755`（仅 POSIX，且只在缺少
可执行位时），发布流程也刻意跑在 Linux 上，让 tarball 尽量记录正确的权限。

## 目录结构

```text
npm/
  package.json               bin/maactl、files、optionalDependencies（六个平台包）
  README.md                  发布到 npm 的说明（npx 用法、环境变量）
  bin/maactl.js              入口：npm 生成的 maactl / maactl.cmd 指向它
  lib/binary.js              可执行文件的定位、下载、解包、校验与缓存
  lib/platforms.js           平台表：Node 平台键 ↔ MaaFramework 平台 id、可执行文件名、格式嗅探
  lib/download.js            HTTPS 下载（重定向、重试、进度、截断检测）
  lib/zip.js                 最小 ZIP 读取（只用 zlib 解出压缩包里的可执行文件，并读取 Unix 权限位）
  lib/cli.js                 解析可执行文件、spawn、转发参数与信号、返回退出码
  lib/env.js                 环境变量读取（MAACTL_QUIET 等 1/true/yes/on 开关）
  lib/messages.js            中英文提示（跟随 MAACTL_LANG）
  scripts/platform-packages.js  平台包的 prepare / link / sync-version / check / publish
  test/                      node:test 单元测试（不联网、不依赖真实可执行文件）
  test-support/              测试辅助：环境隔离、包装器副本、本地 HTTP 服务、内存 ZIP
```

平台表只有一份（`lib/platforms.js`）：运行时用它定位可执行文件，`scripts/platform-packages.js`
用它生成平台包与 `optionalDependencies`，`test/package.test.js` 用它断言 manifest，
三者不会各自漂移。

测试用 `isolatedPackage()` 把 `lib/` 与 `package.json` 复制到临时目录再加载，并按需在
副本里伪造当前平台的可选依赖，因此开发者本地的 `node_modules` 不会让测试结果失真。

## 可执行文件的定位顺序

`resolveBinary()` 按以下顺序返回第一个可用文件，全部落空时才进入下载分支：

1. `MAACTL_BINARY` 指定的路径（不存在则直接报错，不回退，避免静默用错版本）；
2. 当前平台包里的可执行文件（`require.resolve('maactl-<platform>/package.json')` 解析，
   因此 pnpm 的布局与 Yarn PnP 也能找到）；
3. 缓存目录里的上一次下载：`%LOCALAPPDATA%\maactl\npm\<version>\` 或
   `$XDG_CACHE_HOME/maactl/npm/<version>/`；
4. 下载 `https://github.com/<repo>/releases/download/v<version>/maactl-<version>-<platform>.zip`，
   用 `lib/zip.js`（Node 无内置 zip API，只依赖 `zlib`）解出其中的可执行文件。

缓存目录带版本号，升级包版本不会复用旧文件；`MAACTL_VERSION` 可以同时改写下载版本和缓存目录，
方便用未发布的版本自测。解压只取一个成员，并校验长度与 CRC32；解压完成后立即删除压缩包
（否则缓存里会白白多出一份）。随后按平台校验文件头（PE 的 `MZ`、ELF 的 `\x7fELF`、Mach-O
的 magic，含 universal）、体积下限，并实际执行 `--version` 确认输出里含 `maactl`；
任一环节失败即删除文件，绝不缓存半成品。`MAACTL_SKIP_DOWNLOAD=1` 可以彻底禁止下载。

## 参数与退出码转发

`bin/maactl.js` 把 `process.argv.slice(2)` 交给 `lib/cli.js`，后者用
`spawn(exe, argv, { stdio: 'inherit', cwd: process.cwd(), env: process.env })` 启动可执行文件：

- `stdio: 'inherit'` 让它直接占用调用者的终端，因此进度条、彩色输出、`--json`、
  管道（`maactl ... | jq`）都与直接运行一致；
- 子进程退出后包装器把退出码写进 `process.exitCode`，不额外调用 `process.exit()`，
  避免截断尚未 flush 的输出；
- POSIX 下转发 `SIGINT/SIGTERM/SIGQUIT/SIGHUP`，子进程被信号杀死时包装器重新抛出同一信号；
- Windows 没有 POSIX 信号，控制台把 Ctrl+C 广播给整个进程组，子进程自己收得到，所以包装器只
  注册一次性空监听器保持存活、等待其优雅退出；再按一次 Ctrl+C 会恢复默认行为，直接终止包装器。

npx 会把包名之后的参数原样传给命令，因此 `npx maactl -v` 不会被 npm 自己吞掉；遇到会拦截参数的
旧版 npx 时可用 `npx maactl -- -v` 显式分隔。

## 发布流程

npm 发布由可复用工作流 `.github/workflows/npm-publish.yml` 负责，两种触发方式：

1. `workflow_call`：`.github/workflows/release.yml` 的 `npm` 任务在 `release` 任务完成后调用它，
   所以推送 `v*` tag 完成发版后会自动发布 npm 包；
2. `workflow_dispatch`：手动重发 / 补发某个已发布版本。

```bash
gh workflow run npm-publish.yml -f tag=v0.1.0                  # 补发 / 重发
gh workflow run npm-publish.yml -f tag=v0.1.1 -f dry_run=true   # 只演练，不真正 publish
```

步骤（在 Linux runner 上执行，以便 tarball 记录可执行位）：

1. `actions/checkout` 到该 tag（`fetch-depth: 0`，`release.py` 需要本地 tag 列表）；
2. `python3 .github/scripts/release.py metadata --tag <tag>` 得到 version / channel / prerelease；
3. `gh release download <tag> --pattern "maactl-*-*.zip"` 取回**六个平台**的压缩包；
4. `npm version <version> --no-git-tag-version --allow-same-version` 把包版本对齐 tag；
   `version` 生命周期钩子会调用 `platform-packages.js sync-version`，把
   `optionalDependencies` 重新钉到同一个版本，随后 `check` 断言六个平台一个不多一个不少；
5. `npm test` 跑包装器测试；
6. `node scripts/platform-packages.js prepare --dist ../dist` 从六个压缩包里解出自带运行库的
   `maactl`，生成六个平台包目录（含 `package.json` 的 `os`/`cpu`、`bin/`、README），并逐个校验
   文件头与体积——这里不执行二进制，因为 runner 只能跑自己平台的程序，执行验证已在
   `release.yml` 的原生 runner 上完成；
7. 查 npm 上是否已有该版本，已存在则跳过（幂等）；
8. 先 `npm run platforms:publish -- --tag <tag>` 发布六个平台包，再 `npm publish` 发布主包
   （顺序不能反，否则主包刚发布时的安装会静默跳过还不存在的可选依赖）；
   正式版打 `latest`，预发布按通道打 `alpha`/`beta`/`rc` 标签（与 GitHub Release 的
   Pre-release 语义一致），带 `--provenance`。

平台包的发布有两处刻意的安排：**逐个之间间隔 `--delay`**（CI 传 20 秒），以及**已存在同版本的包
直接跳过**。原因是 npm 对新包的创建有反滥用检测：把六个同族的新包名连续创建会被判为 spam 并返回
`403 ... Package name triggered spam detection`（实测第一个通过、第二个被拦）。间隔创建能避开这个
检测，遇到该 403 时脚本还会做有限次退避重试；而跳过已发布的版本让失败后的重跑可以接着往下走，
不会因为「版本已存在」再次失败。

发布成功后 registry 还要做几十秒到十几分钟的异步处理（平台包里有 30 MiB 级的二进制要扫描，
带 provenance 的版本还要校验 attestation）。这期间 `npm view maactl@<version>` 依旧是 404，
日志里会出现 `Your package is being processed and may take a few minutes to become available.`
——都属正常，不要据此判定发布失败，也不要急着重新 dispatch，等几分钟再查 dist-tags 即可：

```bash
# 发布后的自查：主包与平台包都要在
npm view maactl dist-tags --registry=https://registry.npmjs.org
npm view maactl-win32-x64 versions --registry=https://registry.npmjs.org

# 校验 provenance 签名（默认源是 npmmirror 时必须显式指定 registry，否则取不到 TUF 公钥）
npm audit signatures --registry=https://registry.npmjs.org
```

为何不是 `on: release: published`：Release 是 `release.yml` 用内置 `GITHUB_TOKEN` 创建的，而 GitHub
不会为 `GITHUB_TOKEN` 导致的事件启动新的工作流，独立监听 Release 的工作流会永远不被触发。因此把发布
逻辑写成可复用工作流，由 `release.yml` 在 Release 建好后直接调用；`workflow_dispatch` 与自动发布走的是
同一份逻辑，手动重发不会出现行为差异。

发布需要仓库配置 `NPM_TOKEN` secret（npm Automation token，具备 publish 权限）：

```bash
gh secret set NPM_TOKEN -b "<npm token>"
gh secret list
```

未配置时该任务只打印警告并跳过发布，不会失败；目标版本已存在于 npm 时同样跳过而不是报错（npm 不允许
覆盖已发布的版本号）。

`.github/workflows/npm.yml` 在 `npm/**` 变更时跑测试，并在 **ubuntu / windows / macos 三个平台**上
做一次端到端冒烟：构建轻量版可执行文件 → `platform-packages.js link` 把它装成当前平台的可选依赖 →
在 `MAACTL_SKIP_DOWNLOAD=1`（禁止下载）下运行 `node bin/maactl.js -v`，以及经 npm bin shim 的
`npx --package . maactl -v`。

## 本地验证

```bash
cd npm
npm test                                    # 单元测试，离线可跑
node scripts/platform-packages.js check      # manifest 与平台表是否一致

# 把本地构建的可执行文件装成当前平台的包，然后照常运行
go build -tags bundled -o ../maactl.exe ./cmd/maactl
node scripts/platform-packages.js link ../maactl.exe
MAACTL_SKIP_DOWNLOAD=1 node bin/maactl.js -v

# 只演练平台包的组装（需要一个装了六个平台压缩包的 dist/ 目录）
node scripts/platform-packages.js prepare --dist ../dist
npm pack --dry-run                            # 主包应只有 bin/、lib/、README
npm pack --dry-run ./platforms/maactl-win32-x64
```

只想验证参数转发而不重新打包时，用 `MAACTL_BINARY` 直接指向本地构建：

```bash
MAACTL_BINARY=../maactl.exe node npm/bin/maactl.js -v
```
