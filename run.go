package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	maa "github.com/MaaXYZ/maa-framework-go/v3"
	"github.com/MaaXYZ/maa-framework-go/v3/controller/adb"
	"github.com/spf13/cobra"
)

type runOptions struct {
	resource, controller, adbAddress string
	override, overrideFile           string
	optionValues, overlay            []string
	stopAfter                        time.Duration
}

func newRunCommand(global *cliOptions) *cobra.Command {
	var taskName, nodeName string
	var opt runOptions
	cmd := &cobra.Command{Use: "run", Short: "Run PI tasks or Pipeline nodes", Long: "Run supports task, node and (planned) preset execution. Shortcuts: -t <task-name>, -n <node-name>. Use --help with a subcommand to view all options.", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error {
		if taskName != "" && nodeName != "" {
			return fmt.Errorf("choose only one run shortcut: -t/--task or -n/--node")
		}
		if taskName != "" {
			return runTask(global, taskName, opt)
		}
		if nodeName != "" {
			return runNode(global, nodeName, opt)
		}
		return c.Help()
	}}
	cmd.Flags().StringVarP(&taskName, "task", "t", "", "shortcut for: run task <task-name>")
	cmd.Flags().StringVarP(&nodeName, "node", "n", "", "shortcut for: run node <node-name>")
	addRunFlags(cmd, &opt)
	cmd.AddCommand(newRunTaskCommand(global), newRunNodeCommand(global), plannedRunCommand("preset", "Run the enabled tasks in a PI preset"))
	return cmd
}

func newResourceCommand(global *cliOptions) *cobra.Command {
	var resourceName string
	var inspect, nodes bool
	cmd := &cobra.Command{Use: "resource", Short: "Load and inspect PI resources", Long: "Load and inspect PI resources. Shortcuts: -i inspect, -n nodes.", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error {
		if !inspect && !nodes {
			return c.Help()
		}
		if inspect && nodes {
			return fmt.Errorf("choose only one resource shortcut")
		}
		pi, err := loadPI(global.interfacePath)
		if err != nil {
			return err
		}
		var ctrl *controller
		if len(pi.Controller) == 1 {
			ctrl = &pi.Controller[0]
		} else {
			ctrl = &controller{}
		}
		res, err := pi.findResource(resourceName, ctrl)
		if err != nil {
			return err
		}
		return inspectResource(global, pi, res, nodes)
	}}
	add := func(use string, aliases []string, short string, nodes bool) {
		cmd.AddCommand(&cobra.Command{Use: use, Aliases: aliases, Short: short, Args: cobra.NoArgs, RunE: func(_ *cobra.Command, _ []string) error {
			pi, err := loadPI(global.interfacePath)
			if err != nil {
				return err
			}
			var ctrl *controller
			if len(pi.Controller) == 1 {
				ctrl = &pi.Controller[0]
			} else {
				ctrl = &controller{}
			}
			res, err := pi.findResource(resourceName, ctrl)
			if err != nil {
				return err
			}
			return inspectResource(global, pi, res, nodes)
		}})
	}
	add("inspect", nil, "Show loaded resource metadata", false)
	add("nodes", nil, "List loaded Pipeline nodes", true)
	cmd.AddCommand(plannedResourceCommand("hash", "Print or verify the loaded resource hash"))
	cmd.PersistentFlags().StringVarP(&resourceName, "resource", "r", "", "PI resource name (default: first resource)")
	cmd.Flags().BoolVarP(&inspect, "inspect", "i", false, "shortcut for: resource inspect")
	cmd.Flags().BoolVarP(&nodes, "nodes", "n", false, "shortcut for: resource nodes")
	return cmd
}

func plannedRunCommand(use, short string) *cobra.Command {
	return &cobra.Command{Use: use + " <name>", Short: short + " (planned)", Long: short + ". This command is part of the published CLI contract but is not implemented yet.", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, _ []string) error { return fmt.Errorf("run %s is not implemented yet", use) }}
}

func plannedResourceCommand(use, short string) *cobra.Command {
	return &cobra.Command{Use: use, Short: short + " (planned)", Long: short + ". This command is part of the published CLI contract but is not implemented yet.", Args: cobra.NoArgs, RunE: func(_ *cobra.Command, _ []string) error { return fmt.Errorf("resource %s is not implemented yet", use) }}
}

