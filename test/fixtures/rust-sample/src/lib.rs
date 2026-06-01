pub fn answer() -> u32 {
    42
}

#[cfg(test)]
mod tests {
    use super::answer;

    #[test]
    fn answers() {
        assert_eq!(answer(), 42);
    }
}
