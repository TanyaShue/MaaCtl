# MaaCtl：MaaFramework / ProjectInterface CLI 设计

## 目标与范围

`maactl` 在保留现有 `adb devices`、`win32 devices` 的基础上，提供一个可脚本化的 MaaFramework Client：

1. 加载指定 `interface.json`（ProjectInterface v2），选择其中的资源、控制器和任务并运行；
2. 不依赖 PI 任务声明，按 PI 资源路径或显式资源目录加载资源后，执行任意 Pipeline 节点；
3. 完整落实 PI 的资源叠加、任务覆盖和 option 覆盖规则，并允许调用者在最末层追加临时覆盖；
4. 输出适合自动化调用的 JSON、事件流和稳定退出码。

第一期支持当前 Go binding 能创建的 `Adb`、`Win32` 控制器。PI 的 `MacOS`、`PlayCover`、`Gamepad`、`Linux` 类型应能被解析和列出；实际运行时返回“当前构建不支持该控制器”。Agent、自定义识别/动作及 PI 遥测不属于 CLI 第一期开口。

## 术语和解析规则

所有命令统一使用 `--interface/-i <path>`。参数可以指向 `interface.json`，也可以指向其所在目录；省略时默认为**命令启动时当前工作目录**的 `./interface.json`，绝不以 `maactl.exe` 的目录回退。相对路径一律以该文件的目录解析。`--lib-dir` 保持现有规则：未指定时优先从当前工作目录的 `./maafw/bin` 查找，再尝试可执行文件相邻位置。

`--resource`、`--controller`、`--task` 取 PI 中的 `name`，不取翻译后的 `label`；显示结果同时返回 `name` 和可解析时的 `label`。所有读取 PI 的命令处理 `import`，遵循官方顺序：主文件优先，导入文件按 `import` 数组顺序合并；`task`、`preset` 追加，`option` 后导入覆盖同名定义，`global_option` 和 `group` 按协议去重。

运行前的资源和覆盖顺序固定如下，`--explain` 必须能输出每一层合并后的结果和来源：

```text
resource.path[0] → ... → resource.path[n]
→ controller.attach_resource_path[*]
→ global_option → resource.option → controller.option → task.option
→ task.pipeline_override → --override / --override-file
```

同一 Pipeline 节点使用 MaaFramework 的顶层字段合并规则：后者覆盖前者的同名顶层字段，数组整体替换。`--override` 是 CLI 临时覆盖，优先级最高。资源 `hash` 在加载 `resource.path` 后、加载 `attach_resource_path` 前校验；默认只警告，`--require-resource-hash` 时不匹配即失败。

### 省略参数时的默认选择

CLI 不要求每次重复填写 PI 中已经没有歧义的信息。选择规则按下面优先级工作：显式命令行参数 → 将来可选的已保存用户配置 → PI 声明顺序的唯一/首项默认值。凡是候选不唯一且没有规定首项默认的场景，命令在开始运行前失败，并列出可用候选及对应参数。

| 对象 | 省略时的行为 |
| --- | --- |
| `--interface` | 使用启动时当前工作目录的 `./interface.json`。 |
| `--resource` | 使用 PI `resource` 数组的第一个兼容资源。`run node --resource-path` 模式除外；它使用给出的第一个路径作为基础资源。 |
| `--controller` | 若 PI 仅声明一个 controller，自动选择它；有多个 controller 时失败并提示 `--controller <name>`。 |
| `--adb-address` | 选中 Adb controller 后枚举 ADB 设备：恰好一个时自动使用；零个时提示未发现设备；多于一个时失败并列出设备，要求 `--adb-address <serial>`。 |
| Win32 目标 | 选中 Win32 controller 后，以显式 `--window-handle`、`--window-title`、`--window-class` 优先，否则使用 PI 的正则枚举窗口；恰好一个时自动使用，零个或多个时失败并列出匹配结果。 |
| option 值 | 使用 option 的 `default_case`，或 input/hotkey 字段的 `default`；没有默认值时才要求调用者传入。checkbox 未配置 `default_case` 时默认为空数组，仍须满足 `min_count`。 |
| `--preset` | 不自动选 preset。`run preset` 的位置参数必填；`run task` 不提供 `--preset` 时仅使用 option 默认值。 |
| `--overlay`、`--override` | 默认不存在，不产生临时资源或 Pipeline 覆盖。 |

资源和任务的兼容性过滤在选择默认值前执行：自动选择第一个 resource 时跳过与当前 controller 不兼容的资源，并在 `--verbose`/`--explain` 中说明。找不到兼容资源时失败。任务不会自动选择：`run task` 和 `run node` 的位置参数始终必填。

## 命令总览

```text
maactl [global flags] <command>

  adb devices [--json]
  win32 devices [--json]

  interface --validate
  interface --show
  interface --controllers
  interface --resources
  interface --tasks
  interface --options
  interface --presets

  resource inspect
  resource nodes
  resource hash

  run task <task-name>
  run preset <preset-name>
  run node <node-name>
```

顶层全局参数：

