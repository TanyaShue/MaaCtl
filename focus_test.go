package main

import "testing"

func TestRenderFocus(t *testing.T) {
	detail := map[string]any{
		"name": "签到", "task_id": float64(7),
		"focus": map[string]any{
			"Node.Recognition.Starting": "开始{name}，任务 {task_id}",
			"Node.Action.Succeeded":     map[string]any{"content": "完成{name}", "display": []any{"toast", "log"}},
			"Node.Action.Failed":        map[string]any{"content": "不应输出", "display": "toast"},
		},
	}
	if got, want := renderFocus("Node.Recognition.Starting", detail), "开始签到，任务 7"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got, want := renderFocus("Node.Action.Succeeded", detail), "完成签到"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got := renderFocus("Node.Action.Failed", detail); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}
