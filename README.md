# @aaronge/rpi-pcie

Raspberry Pi 5 PCIe link health — negotiated (current) vs. capable (max)
link speed/width per device, HAT+ ID EEPROM identification, and recent
`pcie`-matching `dmesg` lines — as a typed, versioned Swamp model. The
common silent failure with an NVMe SSD over a PCIe base is link training
down to Gen 1 or a narrower width, which presents only as "my SSD is
mysteriously slow." Zero privileges: every source is world-readable on
this hardware (`lspci -vv`'s capability details need root here — sysfs
doesn't, so sysfs is the primary source). Read-only.

First built against this Pi 5 before any NVMe base was attached, when it
only saw the internal Broadcom-to-RP1 link (which is never degraded on
healthy hardware). The multi-device design deliberately generalizes to
however many PCIe devices exist rather than assuming a single "the"
device, so it picked up the NVMe SSD on the external PCIe port, and that
port's bridge, with no changes once they were attached.

## Installation

```sh
swamp extension pull @aaronge/rpi-pcie
```

## Usage

```sh
swamp model create @aaronge/rpi-pcie pcie-local

swamp model method run pcie-local readPcie
```

The method writes one resource: `pcie`. Every field is described — run
`swamp model type describe @aaronge/rpi-pcie` to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("pcie-local", "pcie").attributes.linkDegraded == false
```

## Global arguments

| Arg                  | Default                     | Notes                                                       |
| ---------------------- | ------------------------------ | --------------------------------------------------------------- |
| `pciDevicesBasePath`  | `"/sys/bus/pci/devices"`      | sysfs path enumerating PCI devices.                            |
| `hatBasePath`         | `"/proc/device-tree/hat"`     | Device-tree path for HAT+ ID EEPROM data. Absence is normal.    |
| `dmesgLineLimit`      | `20`                          | Max pcie-matching dmesg lines kept, most recent last.           |

## How it works

- **`pcie`** — enumerates every device under `pciDevicesBasePath` and
  reads its `current_link_speed`/`max_link_speed`/`current_link_width`/
  `max_link_width`. Each device's `degraded` is `true` when negotiated is
  below capable on either speed or width, `null` (not a guessed `false`)
  when either side couldn't be read. "Capable" is the lower of the
  device's own max and its upstream port's max, read from the parent PCI
  address in the device's resolved sysfs path. A link trains to the slower
  of its two ends, so an x4 Gen 3 NVMe SSD behind the Pi 5's x1 Gen 2
  external port is at full capability at x1 5 GT/s, not degraded. Before
  2026.11.05.1, comparing against the endpoint's own max alone flagged
  that permanently. A root port, or an upstream value that can't be read,
  leaves the device's own max in place. The top-level `linkDegraded` is
  hoisted as the OR across every device's `degraded == true` — the field a
  workflow assert actually checks — rather than picking one "primary"
  device, since which device matters (the internal RP1 link or the NVMe
  SSD) isn't fixed.

  `hat` reads the HAT+ ID EEPROM (`vendor`/`product`/`product_id`/`uuid`,
  each NUL-terminated) and is `null` when no HAT is attached — a normal,
  expected state, not a degraded read.

  `recentPcieDmesgLines` greps `dmesg` for `pcie` (case-insensitive),
  keeping the most recent `dmesgLineLimit` matches, with
  `recentPcieDmesgLinesTruncated` set whenever more matches existed than
  fit. Both degrade to `null` (with a warning) if `dmesg` itself is
  unreadable — relevant on systems where `kernel.dmesg_restrict` blocks
  unprivileged reads (unrestricted on the machine this was built on).

Refuses to run on non-Pi-5 hardware — checking `/proc/device-tree/model`
names a Raspberry Pi 5 specifically — before writing anything. Unlike the
BOOT_ORDER decode in `@aaronge/rpi-boot-config`, this model *is*
Pi-5-specific: the BCM2712's PCIe architecture doesn't exist in the same
form on earlier Pi models.

## Workflow

The workflow is listed under `workflows:` in `manifest.yaml`, so
`swamp extension pull @aaronge/rpi-pcie` installs it alongside the model. It
expects a model instance named `pcie-local`.

The extension ships an `@aaronge/rpi-pcie` workflow: a `collect` job runs
`readPcie`, an `assert` job fails the run when `linkDegraded == true`
(`allowFailure: false` — silent performance loss made loud), and a
`report` job prints a one-screen summary regardless of whether the assert
job passed. Scheduled every 5 minutes via `trigger.schedule`, the same
cadence as the other telemetry-focused extensions in this family.

## License

MIT — see LICENSE for details.
