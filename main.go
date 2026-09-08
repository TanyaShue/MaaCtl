package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	maa "github.com/MaaXYZ/maa-framework-go/v3"
	"github.com/spf13/cobra"
)

const version = "0.1.0"

type cliOptions struct {
	libDir, interfacePath string
	json                  bool
}
type deviceOptions struct{ json bool }

type adbDeviceOutput struct {
	Name            string `json:"name"`
	AdbPath         string `json:"adb_path"`
	Address         string `json:"address"`
	ScreencapMethod string `json:"screencap_method"`
	InputMethod     string `json:"input_method"`
	Config          string `json:"config,omitempty"`
}
type desktopWindowOutput struct {
	Handle     string `json:"handle"`
	ClassName  string `json:"class_name"`
	WindowName string `json:"window_name"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	root := newRootCommand()
	root.SetArgs(args)
	root.SetOut(os.Stdout)
	root.SetErr(os.Stderr)
	return root.Execute()
}

func newRootCommand() *cobra.Command {
	var global cliOptions
	root := &cobra.Command{
		Use: "maactl", Version: version, Short: "MaaFramework command-line tool",
		Long:          "MaaCtl controls and inspects MaaFramework devices and resources.",
		SilenceErrors: true, SilenceUsage: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	root.PersistentFlags().StringVarP(&global.libDir, "lib-dir", "l", "", "MaaFramework DLL directory (default: ./maafw/bin)")
	root.PersistentFlags().StringVarP(&global.interfacePath, "interface", "i", "", "ProjectInterface file or directory (default: ./interface.json)")
	root.PersistentFlags().BoolVarP(&global.json, "json", "j", false, "output JSON")
	root.AddCommand(newADBCommand(&global), newWin32Command(&global), newInterfaceCommand(&global), newRunCommand(&global))
	return root
}

func newADBCommand(global *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "adb", Short: "Inspect ADB devices", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error { return c.Help() }}
	cmd.AddCommand(newDevicesCommand(global, "adb"))
	return cmd
}

func newWin32Command(global *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "win32", Short: "Inspect Win32 desktop windows", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error { return c.Help() }}
	cmd.AddCommand(newDevicesCommand(global, "win32"))
	return cmd
}

func newDevicesCommand(global *cliOptions, kind string) *cobra.Command {
	var local deviceOptions
	cmd := &cobra.Command{
		Use: "devices", Aliases: []string{"list"}, Short: fmt.Sprintf("List %s devices", kind), Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			libDir, err := resolveLibDir(global.libDir)
			if err != nil {
				return err
			}
			if err := maa.Init(maa.WithLibDir(libDir), maa.WithStdoutLevel(maa.LoggingLevelOff)); err != nil {
				return fmt.Errorf("initialize MaaFramework from %s: %w", libDir, err)
			}
			defer func() { _ = maa.Release() }()
			if kind == "adb" {
				return listADB(local.json)
			}
			return listWin32(local.json)
		},
	}
	cmd.Flags().BoolVarP(&local.json, "json", "j", false, "output JSON")
	return cmd
}

func newInterfaceCommand(global *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "interface", Aliases: []string{"pi", "if"}, Short: "Inspect a ProjectInterface", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error { return c.Help() }}
	cmd.AddCommand(newInterfaceShowCommand(global), newInterfaceListCommand(global, "controllers"), newInterfaceListCommand(global, "resources"), newInterfaceListCommand(global, "tasks"), newInterfaceValidateCommand(global))
	return cmd
}

func newInterfaceShowCommand(global *cliOptions) *cobra.Command {
	return &cobra.Command{Use: "show", Aliases: []string{"s"}, Short: "Show ProjectInterface summary", Args: cobra.NoArgs, RunE: func(_ *cobra.Command, _ []string) error {
		pi, err := loadPI(global.interfacePath)
		if err != nil {
			return err
		}
		if global.json {
			return printJSON(map[string]any{"path": pi.Path, "name": pi.Name, "label": pi.Label, "interface_version": pi.InterfaceVersion, "controllers": len(pi.Controller), "resources": len(pi.Resource), "tasks": len(pi.Task)})
		}
		fmt.Printf("%s (%s)\ninterface: %s\ncontrollers: %d\nresources: %d\ntasks: %d\n", valueOrDash(pi.Label), valueOrDash(pi.Name), pi.Path, len(pi.Controller), len(pi.Resource), len(pi.Task))
		return nil
	}}
}

func newInterfaceListCommand(global *cliOptions, kind string) *cobra.Command {
	aliases := map[string][]string{"controllers": {"controller", "c"}, "resources": {"resource", "r"}, "tasks": {"task", "t"}}
	return &cobra.Command{Use: kind, Aliases: aliases[kind], Short: "List PI " + kind, Args: cobra.NoArgs, RunE: func(_ *cobra.Command, _ []string) error {
		pi, err := loadPI(global.interfacePath)
		if err != nil {
			return err
		}
		var value any
		switch kind {
		case "controllers":
			value = pi.Controller
		case "resources":
			value = pi.Resource
		case "tasks":
			value = pi.Task
		}
		if global.json {
			return printJSON(value)
		}
		switch v := value.(type) {
		case []controller:
			for _, x := range v {
				fmt.Printf("%s\t%s\t%s\n", x.Name, valueOrDash(x.Label), x.Type)
			}
		case []resource:
			for _, x := range v {
				fmt.Printf("%s\t%s\t%s\n", x.Name, valueOrDash(x.Label), join(x.Path))
			}
		case []task:
			for _, x := range v {
				fmt.Printf("%s\t%s\t%s\n", x.Name, valueOrDash(x.Label), x.Entry)
			}
		}
		return nil
	}}
}

func newInterfaceValidateCommand(global *cliOptions) *cobra.Command {
	return &cobra.Command{Use: "validate", Aliases: []string{"v", "check"}, Short: "Validate ProjectInterface loading", Args: cobra.NoArgs, RunE: func(_ *cobra.Command, _ []string) error {
		pi, err := loadPI(global.interfacePath)
		if err != nil {
			return err
		}
		if global.json {
			return printJSON(map[string]any{"valid": true, "path": pi.Path})
		}
		fmt.Printf("Valid ProjectInterface: %s\n", pi.Path)
		return nil
	}}
}

func listADB(jsonOutput bool) error {
	devices := maa.FindAdbDevices()
	if jsonOutput {
		out := make([]adbDeviceOutput, 0, len(devices))
		for _, d := range devices {
			out = append(out, adbDeviceOutput{Name: d.Name, AdbPath: d.AdbPath, Address: d.Address, ScreencapMethod: d.ScreencapMethod.String(), InputMethod: d.InputMethod.String(), Config: d.Config})
		}
		return printJSON(out)
	}
	if len(devices) == 0 {
		fmt.Println("No ADB devices found.")
		return nil
	}
	fmt.Printf("Found %d ADB device(s):\n", len(devices))
	for i, d := range devices {
		fmt.Printf("[%d] %s\n", i+1, valueOrDash(d.Name))
		fmt.Printf("    address: %s\n", valueOrDash(d.Address))
		fmt.Printf("    adb: %s\n", valueOrDash(d.AdbPath))
		fmt.Printf("    screencap: %s\n", valueOrDash(d.ScreencapMethod.String()))
		fmt.Printf("    input: %s\n", valueOrDash(d.InputMethod.String()))
	}
	return nil
}

func listWin32(jsonOutput bool) error {
	windows := maa.FindDesktopWindows()
	if jsonOutput {
		out := make([]desktopWindowOutput, 0, len(windows))
		for _, w := range windows {
			out = append(out, desktopWindowOutput{Handle: strconv.FormatUint(uint64(uintptr(w.Handle)), 16), ClassName: w.ClassName, WindowName: w.WindowName})
		}
		return printJSON(out)
	}
	if len(windows) == 0 {
		fmt.Println("No Win32 windows found.")
		return nil
	}
	fmt.Printf("Found %d Win32 window(s):\n", len(windows))
	for i, w := range windows {
		fmt.Printf("[%d] %s\n", i+1, valueOrDash(w.WindowName))
		fmt.Printf("    class: %s\n", valueOrDash(w.ClassName))
		fmt.Printf("    handle: 0x%s\n", strconv.FormatUint(uint64(uintptr(w.Handle)), 16))
	}
	return nil
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
func valueOrDash(v string) string {
	if strings.TrimSpace(v) == "" {
		return "-"
	}
	return v
}

func resolveLibDir(explicit string) (string, error) {
	candidates := make([]string, 0, 4)
	if explicit != "" {
		candidates = append(candidates, explicit)
	} else {
		if cwd, err := os.Getwd(); err == nil {
			candidates = append(candidates, filepath.Join(cwd, "maafw", "bin"))
		}
		if exe, err := os.Executable(); err == nil {
			d := filepath.Dir(exe)
			candidates = append(candidates, filepath.Join(d, "maafw", "bin"), filepath.Join(d, "..", "maafw", "bin"))
		}
	}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		absolute = filepath.Clean(absolute)
		if seen[absolute] {
			continue
		}
		seen[absolute] = true
		if fileExists(filepath.Join(absolute, "MaaFramework.dll")) && fileExists(filepath.Join(absolute, "MaaToolkit.dll")) {
			return absolute, nil
		}
	}
	if explicit != "" {
		return "", fmt.Errorf("MaaFramework DLLs not found in %q (expected MaaFramework.dll and MaaToolkit.dll)", explicit)
	}
	return "", fmt.Errorf("MaaFramework DLLs not found; expected them under %q", filepath.Join(".", "maafw", "bin"))
}
func fileExists(path string) bool { info, err := os.Stat(path); return err == nil && !info.IsDir() }
