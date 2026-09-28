use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cfg = match telemetry::cli::parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("collector: {e}");
            std::process::exit(2);
        }
    };
    lower_priority();
    let stop = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        let _ = signal_hook::flag::register(sig, Arc::clone(&stop));
    }
    if let Err(e) = telemetry::run::run(&cfg, &telemetry::sources::Roots::real(), &stop) {
        eprintln!("collector: {e}");
        std::process::exit(1);
    }
}

/// Lowest CPU priority, and first in line for the OOM killer so the user's build survives.
fn lower_priority() {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 19);
    }
    #[cfg(target_os = "linux")]
    let _ = std::fs::write("/proc/self/oom_score_adj", "1000");
}
