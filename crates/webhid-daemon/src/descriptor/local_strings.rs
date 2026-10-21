use hidreport::ParserError;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum ReportKind {
    Input,
    Output,
    Feature,
}

#[derive(Debug)]
pub(super) struct MainItemStrings {
    pub(super) report_kind: ReportKind,
    pub(super) report_id: Option<u8>,
    pub(super) field_count: usize,
    pub(super) string_indices: Vec<u32>,
    pub(super) strings: Vec<String>,
}

#[derive(Clone, Copy, Default)]
struct Globals {
    report_size: u32,
    report_count: u32,
    report_id: Option<u8>,
}

#[derive(Default)]
struct LocalStrings {
    indices: Vec<u32>,
    minimum: Option<u32>,
    maximum: Option<u32>,
}

pub(super) fn scan(bytes: &[u8]) -> Result<Vec<MainItemStrings>, ParserError> {
    let mut globals = vec![Globals::default()];
    let mut locals = LocalStrings::default();
    let mut result = Vec::new();
    let mut position = 0;

    while position < bytes.len() {
        let item_offset = position;
        let header = bytes[position];
        position += 1;
        if header == 0xfe {
            let Some(&length) = bytes.get(position) else {
                break;
            };
            position = position.saturating_add(2 + usize::from(length));
            continue;
        }

        let size_code = header & 0x03;
        let size = if size_code == 3 {
            4
        } else {
            usize::from(size_code)
        };
        let Some(data) = bytes.get(position..position.saturating_add(size)) else {
            break;
        };
        position += size;
        let mut value = 0u32;
        for (index, byte) in data.iter().enumerate() {
            value |= u32::from(*byte) << (index * 8);
        }

        let item_type = (header >> 2) & 0x03;
        let item_tag = header >> 4;
        match item_type {
            0 => {
                let report_kind = match item_tag {
                    8 => Some(ReportKind::Input),
                    9 => Some(ReportKind::Output),
                    11 => Some(ReportKind::Feature),
                    _ => None,
                };
                if let Some(report_kind) = report_kind {
                    let current = *globals.last().unwrap();
                    let size = usize::try_from(current.report_size).ok();
                    let count = usize::try_from(current.report_count).ok();
                    let bit_length =
                        size.and_then(|size| count.and_then(|count| size.checked_mul(count)));
                    let Some(bit_length) = bit_length else {
                        return Err(ParserError::InvalidData {
                            offset: item_offset,
                            message: "report field size overflows".into(),
                        });
                    };
                    if bit_length > 0 {
                        let field_count = if value & 1 != 0 || value & 2 == 0 {
                            1
                        } else {
                            count.unwrap()
                        };
                        let mut string_indices = std::mem::take(&mut locals.indices);
                        if let (Some(minimum), Some(maximum)) = (locals.minimum, locals.maximum)
                            && maximum >= minimum
                        {
                            let range_count = u64::from(maximum) - u64::from(minimum) + 1;
                            if range_count > u64::from(u8::MAX) + 1 {
                                return Err(ParserError::InvalidData {
                                    offset: item_offset,
                                    message: "string index range exceeds USB limits".into(),
                                });
                            }
                            let range_count = usize::try_from(range_count).unwrap();
                            string_indices.try_reserve(range_count).map_err(|error| {
                                ParserError::InvalidData {
                                    offset: item_offset,
                                    message: format!("unable to reserve string indices: {error}"),
                                }
                            })?;
                            string_indices.extend(minimum..=maximum);
                        }
                        result.push(MainItemStrings {
                            report_kind,
                            report_id: current.report_id,
                            field_count,
                            string_indices,
                            strings: Vec::new(),
                        });
                    }
                }
                locals = LocalStrings::default();
            }
            1 => match item_tag {
                7 => globals.last_mut().unwrap().report_size = value,
                8 => globals.last_mut().unwrap().report_id = Some(value as u8),
                9 => globals.last_mut().unwrap().report_count = value,
                10 => globals.push(*globals.last().unwrap()),
                11 => {
                    if globals.len() > 1 {
                        globals.pop();
                    }
                }
                _ => {}
            },
            2 => match item_tag {
                7 => locals.indices.push(value),
                8 => locals.minimum = Some(value),
                9 => locals.maximum = Some(value),
                _ => {}
            },
            _ => {}
        }
    }

    Ok(result)
}
