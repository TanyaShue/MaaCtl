package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func interfaceFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "interface.json")
	data := `{
		"interface_version": 2, "name": "demo", "label": "示例",
		"controller": [{"name": "Android", "label": "安卓", "type": "Adb"}],
		"resource": [{"name": "base", "path": ["resource/base", "resource/extra"]}],
		"task": [
			{"name": "打开游戏", "label": "打开游戏", "entry": "启动游戏"},
			{"name": "自动999", "label": "自动999", "entry": "999-开始"},
			{"name": "daily", "entry": "DailyEntry"}
		]
	}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func interfaceOutput(args ...string) (string, error) {
	var out bytes.Buffer
	cmd := newRootCommand()
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func TestInterfaceActionFlags(t *testing.T) {
	path := interfaceFixture(t)
	for _, test := range []struct{ action, short, expected string }{
		{"show", "s", "示例 (demo)"},
		{"controllers", "c", "类型 (type)"},
		{"resources", "r", "资源路径 (path)"},
		{"tasks", "t", "入口节点 (entry)"},
		{"validate", "v", "Valid ProjectInterface:"},
	} {
		t.Run(test.action, func(t *testing.T) {
			long, err := interfaceOutput("interface", "--"+test.action, "-f", path)
			if err != nil || !strings.Contains(long, test.expected) {
				t.Fatalf("output = %q, err = %v", long, err)
			}
			short, err := interfaceOutput("interface", "-"+test.short, "-f", path)
			if err != nil || short != long {
				t.Fatalf("short flag output = %q, err = %v; want %q", short, err, long)
			}
		})
	}
}

func TestInterfaceRejectsInvalidActions(t *testing.T) {
	for _, action := range []string{"show", "controllers", "resources", "tasks", "validate", "options", "presets"} {
		if _, err := interfaceOutput("interface", action); err == nil {
			t.Errorf("legacy subcommand %q was accepted", action)
		}
	}
	for _, args := range [][]string{{"--tasks", "--controllers"}, {"--tasks", "--options"}, {"--options", "--presets"}} {
		if _, err := interfaceOutput(append([]string{"interface"}, args...)...); err == nil || !strings.Contains(err.Error(), "choose only one interface action") {
			t.Errorf("conflicting actions %v: %v", args, err)
		}
	}
	for _, action := range []string{"options", "presets"} {
		if _, err := interfaceOutput("interface", "--"+action); err == nil || err.Error() != "interface --"+action+" is not implemented yet" {
			t.Errorf("planned action %s: %v", action, err)
		}
	}
}

func TestInterfaceHelpUsesFlags(t *testing.T) {
	short, err := interfaceOutput("interface", "-h")
	if err != nil {
		t.Fatal(err)
	}
	long, err := interfaceOutput("interface", "--help")
	if err != nil || short != long {
		t.Fatalf("help aliases differ: %v", err)
	}
	root, err := interfaceOutput("-h")
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"show", "controllers", "resources", "tasks", "validate", "options", "presets"} {
		if !strings.Contains(short, "--"+action) || !strings.Contains(root, "--"+action) || strings.Contains(root, "maactl interface "+action) {
			t.Errorf("action %s missing from help or still shown as a subcommand", action)
		}
	}
}

func TestInterfaceTasksJSON(t *testing.T) {
	output, err := interfaceOutput("interface", "--tasks", "--json", "-f", interfaceFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	var tasks []task
	if err := json.Unmarshal([]byte(output), &tasks); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, output)
	}
	if len(tasks) != 3 || tasks[0].Name != "打开游戏" || tasks[0].Label != "打开游戏" || tasks[0].Entry != "启动游戏" || tasks[2].Label != "" {
		t.Fatalf("unexpected tasks: %+v", tasks)
	}
}

func TestInterfaceTableAlignment(t *testing.T) {
	output, err := interfaceOutput("interface", "--tasks", "-f", interfaceFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	want := "名称 (name)  显示名称 (label)  入口节点 (entry)\n" +
		"-----------  ----------------  ----------------\n" +
		"打开游戏     打开游戏          启动游戏\n" +
		"自动999      自动999           999-开始\n" +
		"daily        -                 DailyEntry\n"
	if output != want {
		t.Fatalf("got:\n%s\nwant:\n%s", output, want)
	}
	var out bytes.Buffer
	if err := printInterfaceTable(&out, []string{"名称 (name)"}, nil); err != nil || !strings.Contains(out.String(), "（无数据）") {
		t.Fatalf("empty list = %q, err = %v", out.String(), err)
	}
	out.Reset()
	if err := printInterfaceTable(&out, []string{"name"}, [][]string{{"a\tb\nc"}}); err != nil || !strings.Contains(out.String(), `a\tb\nc`) {
		t.Fatalf("multiline cell = %q, err = %v", out.String(), err)
	}
}
