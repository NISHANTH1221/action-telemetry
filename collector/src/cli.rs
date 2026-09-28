use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub out: PathBuf,
    pub interval: Duration,
    pub proc_interval: Option<Duration>,
    pub docker: bool,
    pub watch_pid: Option<i32>,
    pub max_bytes: u64,
    pub max_duration: Duration,
    pub workspace: Option<PathBuf>,
}

pub const DEFAULT_MAX_BYTES: u64 = 50 * 1024 * 1024;

pub fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut out = None;
    let mut interval = Duration::from_secs(1);
    let mut proc_interval = Some(Duration::from_secs(5));
    let mut docker = true;
    let mut watch_pid = None;
    let mut max_bytes = DEFAULT_MAX_BYTES;
    let mut max_duration = Duration::from_secs(72 * 3600);
    let mut workspace = None;

    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match flag.as_str() {
            "--out" => out = Some(PathBuf::from(value()?)),
            "--interval" => interval = parse_secs(&value()?, false)?,
            "--proc-interval" => {
                let d = parse_secs(&value()?, true)?;
                proc_interval = if d.is_zero() { None } else { Some(d) };
            }
            "--docker" => docker = parse_bool(&value()?)?,
            "--watch-pid" => {
                let v = value()?;
                let pid: i32 = v.parse().map_err(|_| format!("invalid pid: {v}"))?;
                watch_pid = if pid > 0 { Some(pid) } else { None };
            }
            "--max-bytes" => {
                let v = value()?;
                max_bytes = v.parse().map_err(|_| format!("invalid byte count: {v}"))?;
            }
            "--max-duration" => max_duration = parse_duration(&value()?)?,
            "--workspace" => workspace = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown flag: {other}")),
        }
    }

    Ok(Config {
        out: out.ok_or("--out is required")?,
        interval,
        proc_interval,
        docker,
        watch_pid,
        max_bytes,
        max_duration,
        workspace,
    })
}

fn parse_secs(v: &str, allow_zero: bool) -> Result<Duration, String> {
    let n: f64 = v.parse().map_err(|_| format!("invalid seconds: {v}"))?;
    if !n.is_finite() || n < 0.0 || (!allow_zero && n == 0.0) {
        return Err(format!("invalid seconds: {v}"));
    }
    Ok(Duration::from_secs_f64(n))
}

fn parse_bool(v: &str) -> Result<bool, String> {
    match v {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("invalid boolean: {v}")),
    }
}

fn parse_duration(v: &str) -> Result<Duration, String> {
    let (num, mult) = match v.chars().last() {
        Some('h') => (&v[..v.len() - 1], 3600.0),
        Some('m') => (&v[..v.len() - 1], 60.0),
        Some('s') => (&v[..v.len() - 1], 1.0),
        _ => (v, 1.0),
    };
    let n: f64 = num.parse().map_err(|_| format!("invalid duration: {v}"))?;
    if !n.is_finite() || n <= 0.0 {
        return Err(format!("invalid duration: {v}"));
    }
    Ok(Duration::from_secs_f64(n * mult))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn defaults_apply_when_only_out_given() {
        let c = parse_args(&args("--out /tmp/s.ndjson")).unwrap();
        assert_eq!(c.out, PathBuf::from("/tmp/s.ndjson"));
        assert_eq!(c.interval, Duration::from_secs(1));
        assert_eq!(c.proc_interval, Some(Duration::from_secs(5)));
        assert!(c.docker);
        assert_eq!(c.watch_pid, None);
        assert_eq!(c.max_bytes, 52_428_800);
        assert_eq!(c.max_duration, Duration::from_secs(72 * 3600));
        assert_eq!(c.workspace, None);
    }

    #[test]
    fn all_flags_parse() {
        let c = parse_args(&args(
            "--out o --interval 0.5 --proc-interval 10 --docker false --watch-pid 42 \
             --max-bytes 1000 --max-duration 30m --workspace /w",
        ))
        .unwrap();
        assert_eq!(c.interval, Duration::from_millis(500));
        assert_eq!(c.proc_interval, Some(Duration::from_secs(10)));
        assert!(!c.docker);
        assert_eq!(c.watch_pid, Some(42));
        assert_eq!(c.max_bytes, 1000);
        assert_eq!(c.max_duration, Duration::from_secs(1800));
        assert_eq!(c.workspace, Some(PathBuf::from("/w")));
    }

    #[test]
    fn zero_disables_proc_sampling_and_watchdog() {
        let c = parse_args(&args("--out o --proc-interval 0 --watch-pid 0")).unwrap();
        assert_eq!(c.proc_interval, None);
        assert_eq!(c.watch_pid, None);
    }

    #[test]
    fn out_is_required() {
        assert!(parse_args(&args("--interval 1"))
            .unwrap_err()
            .contains("--out"));
    }

    #[test]
    fn rejects_unknown_flags_and_bad_values() {
        for bad in [
            "--out o --bogus 1",
            "--out o --interval 0",
            "--out o --interval abc",
            "--out o --docker yes",
            "--out o --interval",
            "--out o --max-duration 5x",
            "--out o --watch-pid x",
        ] {
            assert!(parse_args(&args(bad)).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn max_duration_units() {
        let d = |v: &str| {
            parse_args(&args(&format!("--out o --max-duration {v}")))
                .unwrap()
                .max_duration
        };
        assert_eq!(d("2h"), Duration::from_secs(7200));
        assert_eq!(d("90s"), Duration::from_secs(90));
        assert_eq!(d("15"), Duration::from_secs(15));
    }
}
