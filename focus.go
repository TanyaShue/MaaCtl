package main

import (
	"fmt"
	"strings"
)

// renderFocus returns the log message declared for an exact MaaFramework callback.
// A string focus is shorthand for {content: string, display: "log"}; an object
// is emitted here only when its display includes the console's log channel.
func renderFocus(message string, detail any) string {
	values, ok := toObject(detail)
	if !ok {
		return ""
	}
	focus, ok := values["focus"].(map[string]any)
	if !ok {
		return ""
	}
	template, found := focus[message]
	if !found {
		return ""
	}
	content := ""
	switch v := template.(type) {
	case string:
		content = v
	case map[string]any:
		if !displaysLog(v["display"]) {
			return ""
		}
		content, _ = v["content"].(string)
	}
	if content == "" {
		return ""
	}
	for key, value := range values {
		content = strings.ReplaceAll(content, "{"+key+"}", fmt.Sprint(value))
	}
	return content
}

func toObject(value any) (map[string]any, bool) {
	// Event detail structs are normalized through their JSON representation in the sink.
	if object, ok := value.(map[string]any); ok {
		return object, true
	}
	return nil, false
}

func displaysLog(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return v == "log"
	case []any:
		for _, item := range v {
			if text, ok := item.(string); ok && text == "log" {
				return true
			}
		}
	}
	return false
}
