# 发版与 npm 发布

推送符合 SemVer 的 tag（`v<major>.<minor>.<patch>[-alpha.N|-beta.N|-rc.N]`，匹配 `v[0-9]*`）会触发
`.github/workflows/release.yml`：

1. `version`：校验 tag 是否符合 SemVer，计算是否预发布、预发布通道和上一个正式版 tag；
2. `build`：**每个平台一个 runner**（见下表），每个 job 都执行同一套步骤：
   - `.github/scripts/fetch_maafw.py --platform <平台>` 下载对应平台的 MaaFramework release
     并解包到 `maafw/`（换平台会整目录替换，不会留下上一个平台的运行库）；
   - `go run ./tools/packmaafw -platform <平台>` 从 `maafw/bin` 生成 payload；
   - `go test ./...` 与 `go test -tags bundled ./...`；
   - `.github/scripts/build_release.py` 构建并**实际运行**两个 exe 校验（自带版必须报告
     MaaFramework 版本、轻量版必须不带；两个都要能通过隐藏命令 `selfcheck` 真正加载运行库），
     然后把它们压成一个 `maactl-<version>-<platform>.zip` 上传为 artifact；
3. `changelog`：生成当前版本与上一个正式版之间的更新日志，按 feat/fix/perf/refactor/docs 等分组
   并附 commit 链接；
4. `release`：汇总所有平台的压缩包，在更新日志末尾追加下载表，然后创建/更新 GitHub Release
   （正式版发布为 Latest；`-alpha`/`-beta`/`-rc` 等预发布版本标记为 Pre-release（标题带通道名），
   不会成为 Latest；重复执行会更新已有 Release 并覆盖产物）；
5. `npm`：调用可复用工作流 `.github/workflows/npm-publish.yml`，把该 tag 对应的版本发布到 npm。
   正式版打 `latest`，预发布版本按通道打 `alpha`/`beta`/`rc`。

构建矩阵（与 MaaFramework 的 release 平台一一对应）：

| 平台 | artifact / 产物 | runner |
| --- | --- | --- |
| `win-x86_64` | `maactl-<version>-win-x86_64.zip` | `windows-latest` |
| `win-aarch64` | `maactl-<version>-win-aarch64.zip` | `windows-11-arm` |
| `linux-x86_64` | `maactl-<version>-linux-x86_64.zip` | `ubuntu-24.04` |
| `linux-aarch64` | `maactl-<version>-linux-aarch64.zip` | `ubuntu-24.04-arm` |
| `macos-x86_64` | `maactl-<version>-macos-x86_64.zip` | `macos-15-intel` |
| `macos-aarch64` | `maactl-<version>-macos-aarch64.zip` | `macos-15` |

每个压缩包里都是同一份组合：`maactl`（自带 MaaFramework）与 `maactl-lite`（从 `./maafw/bin`
或 `--lib-dir` 加载）。Windows 上文件名带 `.exe`。构建在原生 runner 上进行，因此运行库是真的被
加载验证过的，而不是“交叉编译出个文件就算数”：`build_release.py` 会跑 `maactl selfcheck`，
它会像普通命令一样加载 MaaFramework 并打印实际加载到的版本。Linux runner 因此先装上
`libdbus-1-3` 与 `libatomic1`（MaaToolkit 与发布包内 libc++ 的系统依赖）。

```bash
# 发一个正式版
git tag -a v0.1.2 -m "MaaCtl v0.1.2" && git push origin v0.1.2

# 发一个预发布（npm 上打 beta 标签，不会动 latest）
git tag -a v0.1.2-beta.1 -m "MaaCtl v0.1.2-beta.1" && git push origin v0.1.2-beta.1
```

`maafw.version` 钉住所有平台共用的 MaaFramework 版本；升级时改这一个文件，六个平台的
`fetch_maafw.py` 就会去取对应的 vX.Y.Z 资源。

## 发布到 npm

`.github/workflows/npm-publish.yml` 是唯一的 npm 发布入口，有两种触发方式：

- `workflow_call`（自动）：`release.yml` 在 `release` 任务完成、GitHub Release 建好之后调用它，
  因此推 `v*` tag 发版就会自动发 npm 包；
- `workflow_dispatch`（手动）：重发或补发某个已发布的版本。

```powershell
gh workflow run npm-publish.yml -f tag=v0.1.1                  # 补发 / 重发
gh workflow run npm-publish.yml -f tag=v0.1.2 -f dry_run=true   # 只演练，不真正 publish
```

工作流流程（跑在 Linux runner 上，以便 tarball 记录可执行位）：checkout 该 tag →
`release.py metadata` 算出 version/channel → 确认 tag 里存在 `npm/` →
`gh release download --pattern "maactl-*-*.zip"` 取回**六个平台**的压缩包 →
`npm version` 对齐包版本，并把 `optionalDependencies` 重新钉到同一版本 → `npm test` →
`node scripts/platform-packages.js prepare` 从压缩包生成六个平台包 → 查询 npm 上是否已有该版本
（有则跳过）→ 先发布六个平台包，再 `npm publish --access public --provenance --tag <latest|alpha|beta|rc>`
发布主包。

npm 主包只有一份包装器代码（约 15 kB），二进制分别放在六个平台包里，由 `optionalDependencies`
按 `os`/`cpu` 选择；因此安装一次即可用，不需要运行后再下载。详见
[npm-package.md](npm-package.md)。

### 为什么不用 `on: release: published`

Release 是 `release.yml` 用内置 `GITHUB_TOKEN` 创建的，而 GitHub 不会为 `GITHUB_TOKEN` 导致的
事件启动新的工作流，这样写的独立工作流会永远不触发。写成可复用工作流还有一个好处：发布逻辑只有
一份，手动重发与自动发布的行为完全一致。

### 配置

发布需要仓库配置 `NPM_TOKEN`（npm Automation token，具备 publish 权限）secret；未配置时该任务
只打印警告并跳过，不会让发版失败（fork 与本地触发都安全）。目标版本已存在于 npm 时同样跳过而不是
报错——npm 不允许覆盖已发布的版本号。

```powershell
gh secret set NPM_TOKEN -b "<npm token>"
gh secret list
```

### 发布后自查

发布成功后 registry 还要做几十秒到十几分钟的异步处理（30 MB 级的 exe 要扫描，带 provenance 的
版本还要校验 attestation）。这期间 `npm view maactl@<version>` 依旧是 404，日志里会出现
`Your package is being processed and may take a few minutes to become available.`——都属正常，
不要据此判定发布失败，也不要急着重新 dispatch，等几分钟再查 dist-tags 即可：

```powershell
# 发布后的自查
Invoke-RestMethod https://registry.npmjs.org/-/package/maactl/dist-tags
npm view maactl dist-tags --registry=https://registry.npmjs.org

# 校验 provenance 签名（默认源是 npmmirror 时必须显式指定 registry，否则取不到 TUF 公钥）
npm audit signatures --registry=https://registry.npmjs.org
```

`npm/**` 有改动时，`.github/workflows/npm.yml` 会在 ubuntu / windows / macos 三个平台上跑包装器测试，
并在禁止下载（`MAACTL_SKIP_DOWNLOAD=1`）的前提下做一次端到端冒烟：把本地构建的轻量版可执行文件
装成当前平台的可选依赖，再用 `node bin/maactl.js -v` 与 `npx --package . maactl -v` 各跑一次。
