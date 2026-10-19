use super::*;

#[test]
fn device_id_hash_is_stable_and_distinguishes_paths() {
    assert_eq!(hash_device_id(""), 0x811c9dc5);
    assert_ne!(
        hash_device_id("/dev/hidraw0"),
        hash_device_id("/dev/hidraw1")
    );
}
