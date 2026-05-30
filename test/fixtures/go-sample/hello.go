// Package sample is a trivial program with one real external dependency
// (rsc.io/quote) so the spike exercises a genuine go.sum lockfile + module graph.
package sample

import "rsc.io/quote"

// Slogan returns a fixed quote from the external dependency.
func Slogan() string { return quote.Go() }
