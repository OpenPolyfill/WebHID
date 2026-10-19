use super::*;

#[test]
fn nm_response_serializes_optional_hid_permission() {
    let with_permission = NmResponse {
        status: Some(200),
        ws_port: Some(31337),
        ws_nonce: Some("nonce".into()),
        wt_port: Some(4433),
        wt_cert_hash: Some("abc".into()),
        hid_permission: Some(1),
        ..Default::default()
    };

    for (response, expected_permission, expected_ws_port) in [
        (with_permission, Some(1), Some(31337)),
        (NmResponse::ok(), None, None),
    ] {
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&response).unwrap()).unwrap();
        assert_eq!(
            value.get("P").cloned(),
            expected_permission.map(serde_json::Value::from)
        );
        assert_eq!(
            value.get("w").cloned(),
            expected_ws_port.map(serde_json::Value::from)
        );
    }
}
