//! Real-device regression tests for the UHID identity model.
//!
//! Each test creates actual virtual HID devices through `/dev/uhid` (via
//! the `webhid-mock` platform backend) so the full identity pipeline runs:
//! sysfs canonicalization, base normalization, descriptor mixing,
//! enumeration dedup, and `open_by_device_id` path resolution.
//!
//! The tests are serialized with a process-wide lock because they all
//! spawn devices with the same test VID/PID and `enumerate()` sees every
//! device in the process. Requires `/dev/uhid` write access (root or a
//! udev rule).

use std::os::unix::io::RawFd;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use webhid_mock::linux::{build_create_event, build_destroy_event, open_uhid, write_event};

/// Obscure test-only identity: two sibling virtual devices that share one
/// normalized sysfs base (`/sys/devices/virtual/misc/uhid/0003:F00D:BA5E`)
/// exactly like the reported hidraw7/hidraw8 collision.
const VID: u16 = 0xF00D;
const PID: u16 = 0xBA5E;

static UHID_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn uhid_lock() -> MutexGuard<'static, ()> {
    UHID_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `/dev/uhid` allows one virtual device per open fd, so each test device
/// is its own fd; dropping it destroys the device.
struct UhidDevice(RawFd);

impl Drop for UhidDevice {
    fn drop(&mut self) {
        let _ = write_event(self.0, &build_destroy_event());
        unsafe {
            libc::close(self.0);
        }
    }
}

fn create_uhid_device(name: &str, descriptor: &[u8]) -> UhidDevice {
    let fd = match open_uhid() {
        Ok(fd) => fd,
        Err(e) => {
            panic!("cannot open /dev/uhid (needs root or the 'webhid' udev group): {e}");
        }
    };
    let event = build_create_event(name, descriptor, VID, PID, 0, 0, 0x03)
        .expect("build UHID_CREATE2 event");
    write_event(fd, &event).expect("write UHID_CREATE2 event");
    UhidDevice(fd)
}

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/descriptors")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()))
}

/// Poll `enumerate()` until `expected` test-vid/pid devices are visible.
fn wait_for_enumeration(expected: usize) -> Vec<webhid::DeviceInfo> {
    let start = Instant::now();
    loop {
        if let Ok(devs) = crate::hid::enumerate() {
            let mine: Vec<webhid::DeviceInfo> = devs
                .into_iter()
                .filter(|d| d.vendor_id == VID && d.product_id == PID)
                .collect();
            if mine.len() >= expected {
                return mine;
            }
        }
        if start.elapsed() > Duration::from_secs(10) {
            panic!("uhid test devices did not enumerate within 10s (expected {expected})");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Regression: two UHID interfaces sharing one normalized base path but
/// with different instance suffixes and different report descriptors must
/// enumerate as distinct WebHID devices, and open(device_id) must resolve
/// each id to its own underlying hidapi interface, never to an arbitrary
/// sibling.
#[test]
fn uhid_sibling_interfaces_get_distinct_ids_and_open_their_own_interface() {
    let _guard = uhid_lock();
    let desc_a = fixture("vendor.bin");
    let desc_b = fixture("gamepad.bin");
    assert_ne!(desc_a, desc_b, "fixtures must differ for this test");

    let _dev_a = create_uhid_device("webhid-uhid-test A", &desc_a);
    let _dev_b = create_uhid_device("webhid-uhid-test B", &desc_b);

    let mine = wait_for_enumeration(2);
    assert_eq!(mine.len(), 2, "both sibling interfaces must enumerate");

    let id_a = mine
        .iter()
        .find(|d| d.raw_descriptor == desc_a)
        .expect("interface A enumerated")
        .device_id;
    let id_b = mine
        .iter()
        .find(|d| d.raw_descriptor == desc_b)
        .expect("interface B enumerated")
        .device_id;
    assert_ne!(id_a, id_b, "siblings must not share an open identity");

    let (info_a, _, _dev_a_open) =
        crate::hid::open_by_device_id(id_a).expect("open interface A by device_id");
    assert_eq!(
        info_a.raw_descriptor, desc_a,
        "open(interface A id) must select interface A"
    );
    let (info_b, _, _dev_b_open) =
        crate::hid::open_by_device_id(id_b).expect("open interface B by device_id");
    assert_eq!(
        info_b.raw_descriptor, desc_b,
        "open(interface B id) must select interface B"
    );
}

/// Genuine duplicates: two hidapi entries that share the normalized base
/// path, the descriptor, and every other observable attribute (the same
/// logical interface) still merge into one enumerated device identity, and
/// that identity opens successfully.
#[test]
fn uhid_genuine_duplicates_merge_into_one_identity() {
    let _guard = uhid_lock();
    let desc = fixture("vendor.bin");

    let _dev_1 = create_uhid_device("webhid-uhid-test twin", &desc);
    let _dev_2 = create_uhid_device("webhid-uhid-test twin", &desc);

    let mine = wait_for_enumeration(1);
    assert_eq!(
        mine.len(),
        1,
        "indistinguishable duplicate entries must merge into one identity"
    );
    let id = mine[0].device_id;
    let (info, _, _opened) =
        crate::hid::open_by_device_id(id).expect("open merged identity by device_id");
    assert_eq!(
        info.raw_descriptor, desc,
        "open(merged id) must select one of the identical interfaces"
    );
}
