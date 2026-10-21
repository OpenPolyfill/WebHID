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
        assert_eq!(base_a, base_b);
        assert_eq!(base_a, "/sys/devices/virtual/misc/uhid/0005:1D50:615E");

        let desc_a = [0x05, 0x01, 0x09, 0x04, 0xA1, 0x01, 0xC0];
        let desc_b = [0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01, 0xC0];

        let id_a = hash_device_id(&identity_string(&base_a, &desc_a));
        let id_b = hash_device_id(&identity_string(&base_b, &desc_b));
        assert_ne!(id_a, id_b, "distinct descriptors must not share an id");

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
fn numbered_report_detection_handles_descriptor_boundaries() {
    let no_report_id = [
        0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03, 0x81, 0x02, 0xC0,
    ];
    let report_id = [
        0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03, 0x81,
        0x02, 0xC0,
    ];
    let long_item_without_report_id = [
        0xFE, 0x02, 0x00, 0x00, 0x00, 0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x75, 0x08, 0x95, 0x01,
        0x81, 0x02, 0xC0,
    ];
    let report_id_after_long_item = [
        0xFE, 0x00, 0x00, 0x85, 0x02, 0x75, 0x08, 0x95, 0x01, 0x81, 0x02,
    ];
    let report_id_at_end = [0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01];
    let non_report_id_globals = [
        0x05, 0x01, 0x15, 0x00, 0x25, 0x01, 0x75, 0x08, 0x95, 0x01, 0x35, 0x00, 0x45, 0x00, 0x65,
        0x00, 0x55, 0x00,
    ];
    let cases: &[(&str, &[u8], bool)] = &[
        ("empty", &[], false),
        ("no report ID", &no_report_id, false),
        ("report ID", &report_id, true),
        ("long item skipped", &long_item_without_report_id, false),
        (
            "report ID after long item",
            &report_id_after_long_item,
            true,
        ),
        ("truncated long item", &[0xFE], false),
        ("long item without tag", &[0xFE, 0x00], false),
        ("report ID at end", &report_id_at_end, true),
        ("other global items", &non_report_id_globals, false),
    ];

    for (name, descriptor, expected) in cases {
        assert_eq!(
            uses_numbered_reports(descriptor),
            *expected,
            "descriptor case: {name}"
        );
    }
}

#[cfg(target_os = "linux")]
mod indexed_string {
    use super::super::decode_usb_string_descriptor;

    #[test]
    fn decodes_usb_string_descriptor_as_utf16le() {
        let descriptor = [8, 3, 0x48, 0, 0x49, 0, 0x44, 0];
        assert_eq!(
            decode_usb_string_descriptor(&descriptor),
            Some("HID".to_string())
        );
    }

    #[test]
    fn rejects_malformed_usb_string_descriptors() {
        assert_eq!(decode_usb_string_descriptor(&[4, 2, 0, 0]), None);
        assert_eq!(decode_usb_string_descriptor(&[5, 3, 0x41, 0, 0]), None);
    }
}
