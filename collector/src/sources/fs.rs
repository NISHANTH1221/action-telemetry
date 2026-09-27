use std::path::Path;

/// Bytes available to unprivileged users on the filesystem holding `path`.
#[allow(clippy::unnecessary_cast)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_has_free_space_and_missing_path_is_none() {
        assert!(free_bytes(Path::new("/")).unwrap() > 0);
        assert!(free_bytes(Path::new("/definitely/not/here")).is_none());
    }
}
