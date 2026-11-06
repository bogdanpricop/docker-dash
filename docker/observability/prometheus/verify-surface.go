// This checker ties a narrowly scoped applicability result to the actual ELF
// binaries and the package graphs emitted by their original build environment.
// It does not suppress scanner findings or establish whole-image security.
package main

import (
	"crypto/sha256"
	"debug/elf"
	"debug/gosym"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func check(name string) error {
	binaryPath := filepath.Join("/out", name)
	data, err := os.ReadFile(binaryPath)
	if err != nil {
		return err
	}
	file, err := elf.Open(binaryPath)
	if err != nil {
		return err
	}
	defer file.Close()
	pcln, text := file.Section(".gopclntab"), file.Section(".text")
	if pcln == nil || text == nil {
		return fmt.Errorf("%s: missing Go symbol sections", name)
	}
	tableData, err := pcln.Data()
	if err != nil {
		return err
	}
	table, err := gosym.NewTable(nil, gosym.NewLineTable(tableData, text.Addr))
	if err != nil {
		return err
	}
	if len(table.Funcs) < 1000 {
		return fmt.Errorf("%s: incomplete function table", name)
	}
	mainFound := false
	for _, fn := range table.Funcs {
		if fn.Name == "main.main" {
			mainFound = true
		}
		if strings.Contains(fn.Name, "/openpgp") || strings.Contains(fn.Name, "/s3crypto") {
			return fmt.Errorf("%s: affected function remains: %s", name, fn.Name)
		}
	}
	if !mainFound {
		return fmt.Errorf("%s: main function missing", name)
	}
	graph, err := os.ReadFile(filepath.Join("/out/provenance", name+".packages.txt"))
	if err != nil {
		return err
	}
	packages := strings.Fields(string(graph))
	rootFound := false
	for _, pkg := range packages {
		if pkg == "github.com/prometheus/prometheus/cmd/"+name {
			rootFound = true
		}
		if strings.HasPrefix(pkg, "golang.org/x/crypto/openpgp") || strings.HasPrefix(pkg, "github.com/aws/aws-sdk-go/service/s3/s3crypto") {
			return fmt.Errorf("%s: affected package remains: %s", name, pkg)
		}
	}
	if !rootFound || len(packages) < 1000 {
		return fmt.Errorf("%s: incomplete package graph", name)
	}
	sum, graphSum := sha256.Sum256(data), sha256.Sum256(graph)
	result := map[string]any{
		"binary": name, "sha256": hex.EncodeToString(sum[:]),
		"packageGraphSha256": hex.EncodeToString(graphSum[:]),
		"packageCount":       len(packages), "functionCount": len(table.Funcs),
		"openpgpPackageAndSymbolsAbsent": true, "s3cryptoPackageAndSymbolsAbsent": true,
	}
	output, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join("/out/provenance", name+".surface.json"), append(output, '\n'), 0644)
}

func main() {
	for _, name := range []string{"prometheus", "promtool"} {
		if err := check(name); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
