//! Thin entrypoint: all logic lives in the library. This is the only place errors are
//! caught — one `mdview: <message>` line on stderr, exit 1.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Fleet `--build` / `--version` contract: `--help` wins and is answered by `run`.
    let help = args.iter().any(|a| a == "--help" || a == "-h");
    let flagged = |a: &String| a == "--build" || a == "--version";
    if !help && args.iter().any(flagged) {
        println!("{}", env!("FLEET_BUILD_ID"));
        return;
    }
    // With `--help` present, drop the build flags so help is what `run` answers.
    let args: Vec<String> = if help {
        args.into_iter().filter(|a| !flagged(a)).collect()
    } else {
        args
    };
    match mdview::run(&args) {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("mdview: {message}");
            std::process::exit(1);
        }
    }
}
