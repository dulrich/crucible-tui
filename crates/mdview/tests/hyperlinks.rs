//! WP-6b: the wiki-link resolver wired from `RenderOptions.path` under hyperlinks, and the
//! parity request carrying it. Expected bytes are the TS renderer's own, captured by running
//! `renderDocument` with `createWikiLinkResolver(<vault>/doc.md)` over the same synthetic vault
//! (`.obsidian` marker, a `note` file under `sub`, `doc.md`), with the vault path substituted.

use mdview::render::{Policy, Sgr};
use mdview::{RenderOptions, render};
use std::path::PathBuf;

const ESC: &str = "\u{1b}";
const BEL: &str = "\u{7}";

fn vault(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mdview-wp6b-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub").join("note.md"), "x\n").unwrap();
    std::fs::write(dir.join("doc.md"), "x\n").unwrap();
    dir
}

fn opts(path: Option<String>, sgr: Sgr, hyperlinks: bool, tmux: bool) -> RenderOptions {
    RenderOptions {
        path,
        policy: Policy {
            sgr,
            hyperlinks,
            tmux,
        },
        ..RenderOptions::plain(80)
    }
}

fn run(source: &str, dir: &std::path::Path, sgr: Sgr, hyperlinks: bool, tmux: bool) -> String {
    let doc = dir.join("doc.md").to_string_lossy().into_owned();
    render(source, &opts(Some(doc), sgr, hyperlinks, tmux))
        .expect("renders")
        .text
}

#[test]
fn plain_hyperlinks_resolve_a_bare_slug_to_file_uri() {
    let dir = vault("bare");
    let uri = format!("file://{}/sub/note.md", dir.display());
    assert_eq!(
        run("See [[note]] now.", &dir, Sgr::None, true, false),
        format!("See {ESC}]8;;{uri}{BEL}note{ESC}]8;;{BEL} now.\n\n")
    );
}

#[test]
fn fragment_and_alias_resolve_and_a_missing_slug_stays_plain() {
    let dir = vault("frag");
    let uri = format!("file://{}/sub/note.md#Head", dir.display());
    assert_eq!(
        run(
            "See [[note#Head|Alias]] and [[missing]].",
            &dir,
            Sgr::None,
            true,
            false
        ),
        format!("See {ESC}]8;;{uri}{BEL}Alias{ESC}]8;;{BEL} and missing.\n\n")
    );
}

#[test]
fn tmux_wraps_the_resolved_link_in_dcs() {
    let dir = vault("tmux");
    let uri = format!("file://{}/sub/note.md", dir.display());
    assert_eq!(
        run("See [[sub/note]].", &dir, Sgr::None, true, true),
        format!(
            "See {ESC}Ptmux;{ESC}{ESC}]8;;{uri}{BEL}{ESC}\\sub/note{ESC}Ptmux;{ESC}{ESC}]8;;{BEL}{ESC}\\.\n\n"
        )
    );
}

#[test]
fn colour_on_styles_inside_the_link() {
    let dir = vault("colour");
    let uri = format!("file://{}/sub/note.md", dir.display());
    assert_eq!(
        run("See [[note]] now.", &dir, Sgr::Full, true, false),
        format!(
            "{ESC}[0mSee {ESC}]8;;{uri}{BEL}{ESC}[36m{ESC}[4mnote{ESC}[24m{ESC}[39m{ESC}]8;;{BEL} now.{ESC}[0m\n\n"
        )
    );
}

#[test]
fn hyperlinks_off_never_resolves() {
    let dir = vault("off");
    assert_eq!(
        run("See [[note]] now.", &dir, Sgr::None, false, false),
        "See note now.\n\n"
    );
}

#[test]
fn no_path_means_no_resolver() {
    let out = render("See [[note]] now.", &opts(None, Sgr::None, true, false)).expect("renders");
    assert_eq!(out.text, "See note now.\n\n");
}

#[test]
fn parity_request_path_reaches_the_resolver() {
    let dir = vault("parity");
    let doc = dir.join("doc.md").to_string_lossy().into_owned();
    let request = serde_json::json!({
        "source": "See [[note]] now.",
        "width": 80,
        "tier": "unicode",
        "ambiguous": "narrow",
        "policy": { "sgr": "none", "hyperlinks": true, "tmux": false },
        "path": doc,
    });
    let response: serde_json::Value =
        serde_json::from_str(&mdview::parity::handle_render(&request.to_string())).unwrap();
    let uri = format!("file://{}/sub/note.md", dir.display());
    assert_eq!(
        response["text"],
        format!("See {ESC}]8;;{uri}{BEL}note{ESC}]8;;{BEL} now.\n\n")
    );
}
