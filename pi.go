package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// projectInterface is the subset of ProjectInterface v2 required to select and run a task.
// Unknown PI fields are deliberately retained by json.Unmarshal's forward-compatible behavior.
type projectInterface struct {
	InterfaceVersion int          `json:"interface_version"`
	Name             string       `json:"name"`
	Label            string       `json:"label"`
	Controller       []controller `json:"controller"`
	Resource         []resource   `json:"resource"`
	Task             []task       `json:"task"`
	Import           []string     `json:"import"`
}

type controller struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Type  string `json:"type"`
	Adb   struct {
		Screencap string `json:"screencap"`
		Input     string `json:"input"`
	} `json:"adb"`
}

type resource struct {
	Name       string   `json:"name"`
	Label      string   `json:"label"`
	Path       []string `json:"path"`
	Controller []string `json:"controller"`
	Hash       string   `json:"hash"`
}

type task struct {
	Name       string   `json:"name"`
	Label      string   `json:"label"`
	Entry      string   `json:"entry"`
	Controller []string `json:"controller"`
	Resource   []string `json:"resource"`
	Override   any      `json:"pipeline_override"`
}

type loadedPI struct {
	projectInterface
	Path string
	Dir  string
}

func loadPI(path string) (*loadedPI, error) {
	if path == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(cwd, "interface.json")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read interface: %w", err)
	}
	if info.IsDir() {
		path = filepath.Join(path, "interface.json")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	pi, err := loadPIFile(abs, seen)
	if err != nil {
		return nil, err
	}
	if pi.InterfaceVersion != 2 {
		return nil, fmt.Errorf("%s: interface_version must be 2, got %d", abs, pi.InterfaceVersion)
	}
	return &loadedPI{projectInterface: *pi, Path: abs, Dir: filepath.Dir(abs)}, nil
}

func loadPIFile(path string, seen map[string]bool) (*projectInterface, error) {
	path = filepath.Clean(path)
	if seen[path] {
		return nil, fmt.Errorf("cyclic PI import: %s", path)
	}
	seen[path] = true
	defer delete(seen, path)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read PI file %s: %w", path, err)
	}
	var current projectInterface
	if err := json.Unmarshal(stripJSONC(b), &current); err != nil {
		return nil, fmt.Errorf("parse PI file %s: %w", path, err)
	}
	base := filepath.Dir(path)
	for _, imported := range current.Import {
		child, err := loadPIFile(filepath.Join(base, imported), seen)
		if err != nil {
			return nil, err
		}
		current.Task = append(current.Task, child.Task...)
		current.Controller = append(current.Controller, child.Controller...)
		current.Resource = append(current.Resource, child.Resource...)
	}
	return &current, nil
}

// stripJSONC removes // and /* */ comments while preserving comment-like text in JSON strings.
func stripJSONC(in []byte) []byte {
	var out bytes.Buffer
	inString, escaped := false, false
	for i := 0; i < len(in); i++ {
		c := in[i]
		if inString {
			out.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		if c == '"' {
			inString = true
			out.WriteByte(c)
			continue
		}
		if c == '/' && i+1 < len(in) && in[i+1] == '/' {
			for i < len(in) && in[i] != '\n' {
				i++
			}
			if i < len(in) {
				out.WriteByte('\n')
			}
			continue
		}
		if c == '/' && i+1 < len(in) && in[i+1] == '*' {
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i++
			continue
		}
		out.WriteByte(c)
	}
	return out.Bytes()
}

func (p *loadedPI) findController(name string) (*controller, error) {
	if name == "" {
		if len(p.Controller) == 1 {
			return &p.Controller[0], nil
		}
		return nil, fmt.Errorf("%d controllers found; specify --controller/-c: %s", len(p.Controller), joinControllerNames(p.Controller))
	}
	for i := range p.Controller {
		if p.Controller[i].Name == name {
			return &p.Controller[i], nil
		}
	}
	return nil, fmt.Errorf("controller %q not found", name)
}

func (p *loadedPI) findResource(name string, ctrl *controller) (*resource, error) {
	for i := range p.Resource {
		r := &p.Resource[i]
		if name != "" && r.Name != name {
			continue
		}
		if compatible(r.Controller, ctrl.Name) {
			return r, nil
		}
	}
	if name == "" {
		return nil, fmt.Errorf("no resource compatible with controller %q", ctrl.Name)
	}
	return nil, fmt.Errorf("resource %q is missing or incompatible with controller %q", name, ctrl.Name)
}

func (p *loadedPI) findTask(name string, ctrl *controller, res *resource) (*task, error) {
	for i := range p.Task {
		if p.Task[i].Name == name {
			t := &p.Task[i]
			if !compatible(t.Controller, ctrl.Name) || !compatible(t.Resource, res.Name) {
				return nil, fmt.Errorf("task %q is incompatible with controller %q or resource %q", name, ctrl.Name, res.Name)
			}
			return t, nil
		}
	}
	return nil, fmt.Errorf("task %q not found", name)
}

func compatible(items []string, value string) bool {
	if len(items) == 0 {
		return true
	}
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
func joinControllerNames(items []controller) string {
	names := make([]string, len(items))
	for i := range items {
		names[i] = items[i].Name
	}
	return join(names)
}
func join(items []string) string {
	var b bytes.Buffer
	for i, item := range items {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(item)
	}
	return b.String()
}
