//! Thin entrypoint: all logic lives in the library. This is the only place errors are
//! caught — one `mdview: <message>` line on stderr, exit 1.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match mdview::run(&args) {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("mdview: {message}");
            std::process::exit(1);
        }
    }
}
