use super::uses_numbered_reports;

#[cfg(target_os = "linux")]
mod identity {

    use super::super::{identity_string, sysfs_base_from_realpath};
    use webhid::hash_device_id;

    /// Regression: two UHID interfaces sharing one normalized base path
    /// (`/sys/devices/virtual/misc/uhid/0005:1D50:615E`) with different
    /// kernel instance suffixes and different report descriptors must get
    /// distinct device ids, and each id must be stable across repeated
    /// computation (re-enumeration, hot-plug, open).
    #[test]
    fn uhid_siblings_same_base_different_descriptors_get_distinct_ids() {
        let node_a = std::path::Path::new("/sys/devices/virtual/misc/uhid/0005:1D50:615E.004B");
        let node_b = std::path::Path::new("/sys/devices/virtual/misc/uhid/0005:1D50:615E.004C");

        let base_a = sysfs_base_from_realpath(node_a).expect("uhid base resolves");
        let base_b = sysfs_base_from_realpath(node_b).expect("uhid base resolves");
        // Both interfaces normalize to the same base: the descriptor must
        // be what separates their identities.
        assert_eq!(base_a, base_b);
        assert_eq!(base_a, "/sys/devices/virtual/misc/uhid/0005:1D50:615E");

        let desc_a = [0x05, 0x01, 0x09, 0x04, 0xA1, 0x01, 0xC0];
        let desc_b = [0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01, 0xC0];

        let id_a = hash_device_id(&identity_string(&base_a, &desc_a));
        let id_b = hash_device_id(&identity_string(&base_b, &desc_b));
        assert_ne!(id_a, id_b, "distinct descriptors must not share an id");

        // Stability: recomputing the id of the same interface yields the
        // same value (persistence and open lookups rely on this).
        assert_eq!(id_a, hash_device_id(&identity_string(&base_a, &desc_a)));
        assert_eq!(id_b, hash_device_id(&identity_string(&base_b, &desc_b)));
    }

    /// A recreated UHID device keeps its report descriptor, so it keeps
    /// its identity even though the kernel assigns a fresh instance
    /// suffix.
    #[test]
    fn uhid_recreation_keeps_identity() {
        let before = std::path::Path::new("/sys/devices/virtual/misc/uhid/0003:16C0:0001.004B");
        let after = std::path::Path::new("/sys/devices/virtual/misc/uhid/0003:16C0:0001.0100");
        let desc = [0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0xC0];

        let base_before = sysfs_base_from_realpath(before).unwrap();
        let base_after = sysfs_base_from_realpath(after).unwrap();
        assert_eq!(
            hash_device_id(&identity_string(&base_before, &desc)),
            hash_device_id(&identity_string(&base_after, &desc)),
            "instance suffix must not leak into the identity"
        );
    }

    /// Non-uhid sysfs paths keep their interface-specific base untouched
    /// and ignore the descriptor.
    #[test]
    fn non_uhid_base_ignores_descriptor() {
        let node = std::path::Path::new(
            "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-7/1-7:1.2/0003:046D:C52B.0009",
        );
        let base = sysfs_base_from_realpath(node).expect("usb base resolves");
        assert_eq!(
            base, "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-7/1-7:1.2",
            "usb interface path is used as-is"
        );
        assert_eq!(
            identity_string(&base, &[1, 2, 3]),
            base,
            "descriptor must not participate for non-uhid paths"
        );
    }

    /// An unreadable descriptor degrades the uhid identity to the base
    /// path instead of failing.
    #[test]
    fn uhid_empty_descriptor_falls_back_to_base() {
        let base = "/sys/devices/virtual/misc/uhid/0005:1D50:615E";
        assert_eq!(identity_string(base, &[]), base);
        assert_ne!(
            identity_string(base, &[0]),
            base,
            "a known descriptor must be mixed in"
        );
    }
}

#[cfg(target_os = "linux")]
#[path = "uhid_siblings.rs"]
mod uhid_siblings;

#[test]
fn test_uses_numbered_reports_empty() {
    assert!(!uses_numbered_reports(&[]));
}

#[test]
fn test_uses_numbered_reports_no_report_id() {
    let desc = vec![
        0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03, 0x81, 0x02, 0xC0,
    ];
    assert!(!uses_numbered_reports(&desc));
}

#[test]
fn test_uses_numbered_reports_with_report_id() {
    let desc = vec![
        0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03, 0x81,
        0x02, 0xC0,
    ];
    assert!(uses_numbered_reports(&desc));
}

#[test]
fn test_uses_numbered_reports_long_item_skipped() {
    let desc = vec![
        0xFE, 0x02, 0x00, 0x00, 0x00, 0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x75, 0x08, 0x95, 0x01,
        0x81, 0x02, 0xC0,
    ];
    assert!(!uses_numbered_reports(&desc));
}

#[test]
fn test_uses_numbered_reports_report_id_after_long_item() {
    let desc = vec![
        0xFE, 0x00, 0x00, 0x85, 0x02, 0x75, 0x08, 0x95, 0x01, 0x81, 0x02,
    ];
    assert!(uses_numbered_reports(&desc));
}

#[test]
fn test_uses_numbered_reports_truncated_long_item() {
    assert!(!uses_numbered_reports(&[0xFE]));
}

#[test]
fn test_uses_numbered_reports_just_long_item_no_tag() {
    assert!(!uses_numbered_reports(&[0xFE, 0x00]));
}

#[test]
fn test_uses_numbered_reports_report_id_at_end() {
    let desc = vec![0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01];
    assert!(uses_numbered_reports(&desc));
}

#[test]
fn test_uses_numbered_reports_non_report_id_global_items() {
    let desc = vec![
        0x05, 0x01, 0x15, 0x00, 0x25, 0x01, 0x75, 0x08, 0x95, 0x01, 0x35, 0x00, 0x45, 0x00, 0x65,
        0x00, 0x55, 0x00,
    ];
    assert!(!uses_numbered_reports(&desc));
}
