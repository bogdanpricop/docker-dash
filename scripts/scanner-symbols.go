// Inspect Go Linux scanner binaries without executing them. Function presence
// does not establish reachability; absence from pclntab alone does not account
// for inlined code. Pair this evidence with the exact build's package graph.
package main

import (
	"crypto/sha256"
	"debug/buildinfo"
	"debug/elf"
	"debug/gosym"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

func inspect() error {
	if len(os.Args) < 3 {
		return fmt.Errorf("usage: go run scripts/scanner-symbols.go BINARY PACKAGE_PREFIX...")
	}
	name := os.Args[1]
	raw, err := os.Open(name)
	if err != nil {
		return err
	}
	defer raw.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, raw); err != nil {
		return err
	}
	f, err := elf.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	section, code := f.Section(".gopclntab"), f.Section(".text")
	if section == nil || code == nil {
		return fmt.Errorf("required Go ELF sections are missing")
	}
	data, err := section.Data()
	if err != nil {
		return err
	}
	table, err := gosym.NewTable(nil, gosym.NewLineTable(data, code.Addr))
	if err != nil {
		return err
	}
	info, err := buildinfo.ReadFile(name)
	if err != nil {
		return err
	}
	matches := map[string][]string{}
	for _, prefix := range os.Args[2:] {
		matches[prefix] = []string{}
		for _, function := range table.Funcs {
			if strings.Contains(function.Name, prefix) {
				matches[prefix] = append(matches[prefix], function.Name)
			}
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"sha256": hex.EncodeToString(hash.Sum(nil)), "buildInfo": info,
		"totalFunctions": len(table.Funcs), "functionsByPrefix": matches,
	})
}

func main() {
	if err := inspect(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