| 参数 | 含义 |
| --- | --- |
| `--lib-dir, -l <dir>` | MaaFramework DLL 目录，沿用现有默认值 `./maafw/bin`。 |
| `--interface, -i <path>` | PI 文件或目录；仅 PI/资源/运行命令使用。 |
| `--lang <code>` | 解析 `label` 时使用的语言；默认 `zh_cn`，不可用时回退原始 `name`。 |
| `--json, -j` | 输出一份 JSON 结果；与 `--events jsonl` 可共用。 |
| `--log-dir <dir>` | MaaFramework 日志目录。 |
| `--verbose` | 输出加载路径、控制器连接过程和覆盖来源。 |

## 发现和校验命令

### `interface --validate`

```text
maactl interface --validate [-i <path>] [--strict] [--json]
```

检查 JSON/JSONC 可解析性、`interface_version == 2`、`import` 循环和缺失文件、名称唯一性、资源/控制器/任务/option 引用、option case 与 checkbox 数量约束，以及资源路径是否存在。`--strict` 将未知引用、资源 hash 缺失或不匹配、当前平台不能运行的控制器视为错误；默认模式中后两类仅为警告。

### `interface --show | --controllers | --resources | --tasks | --options | --presets`

```text
maactl interface --show        [-i <path>] [--json]
maactl interface --controllers [-i <path>] [--type Adb|Win32] [--json]
maactl interface --resources   [-i <path>] [--controller <name>] [--json]
maactl interface --tasks       [-i <path>] [--resource <name>] [--controller <name>] [--group <name>] [--json]
maactl interface --options     [-i <path>] [--task <name>] [--resource <name>] [--controller <name>] [--json]
maactl interface --presets     [-i <path>] [--json]
```

`interface` 不再设置查询子命令，每次选择一个操作参数。`--show/-s`、`--controllers/-c`、`--resources/-r`、`--tasks/-t`、`--validate/-v` 支持短参数；`--options` 和 `--presets` 当前仍为计划功能。文本列表显示列名并按终端字符宽度对齐，JSON 输出保留结构化字段。

列表查询的过滤结果应区分 `available` 与 `reason_unavailable`，避免静默隐藏不兼容 task/option。`interface --options` 返回 option 类型、case、默认值、嵌套 option 和经当前资源/控制器过滤后的可用性。

## 资源命令

资源命令只加载资源，不创建控制器，也不执行 Pipeline。因此它们可用于检查打包产物。

```text
maactl resource inspect [-i <path>] --resource <name>
                       [--resource-path <dir> ...] [--overlay <dir> ...] [--json]
maactl resource nodes   (同上) [--node <glob>] [--json]
maactl resource hash    (同上) [--verify] [--json]
```

资源来源二选一：`--resource <name>` 从 PI 取 `resource.path`；`--resource-path` 直接给一个或多个 Maa 资源根目录。两者同时出现时报错。`--overlay` 可以重复，排在基础路径之后逐个 `PostBundle`，用于临时资源包覆盖。`resource inspect` 输出最终路径顺序、资源 hash、节点数量、自定义识别/动作列表；`resource nodes` 输出节点名及可选节点 JSON；`resource hash --verify` 在 PI 资源模式下比较 `resource.hash`。

## 运行命令

### 公共运行参数

以下参数由 `run task`、`run preset` 和 `run node` 共用：

| 参数 | 含义 |
| --- | --- |
| `--resource <name>` | PI 资源 ID。省略时选择兼容的第一个 PI 资源；`run node` 可与 `--resource-path` 二选一。 |
| `--resource-path <dir>` | 直接资源根目录，可重复；仅 `run node` 支持。 |
| `--overlay <dir>` | 临时覆盖资源根目录，可重复，按传入顺序后加载。 |
| `--controller <name>` | PI 控制器 ID；省略时仅在 PI 中恰好有一个 controller 时自动选择。 |
| `--adb-address <serial>` | 将选择的 Adb PI 控制器连接到该设备；可搭配 `--adb-path <path>`、`--adb-config <json>`。 |
| `--window-handle <hex>` | 将选择的 Win32 PI 控制器连接到窗口句柄。 |
| `--window-title <regex>` / `--window-class <regex>` | Win32 目标窗口选择器；当找到零个或多个窗口时失败。参数覆盖 PI 正则。 |
| `--option <name>=<json>` | 设置 option 值，可重复。值是 JSON：select/switch 用字符串，checkbox 用字符串数组，input/hotkey 用对象。 |
| `--option-file <path>` | 含 `object<option-name, value>` 的 JSON 文件；在重复的 `--option` 之前载入，因此命令行值优先。 |
| `--preset <name>` | 载入 PI preset 的 task 启用状态和 option 初值；仅 `run task`、`run preset` 可用。 |
| `--override <json>` | 最终 Pipeline 覆盖 JSON。与 `--override-file` 最多给一个。 |
| `--override-file <path>` | 最终 Pipeline 覆盖 JSON 文件。 |
| `--dry-run` | 仅完成 PI 解析、资源加载与覆盖计算，不连接控制器、不运行 pretask、不执行节点。 |
| `--explain` | 在执行前打印/JSON 输出选中的实体、每层覆盖和最终 override；可与 `--dry-run` 组合。 |
| `--events text|jsonl|off` | 任务事件输出格式，默认 `text`；`jsonl` 每行一个 MaaFramework 回调。 |
| `--timeout <duration>` | 总运行超时；超时后发送 `PostStop`，等待清理并以超时退出。 |

