# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version stays below 1.0.0, a minor bump may carry breaking changes:
the protocol work is still uncovering firmware behaviour that changes how
things have to be done.

## [Unreleased]

## [0.2.0] — 2026-08-06

### Added

- Advanced settings per server: the timeouts, ports, KVM bandwidth and input
  timings that used to be constants, folded into the server form with a reset
  to defaults. A profile stores only what differs from the defaults.
- Network discovery on the start screen: an address range is swept over
  UDP 623, and whatever answers can be added to the server list. The range is
  prefilled from this machine's own interface.

### Changed

- A missing video signal is shown as a monitor indicator in the toolbar —
  green with video, red and struck through without — instead of a notice that
  fades away. While the screen is blank a full frame is requested once a
  second, so the picture returns on its own.

## [0.1.0] — 2026-08-05

First public release.

### Added

- KVM console: video, keyboard and mouse over IVTP (TCP 7578), with a
  from-scratch decoder for the AVICA2A video codec running in a Web Worker.
- On-screen keyboard: a full ANSI layout with navigation and numeric blocks,
  latching modifiers, auto-repeat on hold, and Num/Caps/Scroll indicators
  driven by the BMC.
- Power control: power on, graceful shutdown, immediate power off, power cycle
  and hard reset, with confirmation on the destructive ones.
- IPMI over LAN (UDP 623) with RMCP+, RAKP-HMAC-SHA1 and AES-CBC-128: sensors,
  chassis state and the system event log.
- Virtual media: mounting an ISO as a virtual USB CD-ROM. Incomplete — the BMC
  loops on `READ CAPACITY(10)` and never reads data.
- A server list with passwords held in the OS keychain through `safeStorage`.
- English and Russian interface, following the system language and switchable
  from the toolbar.
- Distributables for macOS (dmg, zip), Windows (NSIS, portable) and Linux
  (AppImage, deb, tar.gz).

[Unreleased]: https://github.com/kostdm/supermicro-ipmi-client/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kostdm/supermicro-ipmi-client/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kostdm/supermicro-ipmi-client/releases/tag/v0.1.0
