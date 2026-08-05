# Security Policy

## Supported versions

The project is pre-1.0: only the latest release receives fixes.

## Reporting a vulnerability

Please report security issues privately rather than in a public issue —
by email to kostdm@gmail.com, or through GitHub's private vulnerability
reporting on this repository.

Include what an attacker would gain and how to reproduce it. You should get an
acknowledgement within a week.

## What this software does with your credentials

- BMC passwords are stored through Electron's `safeStorage` (Keychain on macOS,
  DPAPI on Windows, the Secret Service on Linux). Where the system offers no
  secure storage, passwords are not saved at all.
- Connection profiles — address, port, user name — are stored as plain JSON in
  the application's `userData` directory. No password is ever written there.
- The renderer runs without `nodeIntegration`, with `contextIsolation` on, and
  reaches the network only through the explicit `contextBridge` API in
  `src/preload/index.ts`.
- A Content-Security-Policy in `src/renderer/index.html` blocks external
  resources; the interface loads nothing from the network.

## Known weaknesses you should know about

These are properties of the protocol and the firmware, not bugs that a patch
here can remove:

- **TLS verification is disabled by default.** A BMC almost always presents a
  self-signed certificate for its factory hostname, and verification makes the
  connection impossible; the original JViewer trusts everything too. This means
  the KVM session is not protected against an active man-in-the-middle. If you
  have installed a certificate from your own CA, set `insecureTls: false`.
- **The KVM session token travels in the clear** when the BMC is configured
  without TLS, and the same token authenticates virtual media.
- **Input encryption (Blowfish) is not implemented.** BMCs do not require it by
  default, so keystrokes and mouse movement travel unencrypted unless the whole
  session is wrapped in TLS.

The practical conclusion is the usual one: a BMC belongs on an isolated
management network that is not routed from anywhere else.
