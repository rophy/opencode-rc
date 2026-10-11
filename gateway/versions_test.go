package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVersion(t *testing.T) {
	if v, ok := ParseVersion("1.18.29"); !ok || v != (Version{1, 18, 29}) {
		t.Fatalf("ParseVersion(1.18.29) = %v, %v", v, ok)
	}
	for _, bad := range []string{"", "1.18", "v1.18.29", "1.18.29-beta", "1.18.x", " 1.2.3"} {
		if _, ok := ParseVersion(bad); ok {
			t.Errorf("ParseVersion(%q) accepted", bad)
		}
	}
}

func TestVersionPolicyCheck(t *testing.T) {
	none := VersionPolicy{}
	ranged := VersionPolicy{V2: &VersionRange{Min: Version{2, 0, 20}, Max: Version{2, 0, 27}}}
	cases := []struct {
		policy  VersionPolicy
		version string
		ok      bool
	}{
		{none, "", true},        // older CLIs send nothing: 1.x
		{none, "1.18.29", true}, // any 1.x
		{none, "1.0.0", true},
		{none, "2.0.26", false},  // no 2.x range
		{ranged, "2.0.20", true}, // min inclusive
		{ranged, "2.0.26", true},
		{ranged, "2.0.27", false}, // max exclusive
		{ranged, "2.0.19", false},
		{ranged, "2.1.0", false},
		{ranged, "3.0.0", false}, // unknown major
		{ranged, "0.9.0", false},
		{ranged, "garbage", false},
	}
	for _, c := range cases {
		err := c.policy.Check(c.version)
		if (err == nil) != c.ok {
			t.Errorf("policy %+v Check(%q) = %v, want ok=%v", c.policy.V2, c.version, err, c.ok)
		}
	}
}

func TestLoadVersionPolicy(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	p, err := LoadVersionPolicy(write("none.json", `{ "v2": null }`))
	if err != nil || p.V2 != nil {
		t.Fatalf("null v2: %+v, %v", p, err)
	}
	p, err = LoadVersionPolicy(write("ranged.json", `{ "v2": { "min": "2.0.26", "max": "2.0.27" } }`))
	if err != nil || p.V2 == nil || p.V2.Min != (Version{2, 0, 26}) || p.V2.Max != (Version{2, 0, 27}) {
		t.Fatalf("ranged: %+v, %v", p, err)
	}
	for name, content := range map[string]string{
		"badjson.json": `{`,
		"badver.json":  `{ "v2": { "min": "2.0", "max": "2.0.27" } }`,
		"empty.json":   `{ "v2": { "min": "2.0.27", "max": "2.0.27" } }`,
		"unknown.json": `{ "v3": null }`,
	} {
		if _, err := LoadVersionPolicy(write(name, content)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := LoadVersionPolicy(filepath.Join(dir, "missing.json")); err == nil || !strings.Contains(err.Error(), "missing.json") {
		t.Errorf("missing file: %v", err)
	}
}

func TestLoadVersionPolicyForMissingFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.json")
	p, err := loadVersionPolicyFor(&Config{OpencodeVersionsFile: missing})
	if err != nil || p.V2 != nil {
		t.Errorf("default file missing: %+v, %v", p, err)
	}
	if _, err := loadVersionPolicyFor(&Config{OpencodeVersionsFile: missing, OpencodeVersionsExplicit: true}); err == nil {
		t.Error("explicit missing file must be an error")
	}
}

func TestRepoVersionsFileLoads(t *testing.T) {
	if _, err := LoadVersionPolicy("../config/opencode-versions.json"); err != nil {
		t.Fatalf("config/opencode-versions.json: %v", err)
	}
}

func v2Range(min, max string) *VersionRange {
	a, _ := ParseVersion(min)
	b, _ := ParseVersion(max)
	return &VersionRange{Min: a, Max: b}
}

func writeDeployConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNarrowVersionPolicy(t *testing.T) {
	def := VersionPolicy{V2: v2Range("2.0.26", "2.0.30")}
	tests := []struct {
		name    string
		def     VersionPolicy
		config  string
		want    *VersionRange
		wantErr bool
	}{
		{"narrows both ends", def, `{"opencodeV2":{"versions":{"min":"2.0.27","max":"2.0.29"}}}`, v2Range("2.0.27", "2.0.29"), false},
		{"same range", def, `{"opencodeV2":{"versions":{"min":"2.0.26","max":"2.0.30"}}}`, v2Range("2.0.26", "2.0.30"), false},
		{"clamps a wider range", def, `{"opencodeV2":{"versions":{"min":"2.0.1","max":"2.1.0"}}}`, v2Range("2.0.26", "2.0.30"), false},
		{"clamps one end", def, `{"opencodeV2":{"versions":{"min":"2.0.28","max":"2.1.0"}}}`, v2Range("2.0.28", "2.0.30"), false},
		{"empty overlap above", def, `{"opencodeV2":{"versions":{"min":"2.0.30","max":"2.0.31"}}}`, nil, false},
		{"empty overlap below", def, `{"opencodeV2":{"versions":{"min":"2.0.1","max":"2.0.26"}}}`, nil, false},
		{"nil default stays nil", VersionPolicy{}, `{"opencodeV2":{"versions":{"min":"2.0.26","max":"2.0.27"}}}`, nil, false},
		{"absent versions keeps default", def, `{"opencodeV2":{"features":{"shell":{"enabled":false}}},"features":{}}`, v2Range("2.0.26", "2.0.30"), false},
		{"absent opencodeV2 keeps default", def, `{"serverUrl":"https://x.example.com"}`, v2Range("2.0.26", "2.0.30"), false},
		{"invalid JSON", def, `{`, nil, true},
		{"invalid version", def, `{"opencodeV2":{"versions":{"min":"x","max":"2.0.29"}}}`, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NarrowVersionPolicy(tt.def, writeDeployConfig(t, tt.config))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if (got.V2 == nil) != (tt.want == nil) || (tt.want != nil && *got.V2 != *tt.want) {
				t.Errorf("got %+v, want %+v", got.V2, tt.want)
			}
		})
	}
	if _, err := NarrowVersionPolicy(def, filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Error("unreadable file must be an error")
	}
}

func TestLoadVersionPolicyForNarrows(t *testing.T) {
	defaults := filepath.Join(t.TempDir(), "v.json")
	os.WriteFile(defaults, []byte(`{"v2":{"min":"2.0.26","max":"2.0.30"}}`), 0o600)
	cfgPath := writeDeployConfig(t, `{"opencodeV2":{"versions":{"min":"2.0.26","max":"2.0.27"}}}`)
	p, err := loadVersionPolicyFor(&Config{OpencodeVersionsFile: defaults, OpencodeVersionsExplicit: true, DeploymentConfigFile: cfgPath})
	if err != nil || p.V2 == nil || p.V2.Max.String() != "2.0.27" {
		t.Errorf("got %+v, %v", p, err)
	}
	if _, err := loadVersionPolicyFor(&Config{OpencodeVersionsFile: defaults, OpencodeVersionsExplicit: true, DeploymentConfigFile: filepath.Join(t.TempDir(), "absent.json")}); err == nil {
		t.Error("set but unreadable deployment config must be an error")
	}
}
