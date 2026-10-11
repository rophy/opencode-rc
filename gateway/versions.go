package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strconv"
)

// Version is an opencode release version, MAJOR.MINOR.PATCH.
type Version struct{ Major, Minor, Patch int }

var versionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

// ParseVersion accepts only the normalized form the CLI sends (e.g. "1.18.29").
func ParseVersion(s string) (Version, bool) {
	m := versionPattern.FindStringSubmatch(s)
	if m == nil {
		return Version{}, false
	}
	n := func(i int) int { v, _ := strconv.Atoi(m[i]); return v }
	return Version{n(1), n(2), n(3)}, true
}

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch) }

func (v Version) Less(o Version) bool {
	if v.Major != o.Major {
		return v.Major < o.Major
	}
	if v.Minor != o.Minor {
		return v.Minor < o.Minor
	}
	return v.Patch < o.Patch
}

// VersionRange holds the versions with Min <= v < Max.
type VersionRange struct{ Min, Max Version }

func (r VersionRange) Contains(v Version) bool { return !v.Less(r.Min) && v.Less(r.Max) }

// VersionPolicy says which opencode versions may register a session. Every 1.x is accepted
// (the 1.x UI build follows the pinned 1.x line); 2.x only inside V2, and nil V2 means no 2.x.
type VersionPolicy struct{ V2 *VersionRange }

// Check returns nil when a CLI reporting version may register. An empty version comes from
// CLIs that predate version reporting, which only ran opencode 1.x.
func (p VersionPolicy) Check(version string) error {
	if version == "" {
		return nil
	}
	v, ok := ParseVersion(version)
	if !ok {
		return fmt.Errorf("opencode version %q is not a MAJOR.MINOR.PATCH version", version)
	}
	switch v.Major {
	case 1:
		return nil
	case 2:
		if p.V2 == nil {
			return fmt.Errorf("opencode %s is not supported by this server: it supports opencode 1.x only", v)
		}
		if !p.V2.Contains(v) {
			return fmt.Errorf("opencode %s is not supported by this server: it supports opencode 1.x and %s up to (not including) %s", v, p.V2.Min, p.V2.Max)
		}
		return nil
	default:
		return fmt.Errorf("opencode %s is not supported by this server", v)
	}
}

// LoadVersionPolicy reads config/opencode-versions.json: {"v2": null} or
// {"v2": {"min": "2.0.26", "max": "2.0.27"}}. Unknown keys are errors.
func LoadVersionPolicy(path string) (VersionPolicy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return VersionPolicy{}, fmt.Errorf("opencode versions file: %w", err)
	}
	var raw struct {
		V2 *struct {
			Min string `json:"min"`
			Max string `json:"max"`
		} `json:"v2"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		return VersionPolicy{}, fmt.Errorf("%s: %w", path, err)
	}
	if raw.V2 == nil {
		return VersionPolicy{}, nil
	}
	min, okMin := ParseVersion(raw.V2.Min)
	max, okMax := ParseVersion(raw.V2.Max)
	if !okMin || !okMax {
		return VersionPolicy{}, fmt.Errorf("%s: v2.min and v2.max must be MAJOR.MINOR.PATCH versions", path)
	}
	if !min.Less(max) {
		return VersionPolicy{}, fmt.Errorf("%s: v2.min must be lower than v2.max", path)
	}
	return VersionPolicy{V2: &VersionRange{Min: min, Max: max}}, nil
}

// NarrowVersionPolicy intersects the default 2.x range with opencodeV2.versions from the
// deployment config.json. A deployment can only narrow the defaults: a range reaching outside
// them is clamped, and an empty overlap (or no default range) leaves no 2.x support. Other keys
// are ignored here; the API validates the whole file.
func NarrowVersionPolicy(p VersionPolicy, deploymentConfigPath string) (VersionPolicy, error) {
	data, err := os.ReadFile(deploymentConfigPath)
	if err != nil {
		return VersionPolicy{}, fmt.Errorf("deployment config: %w", err)
	}
	var raw struct {
		OpencodeV2 *struct {
			Versions *struct {
				Min string `json:"min"`
				Max string `json:"max"`
			} `json:"versions"`
		} `json:"opencodeV2"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return VersionPolicy{}, fmt.Errorf("%s: %w", deploymentConfigPath, err)
	}
	if raw.OpencodeV2 == nil || raw.OpencodeV2.Versions == nil {
		return p, nil
	}
	min, okMin := ParseVersion(raw.OpencodeV2.Versions.Min)
	max, okMax := ParseVersion(raw.OpencodeV2.Versions.Max)
	if !okMin || !okMax {
		return VersionPolicy{}, fmt.Errorf("%s: opencodeV2.versions.min and max must be MAJOR.MINOR.PATCH versions", deploymentConfigPath)
	}
	if !min.Less(max) {
		return VersionPolicy{}, fmt.Errorf("%s: opencodeV2.versions.min must be lower than max", deploymentConfigPath)
	}
	if p.V2 == nil {
		slog.Warn("deployment sets opencodeV2.versions but this server supports no opencode 2.x", "deployment", fmt.Sprintf(">=%s <%s", min, max))
		return VersionPolicy{}, nil
	}
	def := *p.V2
	out := def
	if def.Min.Less(min) {
		out.Min = min
	}
	if max.Less(def.Max) {
		out.Max = max
	}
	if min.Less(def.Min) || def.Max.Less(max) {
		slog.Warn("deployment opencodeV2.versions reaches outside the supported range, clamping",
			"deployment", fmt.Sprintf(">=%s <%s", min, max), "supported", fmt.Sprintf(">=%s <%s", def.Min, def.Max))
	}
	if !out.Min.Less(out.Max) {
		slog.Warn("deployment opencodeV2.versions does not overlap the supported range, opencode 2.x disabled",
			"deployment", fmt.Sprintf(">=%s <%s", min, max), "supported", fmt.Sprintf(">=%s <%s", def.Min, def.Max))
		return VersionPolicy{}, nil
	}
	return VersionPolicy{V2: &out}, nil
}
