package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/mattn/go-runewidth"
	"github.com/spf13/cobra"
)

func newInterfaceCommand(global *cliOptions) *cobra.Command {
	actions := []struct{ name, shorthand, description string }{
		{"show", "s", "show ProjectInterface summary"},
		{"controllers", "c", "list controllers (name, label, type)"},
		{"resources", "r", "list resources (name, label, path)"},
		{"tasks", "t", "list tasks (name, label, entry)"},
		{"validate", "v", "validate ProjectInterface loading"},
		{"options", "", "planned: list PI option definitions"},
		{"presets", "", "planned: list PI presets"},
	}
	cmd := &cobra.Command{
		Use: "interface", Short: "Inspect and validate a ProjectInterface", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			action := ""
			for _, candidate := range actions {
				selected, _ := c.Flags().GetBool(candidate.name)
				if !selected {
					continue
				}
				if action != "" {
					return fmt.Errorf("choose only one interface action: --%s or --%s", action, candidate.name)
				}
				action = candidate.name
			}
			if action == "" {
				return c.Help()
			}
			return inspectInterface(c.OutOrStdout(), global, action)
		},
	}
	for _, action := range actions {
		cmd.Flags().BoolP(action.name, action.shorthand, false, action.description)
	}
	return cmd
}

func inspectInterface(out io.Writer, global *cliOptions, action string) error {
	if action == "options" || action == "presets" {
		return fmt.Errorf("interface --%s is not implemented yet", action)
	}
	pi, err := loadPI(global.interfacePath)
	if err != nil {
		return err
	}
	var value any
	var headers []string
	var rows [][]string
	switch action {
	case "show":
		value = map[string]any{"path": pi.Path, "name": pi.Name, "label": pi.Label, "interface_version": pi.InterfaceVersion, "controllers": len(pi.Controller), "resources": len(pi.Resource), "tasks": len(pi.Task)}
	case "validate":
		value = map[string]any{"valid": true, "path": pi.Path}
	case "controllers":
		value = pi.Controller
		headers = []string{"名称 (name)", "显示名称 (label)", "类型 (type)"}
		for _, item := range pi.Controller {
			rows = append(rows, []string{item.Name, item.Label, item.Type})
		}
	case "resources":
		value = pi.Resource
		headers = []string{"名称 (name)", "显示名称 (label)", "资源路径 (path)"}
		for _, item := range pi.Resource {
			rows = append(rows, []string{item.Name, item.Label, join(item.Path)})
		}
	case "tasks":
		value = pi.Task
		headers = []string{"名称 (name)", "显示名称 (label)", "入口节点 (entry)"}
		for _, item := range pi.Task {
			rows = append(rows, []string{item.Name, item.Label, item.Entry})
		}
	}
	if global.json {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(value)
	}
	switch action {
	case "show":
		_, err = fmt.Fprintf(out, "%s (%s)\ninterface: %s\ncontrollers: %d\nresources: %d\ntasks: %d\n", valueOrDash(pi.Label), valueOrDash(pi.Name), pi.Path, len(pi.Controller), len(pi.Resource), len(pi.Task))
		return err
	case "validate":
		_, err = fmt.Fprintf(out, "Valid ProjectInterface: %s\n", pi.Path)
		return err
	default:
		return printInterfaceTable(out, headers, rows)
	}
}

func printInterfaceTable(out io.Writer, headers []string, rows [][]string) error {
	// Use terminal cell widths so Chinese names align with Latin text and digits.
	width := runewidth.NewCondition()
	width.EastAsianWidth = false
	widths := make([]int, len(headers))
	escape := strings.NewReplacer("\t", "\\t", "\r", "\\r", "\n", "\\n")
	for i, header := range headers {
		widths[i] = width.StringWidth(header)
	}
	for _, row := range rows {
		for i, cell := range row {
			// Keep each value on one line, including labels containing tabs/newlines.
			row[i] = valueOrDash(escape.Replace(cell))
			widths[i] = max(widths[i], width.StringWidth(row[i]))
		}
	}
	var result strings.Builder
	writeRow := func(row []string) {
		for i, cell := range row {
			result.WriteString(cell)
			if i < len(row)-1 {
				result.WriteString(strings.Repeat(" ", widths[i]-width.StringWidth(cell)+2))
			}
		}
		result.WriteByte('\n')
	}
	writeRow(headers)
	separator := make([]string, len(headers))
	for i, size := range widths {
		separator[i] = strings.Repeat("-", size)
	}
	writeRow(separator)
	for _, row := range rows {
		writeRow(row)
	}
	if len(rows) == 0 {
		result.WriteString("（无数据）\n")
	}
	_, err := io.WriteString(out, result.String())
	return err
}
