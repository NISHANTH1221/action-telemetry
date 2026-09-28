/// Cumulative (rx bytes, tx bytes) across physical-ish interfaces. Bridge/veth interfaces are
/// excluded because container traffic also crosses the host NIC.
pub fn parse_net_dev(s: &str) -> (u64, u64) {
    let (mut rx, mut tx) = (0, 0);
    for line in s.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if is_virtual(name.trim()) {
            continue;
        }
        let f: Vec<u64> = rest
            .split_whitespace()
            .map(|x| x.parse().unwrap_or(0))
            .collect();
        if f.len() < 9 {
            continue;
        }
        rx += f[0];
        tx += f[8];
    }
    (rx, tx)
}

fn is_virtual(name: &str) -> bool {
    name == "lo"
        || ["docker", "veth", "br-", "cni", "flannel", "virbr"]
            .iter()
            .any(|p| name.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    const DEV: &str = include_str!("../../tests/fixtures/linux/proc/net/dev");

    #[test]
    fn sums_non_virtual_interfaces_including_glued_format() {
        // eth0 + eth1 (glued "eth1:123"); lo, docker0, veth* excluded
        assert_eq!(parse_net_dev(DEV), (5_000_123, 300_456));
    }
}
