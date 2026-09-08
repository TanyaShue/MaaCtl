package main

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// List commands and their flags without repeating full help pages.
func setFullHelp(root *cobra.Command) {
	root.SetHelpFunc(func(cmd *cobra.Command, _ []string) {
		out := cmd.OutOrStdout()
		common := pflag.NewFlagSet("common", pflag.ContinueOnError)
		common.AddFlagSet(cmd.InheritedFlags())
		if cmd == root {
			common.AddFlagSet(root.PersistentFlags())
		}
		common.BoolP("help", "h", false, "show help")
		fmt.Fprintln(out, "Global flags:")
		fmt.Fprint(out, common.FlagUsages())

		var listCommands func(*cobra.Command)
		listCommands = func(current *cobra.Command) {
			local := pflag.NewFlagSet(current.Name(), pflag.ContinueOnError)
			current.LocalFlags().VisitAll(func(flag *pflag.Flag) {
				if flag.Name == "help" || sameHelpFlag(flag, common.Lookup(flag.Name)) {
					return
				}
				local.AddFlag(flag)
			})
			status := ""
			if strings.HasSuffix(current.Short, "(planned)") {
				status = " (planned)"
			}
			fmt.Fprintf(out, "\n%s%s\n", current.UseLine(), status)
			fmt.Fprint(out, local.FlagUsages())
			var inherited []string
			current.InheritedFlags().VisitAll(func(flag *pflag.Flag) {
				if !flag.Hidden && flag.Deprecated == "" && !sameHelpFlag(flag, common.Lookup(flag.Name)) {
					inherited = append(inherited, "--"+flag.Name)
				}
			})
			if len(inherited) > 0 {
				fmt.Fprintf(out, "  Inherited flags: %s (see parent command)\n", strings.Join(inherited, ", "))
			}
			for _, child := range current.Commands() {
				if child.IsAvailableCommand() {
					listCommands(child)
				}
			}
		}
		listCommands(cmd)
	})
}

func sameHelpFlag(a, b *pflag.Flag) bool {
	return b != nil && a.Shorthand == b.Shorthand && a.Usage == b.Usage &&
		a.DefValue == b.DefValue && a.Value.Type() == b.Value.Type()
}
