## What does this PR do?

<!-- Briefly describe the change and why it's needed -->

## Related issue(s)

<!-- Closes #123, if applicable -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Performance / Benchmark
- [ ] Packaging / CI
- [ ] Documentation
- [ ] Tests
- [ ] Other (please describe)

## Testing

<!-- How did you test this? Which platform(s)? Which HID device(s)? -->

### Rust (daemon, NM host, mock)

- [ ] `cargo build --release` passes, if the change touches Rust code
- [ ] `npm run lint:rs` (cargo clippy) passes with no new warnings
- [ ] `npm run test:rs` passes
- [ ] Tested against a real HID device if the change touches enumeration,
      report descriptor parsing, or the data plane

### Addon (JavaScript)

- [ ] `npm run lint:js` and `npm run lint` (web-ext) pass
- [ ] `npm run test:unit` passes
- [ ] `npm test` passes WebHID conformance, including mock-device E2E
- [ ] `npm run test:regression` passes when changing permissions, sessions, or transports
- [ ] `npm run test:regression:forwarder` passes when changing Native Messaging forwarding
- [ ] `npm run test:benchmark` if the change affects throughput or latency
- [ ] Manually tested the changed area in the browser

Linux E2E needs debug binaries, `/dev/uhid`, and the one-time
`sudo make install-e2e-udev-rule` setup. See
[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#testing). The forwarder profile
runs only selected runtime-port and revocation regressions.

## Checklist

- [ ] I've read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] My commit messages follow Conventional Commits style
- [ ] I've updated relevant docs (README, DEVELOPMENT.md, ARCHITECTURE.md,
      BENCHMARK.md) if needed