func inspectResource(global *cliOptions, pi *loadedPI, spec *resource, listNodes bool) error {
	libDir, err := resolveLibDir(global.libDir)
	if err != nil {
		return err
	}
	if err := maa.Init(maa.WithLibDir(libDir), maa.WithStdoutLevel(maa.LoggingLevelOff)); err != nil {
		return err
	}
	defer func() { _ = maa.Release() }()
	res := maa.NewResource()
	if res == nil {
		return fmt.Errorf("create Maa resource")
	}
	defer res.Destroy()
	paths := make([]string, 0, len(spec.Path))
	for _, path := range spec.Path {
		full := filepath.Join(pi.Dir, path)
		if !res.PostBundle(full).Wait().Success() {
			return fmt.Errorf("load resource %s", full)
		}
		paths = append(paths, full)
	}
	if listNodes {
		nodes, ok := res.GetNodeList()
		if !ok {
			return fmt.Errorf("read resource nodes")
		}
		if global.json {
			return printJSON(nodes)
		}
		for _, node := range nodes {
			fmt.Println(node)
		}
		return nil
	}
	hash, _ := res.GetHash()
	nodes, _ := res.GetNodeList()
	result := map[string]any{"name": spec.Name, "paths": paths, "hash": hash, "expected_hash": spec.Hash, "node_count": len(nodes)}
	if global.json {
		return printJSON(result)
	}
	fmt.Printf("resource: %s\nhash: %s\nnodes: %d\n", spec.Name, hash, len(nodes))
	return nil
}

func addRunFlags(cmd *cobra.Command, opt *runOptions) {
	cmd.Flags().StringVarP(&opt.resource, "resource", "r", "", "PI resource name (default: first compatible resource)")
	cmd.Flags().StringVarP(&opt.controller, "controller", "c", "", "PI controller name (default: only controller)")
	cmd.Flags().StringVarP(&opt.adbAddress, "adb-address", "a", "", "ADB device serial/address (default: only detected device)")
	cmd.Flags().StringVarP(&opt.override, "override", "o", "", "final pipeline override JSON")
	cmd.Flags().StringVarP(&opt.overrideFile, "override-file", "O", "", "file containing final pipeline override JSON")
	cmd.Flags().StringArrayVarP(&opt.optionValues, "option", "p", nil, "planned: option value as name=<JSON>; repeatable")
	cmd.Flags().StringArrayVar(&opt.overlay, "overlay", nil, "planned: additional resource root loaded after the selected resource; repeatable")
	cmd.Flags().String("option-file", "", "planned: JSON file of option values")
	cmd.Flags().Bool("dry-run", false, "planned: resolve and display execution without connecting a controller")
	cmd.Flags().Bool("explain", false, "planned: display resource and Pipeline override layers")
	cmd.Flags().String("events", "text", "planned: event format: text, jsonl, or off")
	cmd.Flags().DurationVar(&opt.stopAfter, "stop-after", 0, "stop a running task after this duration (for bounded runs/tests)")
}

func newRunTaskCommand(global *cliOptions) *cobra.Command {
	var opt runOptions
	cmd := &cobra.Command{Use: "task <task-name>", Short: "Run a task declared in ProjectInterface", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		return runTask(global, args[0], opt)
	}}
	addRunFlags(cmd, &opt)
	return cmd
}

func newRunNodeCommand(global *cliOptions) *cobra.Command {
	var opt runOptions
	cmd := &cobra.Command{Use: "node <node-name>", Short: "Run a Pipeline node from a PI resource", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		return runNode(global, args[0], opt)
	}}
	addRunFlags(cmd, &opt)
	return cmd
}

func runTask(global *cliOptions, name string, opt runOptions) error {
	pi, err := loadPI(global.interfacePath)
	if err != nil {
		return err
	}
	ctrl, err := pi.findController(opt.controller)
	if err != nil {
		return err
	}
	res, err := pi.findResource(opt.resource, ctrl)
	if err != nil {
		return err
	}
	override, err := readOverride(opt)
	if err != nil {
		return err
	}
	t, err := pi.findTask(name, ctrl, res)
	if err != nil {
		return err
	}
	return execute(global, pi, ctrl, res, t.Entry, override, opt)
}

