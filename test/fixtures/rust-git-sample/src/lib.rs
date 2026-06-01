pub fn render(n: u64) -> String {
    let mut buf = itoa::Buffer::new();
    buf.format(n).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_number_with_git_dependency() {
        assert_eq!(render(42), "42");
    }
}
