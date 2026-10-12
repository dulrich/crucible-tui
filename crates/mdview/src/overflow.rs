//! The width gate and the code-range exemption predicate, ported from `src/overflow.ts`.
//!
//! Code ranges are 1-based inclusive *line* numbers, as `render` returns them.

use crate::width::Measure;

/// 1-based inclusive line ranges.
pub type CodeRanges = [(usize, usize)];

/// The first line over budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverflowHit {
    pub line: usize,
    pub width: usize,
}

/// `isLineExempt`.
pub fn is_line_exempt(line_number: usize, code_ranges: &CodeRanges) -> bool {
    code_ranges
        .iter()
        .any(|&(start, end)| line_number >= start && line_number <= end)
}

/// `findFirstOverflow`: the first non-exempt line (split on `\n`) wider than `target_width`.
pub fn find_first_overflow(
    output: &str,
    target_width: usize,
    code_ranges: &CodeRanges,
    measure: Measure,
) -> Option<OverflowHit> {
    for (index, line) in output.split('\n').enumerate() {
        let line_number = index + 1;
        if is_line_exempt(line_number, code_ranges) {
            continue;
        }
        let width = measure.width(line);
        if width > target_width {
            return Some(OverflowHit {
                line: line_number,
                width,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::{NARROW_MEASURE, WIDE_MEASURE};

    #[test]
    fn exemption_is_inclusive() {
        let r = [(2, 3)];
        assert!(!is_line_exempt(1, &r));
        assert!(is_line_exempt(2, &r));
        assert!(is_line_exempt(3, &r));
        assert!(!is_line_exempt(4, &r));
        assert!(!is_line_exempt(1, &[]));
    }

    #[test]
    fn first_overflow_skips_code_ranges() {
        let out = "ok\nxxxxxxxxxx\nyyyyyyyyyyyy\nfine";
        assert_eq!(
            find_first_overflow(out, 5, &[], NARROW_MEASURE),
            Some(OverflowHit { line: 2, width: 10 })
        );
        assert_eq!(
            find_first_overflow(out, 5, &[(2, 2)], NARROW_MEASURE),
            Some(OverflowHit { line: 3, width: 12 })
        );
        assert_eq!(find_first_overflow(out, 5, &[(2, 3)], NARROW_MEASURE), None);
    }

    #[test]
    fn measures_display_width_not_bytes() {
        assert_eq!(
            find_first_overflow("\u{1b}[1mabc\u{1b}[22m", 3, &[], NARROW_MEASURE),
            None
        );
        assert_eq!(find_first_overflow("———", 3, &[], NARROW_MEASURE), None);
        assert_eq!(
            find_first_overflow("———", 3, &[], WIDE_MEASURE),
            Some(OverflowHit { line: 1, width: 6 })
        );
        assert_eq!(find_first_overflow("", 0, &[], NARROW_MEASURE), None);
    }
}
