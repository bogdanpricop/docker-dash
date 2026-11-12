package ar

import (
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestNegativeMemberSize(t *testing.T) {
	archive := func(size int, content string) *Reader {
		header := fmt.Sprintf("%-16s%-12d%-6d%-6d%-8d%-10d%s", "member", 0, 0, 0, 100644, size, "`\n")
		return NewReader(strings.NewReader("!<arch>\n" + header + content))
	}

	reader := archive(-1, "")
	if header, err := reader.Next(); header != nil || err == nil {
		t.Fatalf("accepted negative archive size, header=%v err=%v", header, err)
	}
	if _, err := reader.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("read after invalid header returned %v", err)
	}

	reader = archive(3, "abc\n")
	if _, err := reader.Next(); err != nil {
		t.Fatal(err)
	}
	if content, err := io.ReadAll(reader); err != nil || string(content) != "abc" {
		t.Fatalf("valid member returned %q, %v", content, err)
	}
}
