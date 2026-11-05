/**
 * Raspberry Pi 5 PCIe link health: negotiated (current) vs. capable (max)
 * link speed/width per device from sysfs, plus HAT+ ID EEPROM identification
 * and recent PCIe dmesg lines. Zero-privilege — every source is
 * world-readable on this hardware (`lspci -vv`'s capability details need
 * root here; sysfs doesn't, so sysfs is the primary source, matching the
 * family's "prefer sysfs over lspci where available" guidance). Read-only.
 *
 * Becomes most useful once an NVMe SSD is attached via a PCIe base (the
 * common silent failure is link training down to Gen 1 or a narrower
 * width) — this machine currently has no such device attached, so this
 * model was built and tested against the always-present internal RP1
 * link, with the multi-device design deliberately generalizing to however
 * many PCIe devices exist rather than assuming a single "the" device.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. Deno's
 * permission checker demands the literal `--allow-all` flag for `/proc`
 * reads and symlinked `/sys` attribute file reads — no scoped
 * `--allow-read` satisfies it, even though the files are world-readable
 * either way. Same workaround the rest of this family uses.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** List immediate child basenames of a directory via `find`, for the same sandbox reason `catFile` shells out to `cat`. */
async function listDirNames(path: string): Promise<string[]> {
  const cmd = new Deno.Command("find", {
    args: [path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\n"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `find ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).split("\n").filter((l) =>
    l.length > 0
  );
}

/** Result of the hardware guard every method runs before doing real work. */
export interface PiHardwareInfo {
  /** `/proc/device-tree/model`, NUL byte stripped. */
  model: string;
  /** True when `model` names a Raspberry Pi 5 specifically. */
  isPi5: boolean;
}

/**
 * Hardware guard every method calls before writing any resource. This
 * model is Pi-5-specific: the BCM2712's PCIe architecture (the internal
 * RP1 link and the external NVMe-capable connector) doesn't exist in the
 * same form on earlier Pi models.
 */
export async function assertRaspberryPi5Hardware(): Promise<PiHardwareInfo> {
  let rawModel: string;
  try {
    rawModel = await catFile("/proc/device-tree/model");
  } catch (error) {
    throw new Error(
      `This model requires Raspberry Pi 5 hardware: /proc/device-tree/model ` +
        `is missing or unreadable (${
          error instanceof Error ? error.message : String(error)
        }).`,
    );
  }
  // The kernel reports this value NUL-terminated, not newline-terminated.
  const model = rawModel.replace(/\0+$/, "").trim();
  if (!model.includes("Raspberry Pi 5")) {
    throw new Error(
      `This model requires a Raspberry Pi 5 specifically: /proc/device-tree/model ` +
        `reports "${model}".`,
    );
  }
  return { model, isPi5: true };
}

/** Parse a current_link_speed/max_link_speed value (e.g. "5.0 GT/s PCIe") into a GT/s number, or null on an unrecognized format. */
export function parseLinkSpeedGtps(
  text: string,
  logger?: MinimalLogger,
): number | null {
  const match = /^([\d.]+)\s*GT\/s/.exec(text.trim());
  if (!match) {
    logger?.warn(`Unexpected link speed format: "{text}"; leaving null`, {
      text: text.trim(),
    });
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Parse a current_link_width/max_link_width value (a plain integer) into a number, or null on an unrecognized format. */
export function parseLinkWidth(
  text: string,
  logger?: MinimalLogger,
): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    logger?.warn(`Unexpected link width format: "{text}"; leaving null`, {
      text: text.trim(),
    });
    return null;
  }
  return value;
}

/**
 * Cap a device's own capable (max) speed or width at its upstream port's.
 * A link trains to the lower of its two ends, so an x4 Gen 3 NVMe behind
 * the Pi 5's x1 Gen 2 external port is at full capability at x1 5 GT/s.
 * Comparing against the endpoint's own max alone flagged that as degraded
 * on every read. The value passes through unchanged when there is no
 * upstream port (a root port) or its value is unknown.
 */
export function capToUpstream(
  own: number | null,
  upstream: number | null,
): number | null {
  if (own === null || upstream === null) return own;
  return Math.min(own, upstream);
}

/** Return the upstream port's PCI address (the parent directory in the resolved sysfs path), or null for a root port or a non-sysfs path. */
async function upstreamPortAddress(devicePath: string): Promise<string | null> {
  const cmd = new Deno.Command("readlink", {
    args: ["-f", devicePath],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) return null;
  const parts = new TextDecoder().decode(output.stdout).trim().split("/");
  const parent = parts[parts.length - 2] ?? "";
  return /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(parent)
    ? parent
    : null;
}

/** True when negotiated (current) is below capable (max) on either speed or width; null when either side is unknown. */
export function computeDegraded(
  currentSpeed: number | null,
  maxSpeed: number | null,
  currentWidth: number | null,
  maxWidth: number | null,
): boolean | null {
  if (
    currentSpeed === null || maxSpeed === null || currentWidth === null ||
    maxWidth === null
  ) {
    return null;
  }
  return currentSpeed < maxSpeed || currentWidth < maxWidth;
}

/** Filter dmesg output to lines mentioning "pcie" (case-insensitive), most recent last, capped to `limit`. `truncated` is true when more matching lines existed than `limit` kept. */
export function filterPcieDmesgLines(
  dmesgOutput: string,
  limit: number,
): { lines: string[]; truncated: boolean } {
  const matches = dmesgOutput.split("\n").filter((line) => /pcie/i.test(line));
  return { lines: matches.slice(-limit), truncated: matches.length > limit };
}

const GlobalArgsSchema = z.object({
  pciDevicesBasePath: z.string().default("/sys/bus/pci/devices").describe(
    "sysfs path enumerating PCI devices.",
  ),
  hatBasePath: z.string().default("/proc/device-tree/hat").describe(
    "Device-tree path for HAT+ ID EEPROM data. Its absence is a normal, " +
      "expected state (no HAT attached), not an error.",
  ),
  dmesgLineLimit: z.number().default(20).describe(
    "Maximum number of pcie-matching dmesg lines to keep, most recent last.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PcieDeviceSchema = z.object({
  address: z.string().describe('PCI address, e.g. "0002:01:00.0".'),
  vendorId: z.string().nullable().describe(
    'Vendor ID hex string, e.g. "0x14e4". Null when unreadable.',
  ),
  deviceId: z.string().nullable().describe(
    'Device ID hex string, e.g. "0x2712". Null when unreadable.',
  ),
  classCode: z.string().nullable().describe(
    'PCI class code hex string, e.g. "0x060400". Null when unreadable.',
  ),
  currentLinkSpeedGtps: z.number().nullable().describe(
    "Negotiated link speed in GT/s. Null when current_link_speed is " +
      "missing or in an unrecognized format.",
  ),
  maxLinkSpeedGtps: z.number().nullable().describe(
    "Capable link speed in GT/s (max_link_speed). Null under the same " +
      "condition as currentLinkSpeedGtps.",
  ),
  currentLinkWidth: z.number().nullable().describe(
    "Negotiated link width (lanes). Null when unreadable/unparseable.",
  ),
  maxLinkWidth: z.number().nullable().describe(
    "Capable link width (lanes). Null under the same condition as " +
      "currentLinkWidth.",
  ),
  degraded: z.boolean().nullable().describe(
    "True when negotiated speed or width is below capable — the silent " +
      "failure this model exists to catch. Capable is the lower of this " +
      "device's own max and its upstream port's, since a link can't " +
      "train past either end. Null when speed/width on " +
      "either side couldn't be read, rather than guessed as false.",
  ),
});

const HatInfoSchema = z.object({
  vendor: z.string().nullable().describe(
    "HAT+ EEPROM vendor string, NUL-stripped. Null if unreadable.",
  ),
  product: z.string().nullable().describe(
    "HAT+ EEPROM product string, NUL-stripped. Null if unreadable.",
  ),
  productId: z.string().nullable().describe(
    "HAT+ EEPROM product_id string, NUL-stripped. Null if unreadable.",
  ),
  uuid: z.string().nullable().describe(
    "HAT+ EEPROM uuid string, NUL-stripped. Null if unreadable.",
  ),
});

const PcieSchema = z.object({
  devices: z.array(PcieDeviceSchema).describe(
    "Every PCI device found under pciDevicesBasePath, in enumeration " +
      "order. On this Pi 5, always includes the internal Broadcom root " +
      "bridge and RP1 south bridge even with no external card attached.",
  ),
  linkDegraded: z.boolean().describe(
    "True when any device in devices has degraded == true. Hoisted so a " +
      "workflow assert doesn't need to filter the devices array — this " +
      "is the field a link-integrity assertion checks. false when no " +
      "device is degraded, including when a device's own degraded is " +
      "null (unknown does not count as degraded — see each device's own " +
      "field for that nuance).",
  ),
  hat: HatInfoSchema.nullable().describe(
    "HAT+ ID EEPROM identification, or null when no HAT is attached — a " +
      "normal, expected state, not a degraded read.",
  ),
  recentPcieDmesgLines: z.array(z.string()).nullable().describe(
    'Up to dmesgLineLimit recent dmesg lines mentioning "pcie", most ' +
      "recent last. Null when dmesg itself couldn't be read (e.g. " +
      "kernel.dmesg_restrict blocking unprivileged reads on some systems " +
      "— unrestricted on the machine this was built on).",
  ),
  recentPcieDmesgLinesTruncated: z.boolean().nullable().describe(
    "True when more pcie-matching dmesg lines existed than " +
      "dmesgLineLimit kept. Null under the same condition as " +
      "recentPcieDmesgLines (dmesg unreadable) rather than a guessed false.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

/** Model definition for `@aaronge/rpi-pcie` — Pi 5 PCIe link health. */
export const model = {
  type: "@aaronge/rpi-pcie",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pcie: {
      description:
        "Negotiated vs. capable PCIe link speed/width per device, HAT+ " +
        "ID EEPROM info, and recent pcie dmesg lines. Catches link " +
        "training down to a lower speed/width, which otherwise presents " +
        "only as 'my SSD is mysteriously slow'.",
      schema: PcieSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    readPcie: {
      description:
        "Enumerate PCI devices and their negotiated/capable link speed " +
        "and width, read HAT+ ID EEPROM data if present, grep recent " +
        "pcie dmesg lines, and write the pcie resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPi5Hardware();
        const capturedAt = new Date().toISOString();
        const { pciDevicesBasePath, hatBasePath, dmesgLineLimit } =
          context.globalArgs;

        context.logger.info(
          "Enumerating PCI devices under {pciDevicesBasePath}",
          {
            pciDevicesBasePath,
          },
        );
        const addresses = await listDirNames(pciDevicesBasePath);

        async function readAttr(
          devicePath: string,
          attr: string,
        ): Promise<string | null> {
          try {
            return await catFile(`${devicePath}/${attr}`);
          } catch (error) {
            context.logger.warn(
              "Could not read {attr} for {devicePath}: {message}",
              {
                attr,
                devicePath,
                message: error instanceof Error ? error.message : String(error),
              },
            );
            return null;
          }
        }

        const devices = await Promise.all(addresses.map(async (address) => {
          const devicePath = `${pciDevicesBasePath}/${address}`;
          const vendorId = await readAttr(devicePath, "vendor");
          const deviceId = await readAttr(devicePath, "device");
          const classCode = await readAttr(devicePath, "class");

          const currentSpeedText = await readAttr(
            devicePath,
            "current_link_speed",
          );
          const maxSpeedText = await readAttr(devicePath, "max_link_speed");
          const currentWidthText = await readAttr(
            devicePath,
            "current_link_width",
          );
          const maxWidthText = await readAttr(devicePath, "max_link_width");

          const currentLinkSpeedGtps = currentSpeedText === null
            ? null
            : parseLinkSpeedGtps(currentSpeedText, context.logger);
          const maxLinkSpeedGtps = maxSpeedText === null
            ? null
            : parseLinkSpeedGtps(maxSpeedText, context.logger);
          const currentLinkWidth = currentWidthText === null
            ? null
            : parseLinkWidth(currentWidthText, context.logger);
          const maxLinkWidth = maxWidthText === null
            ? null
            : parseLinkWidth(maxWidthText, context.logger);

          // Judge the link against what both ends can do, not the
          // endpoint alone — see capToUpstream.
          const upstream = await upstreamPortAddress(devicePath);
          const upstreamPath = upstream === null
            ? null
            : `${pciDevicesBasePath}/${upstream}`;
          const upstreamSpeedText = upstreamPath === null
            ? null
            : await readAttr(upstreamPath, "max_link_speed");
          const upstreamWidthText = upstreamPath === null
            ? null
            : await readAttr(upstreamPath, "max_link_width");
          const upstreamMaxSpeed = upstreamSpeedText === null
            ? null
            : parseLinkSpeedGtps(upstreamSpeedText, context.logger);
          const upstreamMaxWidth = upstreamWidthText === null
            ? null
            : parseLinkWidth(upstreamWidthText, context.logger);

          const degraded = computeDegraded(
            currentLinkSpeedGtps,
            capToUpstream(maxLinkSpeedGtps, upstreamMaxSpeed),
            currentLinkWidth,
            capToUpstream(maxLinkWidth, upstreamMaxWidth),
          );

          if (degraded) {
            context.logger.warn(
              "PCIe link degraded on {address}: current {currentLinkSpeedGtps}GT/s x{currentLinkWidth} " +
                "vs capable {maxLinkSpeedGtps}GT/s x{maxLinkWidth}",
              {
                address,
                currentLinkSpeedGtps,
                currentLinkWidth,
                maxLinkSpeedGtps,
                maxLinkWidth,
              },
            );
          }

          return {
            address,
            vendorId,
            deviceId,
            classCode,
            currentLinkSpeedGtps,
            maxLinkSpeedGtps,
            currentLinkWidth,
            maxLinkWidth,
            degraded,
          };
        }));

        const linkDegraded = devices.some((d) => d.degraded === true);

        context.logger.info("Checking for a HAT+ ID EEPROM at {hatBasePath}", {
          hatBasePath,
        });
        let hat: {
          vendor: string | null;
          product: string | null;
          productId: string | null;
          uuid: string | null;
        } | null = null;
        try {
          await listDirNames(hatBasePath);
          hat = {
            vendor: await readAttr(hatBasePath, "vendor"),
            product: await readAttr(hatBasePath, "product"),
            productId: await readAttr(hatBasePath, "product_id"),
            uuid: await readAttr(hatBasePath, "uuid"),
          };
        } catch {
          context.logger.info(
            "No HAT+ ID EEPROM found at {hatBasePath} — normal when no HAT is attached",
            { hatBasePath },
          );
        }

        context.logger.info("Reading recent pcie dmesg lines");
        let recentPcieDmesgLines: string[] | null = null;
        let recentPcieDmesgLinesTruncated: boolean | null = null;
        try {
          const cmd = new Deno.Command("dmesg", {
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (output.success) {
            const filtered = filterPcieDmesgLines(
              new TextDecoder().decode(output.stdout),
              dmesgLineLimit,
            );
            recentPcieDmesgLines = filtered.lines;
            recentPcieDmesgLinesTruncated = filtered.truncated;
          } else {
            context.logger.warn(
              "dmesg failed ({stderr}); leaving recentPcieDmesgLines null " +
                "— check kernel.dmesg_restrict if this is unexpected",
              { stderr: new TextDecoder().decode(output.stderr).trim() },
            );
          }
        } catch (error) {
          context.logger.warn(
            "dmesg unavailable ({message}); leaving recentPcieDmesgLines null",
            { message: error instanceof Error ? error.message : String(error) },
          );
        }

        context.logger.info(
          "Captured PCIe state: {deviceCount} device(s), linkDegraded={linkDegraded}, hat={hatPresent}",
          {
            deviceCount: devices.length,
            linkDegraded,
            hatPresent: hat !== null,
          },
        );

        const handle = await context.writeResource("pcie", "pcie", {
          devices,
          linkDegraded,
          hat,
          recentPcieDmesgLines,
          recentPcieDmesgLinesTruncated,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
