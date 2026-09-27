use super::Roots;
use std::path::Path;

const SECTOR: u64 = 512;

/// Cumulative (read bytes, written bytes) across devices accepted by `is_whole_disk`.
pub fn parse_diskstats(s: &str, is_whole_disk: impl Fn(&str) -> bool) -> (u64, u64) {
    let (mut rd, mut wr) = (0, 0);
    for line in s.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 || !is_whole_disk(f[2]) {
            continue;
        }
        rd += f[5].parse::<u64>().unwrap_or(0) * SECTOR;
        wr += f[9].parse::<u64>().unwrap_or(0) * SECTOR;
    }
    (rd, wr)
}

/// Whole disks appear in /sys/block; partitions don't. Virtual/stacked devices are skipped
/// so LVM, RAID and loop traffic isn't double counted.
pub fn is_whole_disk(sys_root: &Path, name: &str) -> bool {
    const SKIP: [&str; 6] = ["loop", "ram", "zram", "dm-", "md", "sr"];
    !SKIP.iter().any(|p| name.starts_with(p)) && sys_root.join("block").join(name).exists()
}

pub fn read(roots: &Roots) -> Option<(u64, u64)> {
    let s = super::read(&roots.proc, "diskstats")?;
    Some(parse_diskstats(&s, |n| is_whole_disk(&roots.sys, n)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::fixture_roots;

    #[test]
    fn sums_whole_disks_only() {
        let roots = fixture_roots();
        let (rd, wr) = read(&roots).unwrap();
        assert_eq!(rd, (4046582 + 8000) * 512);
        assert_eq!(wr, (9834124 + 16000) * 512);
    }

    #[test]
    fn skips_virtual_devices_even_if_in_sys_block() {
        let roots = fixture_roots();
        assert!(!is_whole_disk(&roots.sys, "loop0"));
        assert!(is_whole_disk(&roots.sys, "sda"));
        assert!(!is_whole_disk(&roots.sys, "sda1"));
    }

    #[test]
    fn ignores_short_lines() {
        assert_eq!(parse_diskstats("8 0 sda 1 2\n", |_| true), (0, 0));
    }
}
