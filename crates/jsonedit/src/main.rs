//! Thin entrypoint: all logic lives in the library so tests call `run` directly.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(jsonedit::run(&args));
}
