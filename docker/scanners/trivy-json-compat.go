// Apply the Go team's documented SkipFunc -> errors.ErrUnsupported migration
// through a compiler overlay, preserving the verified upstream module cache.
// https://go.googlesource.com/go/+/770864f3b452dbd83e33e42b9659c387d03425b9
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"strings"
)

func generate() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("expected source module directory and output directory")
	}
	directory, err := filepath.Abs(os.Args[2])
	if err != nil {
		return err
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	replacements := map[string]string{}
	files := []struct{ path, checksum string }{
		{"pkg/x/json/json.go", "cdc752806a0469b8ac59cd2417e9486e240db503f4e6adf40050df26a52cd67d"},
		{"pkg/iac/scanners/cloudformation/parser/parameter.go", "4bfac9ea4a555558fba06904a06712ea1bf36fbf7477aed7b8da920c2ac0b58a"},
	}
	for _, file := range files {
		source, err := filepath.Abs(filepath.Join(os.Args[1], filepath.FromSlash(file.path)))
		if err != nil {
			return err
		}
		data, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != file.checksum {
			return fmt.Errorf("Trivy compatibility patch source hash mismatch: %s", file.path)
		}
		text := string(data)
		if !strings.Contains(text, "\"errors\"") {
			text = strings.Replace(text, "\"encoding/json/v2\"", "\"encoding/json/v2\"\n\t\"errors\"", 1)
		}
		text = strings.Replace(text, "return json.SkipFunc", "return errors.ErrUnsupported", 1)
		patched, err := format.Source([]byte(text))
		if err != nil {
			return err
		}
		target := filepath.Join(directory, filepath.Base(file.path))
		if err = os.WriteFile(target, patched, 0600); err != nil {
			return err
		}
		replacements[source] = target
	}
	moduleData, err := os.ReadFile(filepath.Join(os.Args[1], "go.mod"))
	if err != nil {
		return err
	}
	moduleSum := sha256.Sum256(moduleData)
	if hex.EncodeToString(moduleSum[:]) != "85697654fc5fea7d0a0082920bed1116af5d06dbd2be0fcc0c281b68a35c8e33" {
		return fmt.Errorf("Trivy module compatibility patch source hash mismatch")
	}
	if strings.Count(string(moduleData), "\ngo 1.26.3\n") != 1 {
		return fmt.Errorf("Trivy module compatibility patch expected Go directive missing")
	}
	moduleText := strings.Replace(string(moduleData), "\ngo 1.26.3\n", "\ngo 1.27.1\n", 1)
	if err = os.WriteFile(filepath.Join(directory, "go.mod"), []byte(moduleText), 0600); err != nil {
		return err
	}
	overlay, err := json.Marshal(map[string]any{"Replace": replacements})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(directory, "overlay.json"), overlay, 0600)
}

func main() {
	if err := generate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