func runNode(global *cliOptions, name string, opt runOptions) error {
	pi, err := loadPI(global.interfacePath)
	if err != nil {
		return err
	}
	ctrl, err := pi.findController(opt.controller)
	if err != nil {
		return err
	}
	res, err := pi.findResource(opt.resource, ctrl)
	if err != nil {
		return err
	}
	override, err := readOverride(opt)
	if err != nil {
		return err
	}
	return execute(global, pi, ctrl, res, name, override, opt)
}

func readOverride(opt runOptions) (any, error) {
	if opt.override != "" && opt.overrideFile != "" {
		return nil, fmt.Errorf("--override/-o and --override-file/-O cannot be used together")
	}
	b := []byte(opt.override)
	if opt.overrideFile != "" {
		var err error
		b, err = os.ReadFile(opt.overrideFile)
		if err != nil {
			return nil, fmt.Errorf("read override: %w", err)
		}
	}
	if len(b) == 0 {
		return map[string]any{}, nil
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("parse pipeline override: %w", err)
	}
	return out, nil
}

func execute(global *cliOptions, pi *loadedPI, piCtrl *controller, piRes *resource, entry string, override any, opt runOptions) error {
	libDir, err := resolveLibDir(global.libDir)
	if err != nil {
		return err
	}
	if err := maa.Init(maa.WithLibDir(libDir), maa.WithStdoutLevel(maa.LoggingLevelOff)); err != nil {
		return fmt.Errorf("initialize MaaFramework from %s: %w", libDir, err)
	}
	defer func() { _ = maa.Release() }()

	res := maa.NewResource()
	if res == nil {
		return fmt.Errorf("create Maa resource")
	}
	defer res.Destroy()
	for _, p := range piRes.Path {
		full := filepath.Join(pi.Dir, p)
		job := res.PostBundle(full).Wait()
		if !job.Success() {
			return fmt.Errorf("load resource %s: %s", full, job.Status())
		}
	}
	ctrl, err := createController(piCtrl, opt)
	if err != nil {
		return err
	}
	defer ctrl.Destroy()
	if !ctrl.PostConnect().Wait().Success() {
		return fmt.Errorf("connect controller %q", piCtrl.Name)
	}
	tasker := maa.NewTasker()
	if tasker == nil {
		return fmt.Errorf("create Maa tasker")
	}
	defer tasker.Destroy()
	if !tasker.BindResource(res) || !tasker.BindController(ctrl) || !tasker.Initialized() {
		return fmt.Errorf("initialize Maa tasker")
	}
	tasker.AddSink(&consoleTaskerSink{json: global.json})

	fmt.Printf("Running %s (resource=%s controller=%s)\n", entry, piRes.Name, piCtrl.Name)
	job := tasker.PostTask(entry, override)
	if opt.stopAfter > 0 {
		done := make(chan maa.Status, 1)
		go func() { done <- job.Wait().Status() }()
		select {
		case status := <-done:
			if !status.Success() {
				return fmt.Errorf("task %q finished with %s before --stop-after", entry, status)
			}
			fmt.Println("Task succeeded")
			return nil
		case <-time.After(opt.stopAfter):
			fmt.Fprintf(os.Stderr, "Stopping task after %s\n", opt.stopAfter)
			// PostStop is asynchronous.  Waiting for the original infinite task or
			// the stop job can itself block forever on a misbehaving pipeline.
			// Send the framework stop signal, then give callbacks a brief chance to flush.
			tasker.PostStop()
			time.Sleep(250 * time.Millisecond)
			fmt.Println("Task stopped by --stop-after")
			return nil
		}
	}
	job.Wait()
	if !job.Success() {
		return fmt.Errorf("task %q finished with %s", entry, job.Status())
	}
	fmt.Println("Task succeeded")
	return nil
}

