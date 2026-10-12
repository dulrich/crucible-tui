//! Builds the syntax set the highlighter loads: two-face's extended set (newline variant) plus
//! every vendored `.sublime-syntax` under `syntaxes/`, dumped to `$OUT_DIR/syntaxes.bin`.
//! Reads only `syntaxes/`, writes only `OUT_DIR`, never touches the network.

use std::path::{Path, PathBuf};

use syntect::parsing::SyntaxDefinition;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("syntaxes");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut grammars: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("read syntaxes/")
        .map(|e| e.expect("read syntaxes/ entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "sublime-syntax"))
        .collect();
    grammars.sort();

    let mut builder = two_face::syntax::extra_newlines().into_builder();
    for path in &grammars {
        println!("cargo:rerun-if-changed={}", path.display());
        let src = std::fs::read_to_string(path).expect("read grammar");
        let name = path.file_stem().and_then(|s| s.to_str());
        let def = SyntaxDefinition::load_from_str(&src, true, name)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        builder.add(def);
    }
    let set = builder.build();

    // Uncompressed, as two-face ships its own set: each syntax's lazy contexts are already
    // compressed inside the dump, and an outer zlib pass cost ~13 ms per colour-on fenced render.
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("syntaxes.bin");
    syntect::dumps::dump_to_uncompressed_file(&set, out).expect("write syntaxes.bin");
}
