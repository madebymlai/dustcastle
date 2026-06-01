pub fn render(n: u64) -> String {
    let mut buf = itoa::Buffer::new();
    buf.format(n).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_number_with_crates_io_dependency() {
        // Compiling+running offline proves the crates.io crate vendored and resolved.
        assert_eq!(render(42), "42");
    }
}
