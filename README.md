# MaaCtl

一个使用 [maa-framework-go](https://github.com/MaaXYZ/maa-framework-go) 的 MaaFramework CLI。目前支持通过当前目录的 `maafw/bin` 枚举 ADB 设备和 Win32 桌面窗口。

命令行采用标准的分层子命令结构，后续可以在 `adb`、`win32` 或根命令下继续添加功能。

## 构建

```powershell
go build -o maactl.exe .
```

运行时默认从 `./maafw/bin` 加载 MaaFramework DLL。也可以通过 `--lib-dir` 指定其它目录。

## 使用

```powershell
# 查看根命令、分组或具体子命令帮助
./maactl.exe --help
./maactl.exe adb --help
./maactl.exe adb devices --help

# 查看版本（也支持 -v）
./maactl.exe --version

# 枚举 ADB 设备；list 是 devices 的别名
./maactl.exe adb devices
./maactl.exe adb list

# 枚举 Win32 窗口
./maactl.exe win32 devices

# 输出适合脚本处理的 JSON（-j 是 --json 的短参数）
./maactl.exe adb devices --json
./maactl.exe win32 devices -j

# --lib-dir/-l 是全局参数，可放在根命令或子命令参数中
./maactl.exe --lib-dir D:/path/to/maafw/bin adb devices
./maactl.exe adb devices -l D:/path/to/maafw/bin
```

当前 CLI 使用 MaaToolkit 的 `MaaToolkitAdbDeviceFind` 和 `MaaToolkitDesktopWindowFindAll`，仅做设备发现，不会连接设备或执行控制操作。
