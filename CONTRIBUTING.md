# Contributing

Thanks for taking an interest. This project talks to a proprietary firmware
whose behaviour is only partly understood, so reports from hardware other than
the one it was developed on are genuinely valuable.

## Getting set up

```bash
npm install
npm run dev
```

Before opening a pull request:

```bash
npm run typecheck
npm test
```

Both run in CI as well.

## Reporting a firmware quirk

A screenshot rarely helps; the raw protocol exchange almost always does. Run
the matching debug script and paste its output:

```bash
npm run check:auth    -- <host>   # login and JNLP parsing
npm run check:kvm     -- <host>   # the KVM handshake and frame headers
npm run check:ipmi    -- <host>   # sensors, chassis, event log
npm run dump:services -- <host>   # the raw service configuration packet
```

Credentials can come from `BMC_HOST`, `BMC_USER` and `BMC_PASSWORD` instead of
the command line, which keeps the password out of your shell history and out of
`ps`.

Please include the BMC firmware version — `npm run check:ipmi` prints it — and
the board model. **Scrub addresses, MAC addresses and serial numbers** from
anything you paste.

Beware that `check:vmedia` and `check:hotkey` reboot the server.

## Code conventions

- **Comments in English**, and used to explain *why* rather than *what*. Most
  of the surprising code here exists because the firmware demands it, and that
  reason belongs next to the line — the declared-versus-actual length in the
  KVM validation packet is the canonical example.
- **No runtime dependencies.** The project ships none, and that is deliberate:
  a tool that holds BMC credentials should have a supply chain you can read in
  an afternoon. Dev dependencies are fine.
- **The main process emits message keys, never prose.** Anything a user will
  read goes through `src/shared/i18n.ts`, and both `en` and `ru` need an entry.
  A missing key falls back to English and then to the key itself, so it fails
  visibly rather than silently.
- **Protocol code is tested against captured data.** `tests/fixtures` holds
  real frames; new codec or SCSI work should come with a fixture or a
  hand-built packet, not just a unit test of the happy path.
- DOM-free logic that the renderer needs and tests should exercise lives in
  `src/shared/` — that is why the video decoder and the keyboard layout sit
  there rather than under `src/renderer/`.

## Licensing of contributions

By contributing you agree that your work is licensed under the MIT licence, the
same as the rest of the project.

Do not commit decompiled JViewer sources, the JViewer jar, or captures taken
from a machine you do not own. The protocol notes in the README describe what
was learned; the vendor's code itself does not belong in this repository.