func createController(spec *controller, opt runOptions) (*maa.Controller, error) {
	if spec.Type != "Adb" {
		return nil, fmt.Errorf("controller %q has unsupported type %q; this build supports Adb task execution", spec.Name, spec.Type)
	}
	address, adbPath, config := opt.adbAddress, "", ""
	if address == "" {
		devices := maa.FindAdbDevices()
		if len(devices) == 0 {
			return nil, fmt.Errorf("no ADB devices found; specify --adb-address/-a after connecting a device")
		}
		if len(devices) > 1 {
			names := make([]string, len(devices))
			for i, d := range devices {
				names[i] = d.Address
			}
			return nil, fmt.Errorf("%d ADB devices found; specify --adb-address/-a: %s", len(devices), join(names))
		}
		address = devices[0].Address
		adbPath = devices[0].AdbPath
		config = devices[0].Config
	}
	sc, err := adb.ParseScreencapMethod(spec.Adb.Screencap)
	if err != nil {
		return nil, err
	}
	if spec.Adb.Screencap == "" {
		sc = adb.ScreencapDefault
	}
	in, err := adb.ParseInputMethod(spec.Adb.Input)
	if err != nil {
		return nil, err
	}
	if spec.Adb.Input == "" {
		in = adb.InputDefault
	}
	ctrl := maa.NewAdbController(adbPath, address, sc, in, config, "")
	if ctrl == nil {
		return nil, fmt.Errorf("create ADB controller for %s", address)
	}
	return ctrl, nil
}

// consoleTaskerSink prints every node event emitted through MaaFramework's tasker sink.
type consoleTaskerSink struct {
	json bool
	mu   sync.Mutex
}

func (s *consoleTaskerSink) output(kind string, event maa.EventStatus, detail any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.Marshal(detail)
	var values map[string]any
	_ = json.Unmarshal(b, &values)
	message := kind + "." + eventName(event)
	focus := renderFocus(message, values)
	if s.json {
		out := map[string]any{"event": message, "status": event, "detail": values}
		if focus != "" {
			out["focus"] = focus
		}
		b, _ = json.Marshal(out)
		fmt.Println(string(b))
		return
	}
	if focus != "" {
		fmt.Printf("%s\n", focus)
	}
	fmt.Printf("%s %s\n", message, b)
}

func eventName(event maa.EventStatus) string {
	switch event {
	case maa.EventStatusStarting:
		return "Starting"
	case maa.EventStatusSucceeded:
		return "Succeeded"
	case maa.EventStatusFailed:
		return "Failed"
	default:
		return "Unknown"
	}
}
func (s *consoleTaskerSink) OnResourceLoading(_ *maa.Tasker, e maa.EventStatus, d maa.ResourceLoadingDetail) {
	s.output("Resource.Loading", e, d)
}
func (s *consoleTaskerSink) OnControllerAction(_ *maa.Tasker, e maa.EventStatus, d maa.ControllerActionDetail) {
	s.output("Controller.Action", e, d)
}
func (s *consoleTaskerSink) OnTaskerTask(_ *maa.Tasker, e maa.EventStatus, d maa.TaskerTaskDetail) {
	s.output("Tasker.Task", e, d)
}
func (s *consoleTaskerSink) OnNodePipelineNode(_ *maa.Tasker, e maa.EventStatus, d maa.NodePipelineNodeDetail) {
	s.output("Node.PipelineNode", e, d)
}
func (s *consoleTaskerSink) OnNodeRecognitionNode(_ *maa.Tasker, e maa.EventStatus, d maa.NodeRecognitionNodeDetail) {
	s.output("Node.RecognitionNode", e, d)
}
func (s *consoleTaskerSink) OnNodeActionNode(_ *maa.Tasker, e maa.EventStatus, d maa.NodeActionNodeDetail) {
	s.output("Node.ActionNode", e, d)
}
func (s *consoleTaskerSink) OnTaskNextList(_ *maa.Tasker, e maa.EventStatus, d maa.NodeNextListDetail) {
	s.output("Node.NextList", e, d)
}
func (s *consoleTaskerSink) OnTaskRecognition(_ *maa.Tasker, e maa.EventStatus, d maa.NodeRecognitionDetail) {
	s.output("Node.Recognition", e, d)
}
func (s *consoleTaskerSink) OnTaskAction(_ *maa.Tasker, e maa.EventStatus, d maa.NodeActionDetail) {
	s.output("Node.Action", e, d)
}
func (s *consoleTaskerSink) OnUnknownEvent(_ *maa.Tasker, msg, details string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Printf("%s %s\n", msg, details)
}