密码型 input option 仅可通过 `--option-file` 或环境变量引用 `{"password":{"env":"NAME"}}` 提供；禁止在 `--option`、`--explain`、普通日志和 JSON 事件中显示明文。运行时解析为实际值，输出统一掩码为 `******`。

选择控制器后，CLI 根据其 PI 类型解析目标：Adb 在省略 `--adb-address` 时自动选择唯一设备；Win32 必须恰好解析到一个窗口。PI 内的 controller 配置（显示缩放、Adb/Win32 方法等）先应用，显式运行参数作为连接目标和配置补充。任何适用的 `pretask` 在创建控制器前顺序执行；`--dry-run` 不执行它。

### `run task`

```text
maactl run task <task-name> [-i <interface>] [--resource <resource>] [--controller <controller>] <common flags>
```

`task-name` 为 PI task ID。命令检查 task 的 resource/controller 限制，解析 `entry`，合并 task 的 option 和 `pipeline_override` 后调用 `MaaTaskerPostTask(entry, finalOverride)`。未通过限制时不能以 `--force` 绕开，以防用错误资源执行游戏专属任务。

示例：

```powershell
maactl run task "常规作战" -i D:\M9A --resource Official --controller Android `
  --adb-address emulator-5554 `
  --option '作战关卡="3-9 厄险（百灵百验鸟）"' `
  --option '复现次数="x3"' `
  --option '战斗划火柴=["普通划火柴","蓄力划火柴"]' `
  --events jsonl --timeout 30m
```

### `run preset`

```text
maactl run preset <preset-name> [-i <interface>] [--resource <resource>] [--controller <controller>] <common flags>
```

按 preset 的 `task` 数组顺序运行其中 `enabled != false` 的任务。每个 task 分别计算 option 覆盖并等待完成；前一个任务失败即停止，除非指定 `--continue-on-error`。公共 `--option` 仅覆盖同名且被该 task 引用/激活的 option，避免无意影响无关任务。

### `run node`

```text
maactl run node <node-name> [--resource <name> | --resource-path <dir> ...] `
  [-i <interface>] [--controller <controller>] <common flags>
```

以 `node-name` 直接作为 `PostTask` 的 entry。若使用 `--resource-path`，`--interface` 仍用于选择 controller 和可选语言；若控制器不需要 PI 配置，可在后续版本增加 `--controller-type`，第一期不提供此旁路。节点不存在时，加载后通过 `MaaResourceGetNodeList` 检查并在运行前失败。

示例：

```powershell
# 以 PI 的 Official 资源及一层本地补丁，直接调试 Combat 节点
maactl run node Combat -i D:\M9A\interface.json --resource Official `
  --overlay D:\patches\combat --controller Android --adb-address emulator-5554 `
  --override-file .\debug-combat.json --explain
```

## option 解析和覆盖细节

选择值的顺序为：option 的 `default_case` / input default → preset 值 → `--option-file` → `--option`。随后递归解析被选择 case 的子 option。无默认值且未提供值的 select/switch/input/hotkey option 为错误；checkbox 缺省为空数组，并校验 `min_count` / `max_count`。

只有被当前 resource/controller 支持的 option 才参与。各层 option 按 PI 协议的 `global → resource → controller → task` 顺序深合并其 `pipeline_override`；checkbox 的多个 case 必须按 `cases` 定义顺序合并，不能按用户参数顺序。input 的 `{field}` 占位符按照 `pipeline_type` 转换，hotkey 依据控制器类型转为键码。最后合并 task override 和 CLI override。

## 输出、退出码与可测试性

`--json` 的运行成功输出包含 `interface`, `resource`, `controller`, `task/entry`, `resource_hash`, `task_id`, `status`, `elapsed_ms` 与脱敏后的 `effective_override`。`--events jsonl` 在 stdout 输出事件，最终摘要输出到 stderr，避免破坏管道消费；普通模式则将进度和摘要输出 stdout。

退出码建议固定为：`0` 成功；`2` 参数/PI 校验错误；`3` 资源加载或 hash 校验错误；`4` 控制器发现/连接失败；`5` pretask 失败；`6` Maa task 失败；`7` 超时；`8` 被中断。框架初始化失败沿用 `1`。

实现时应将 PI 读取、import 合并、选择验证、option 求值、Pipeline 合并、资源加载、控制器连接和执行事件拆成独立 Go 包。这样可用 fixture 覆盖 import、过滤、合并顺序、checkbox、input 变量替换、覆盖层级和 CLI 参数解析，并把真实设备执行限制在集成测试。
