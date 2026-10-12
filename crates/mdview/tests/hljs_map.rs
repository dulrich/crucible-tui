//! The generated highlight.js-name table, through the one lookup both consumers share.
use mdview::highlight::supports_language;

#[test]
fn hljs_names_resolve_through_the_table() {
    for name in [
        "csharp",
        "golang",
        "jsx",
        "objectivec",
        "docker",
        "fsharp",
        "CSharp",
    ] {
        assert!(supports_language(name), "{name}");
    }
}

#[test]
fn rust_extras_are_kept_and_unknowns_stay_unsupported() {
    for name in [
        "graphql",
        "hcl",
        "vue",
        "zig",
        "go",
        "rust",
        "powershell",
        "ps",
        "ps1",
    ] {
        assert!(supports_language(name), "{name}");
    }
    assert!(!supports_language("vbnet"));
    assert!(!supports_language("no-such-language"));
}
