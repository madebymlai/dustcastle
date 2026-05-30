package sample

import (
	"strings"
	"testing"
)

// TestSlogan proves the external dependency (rsc.io/quote) was resolved,
// built, and is callable -- i.e. the lockfile deps really made it into the build.
func TestSlogan(t *testing.T) {
	got := Slogan()
	if !strings.Contains(got, "communicating") {
		t.Fatalf("dependency rsc.io/quote not wired correctly: got %q", got)
	}
	t.Logf("slogan from rsc.io/quote: %q", got)
}
