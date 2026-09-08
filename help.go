package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Render the selected command and its descendants so every option is visible
// from the root, while subcommand help stays scoped to that command.
func setFullHelp(root *cobra.Command) {
	defaultHelp := root.HelpFunc()
	var fullHelp func(*cobra.Command, []string)
	fullHelp = func(cmd *cobra.Command, args []string) {
		// Descendants have not been executed, so Cobra has not added -h yet.
		cmd.InitDefaultHelpFlag()
		defaultHelp(cmd, args)
		for _, child := range cmd.Commands() {
			if !child.IsAvailableCommand() {
				continue
			}
			fmt.Fprintf(cmd.OutOrStdout(), "\nCommand: %s\n\n", child.CommandPath())
			fullHelp(child, args)
		}
	}
	root.SetHelpFunc(fullHelp)
}
