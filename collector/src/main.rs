fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = telemetry::cli::parse_args(&args) {
        eprintln!("collector: {e}");
        std::process::exit(2);
    }
}
