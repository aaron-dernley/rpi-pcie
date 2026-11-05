// Run with `deno test -A`. -A is needed because catFile/listDirNames shell
// out to `cat`/`find` for /proc and /sys reads — see the sibling
// extensions' test files for why Deno's permission checker requires it
// even for world-readable files.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  assertRaspberryPi5Hardware,
  capToUpstream,
  computeDegraded,
  filterPcieDmesgLines,
  model,
  parseLinkSpeedGtps,
  parseLinkWidth,
} from "./rpi_pcie.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = {
  pciDevicesBasePath: "/sys/bus/pci/devices",
  hatBasePath: "/proc/device-tree/hat",
  dmesgLineLimit: 20,
};

// --- parseLinkSpeedGtps ----------------------------------------------------

Deno.test("parseLinkSpeedGtps parses a typical current_link_speed reading", () => {
  assertEquals(parseLinkSpeedGtps("5.0 GT/s PCIe\n"), 5.0);
  assertEquals(parseLinkSpeedGtps("2.5 GT/s PCIe"), 2.5);
});

Deno.test("parseLinkSpeedGtps degrades to null with a warning on an unrecognized format", () => {
  const warnings: string[] = [];
  const result = parseLinkSpeedGtps("Unknown", {
    info: () => {},
    warn: (m) => warnings.push(m),
  });
  assertEquals(result, null);
  assertEquals(warnings.length, 1);
});

// --- parseLinkWidth ----------------------------------------------------

Deno.test("parseLinkWidth parses a typical current_link_width reading", () => {
  assertEquals(parseLinkWidth("4\n"), 4);
  assertEquals(parseLinkWidth("1"), 1);
});

Deno.test("parseLinkWidth degrades to null with a warning on an unrecognized format", () => {
  const warnings: string[] = [];
  const result = parseLinkWidth("Unknown", {
    info: () => {},
    warn: (m) => warnings.push(m),
  });
  assertEquals(result, null);
  assertEquals(warnings.length, 1);
});

// --- computeDegraded --------------------------------------------------------

Deno.test("computeDegraded is false when negotiated matches capable", () => {
  assertEquals(computeDegraded(5.0, 5.0, 4, 4), false);
});

Deno.test("computeDegraded is true when negotiated speed is below capable", () => {
  assertEquals(computeDegraded(2.5, 5.0, 4, 4), true);
});

Deno.test("computeDegraded is true when negotiated width is below capable", () => {
  assertEquals(computeDegraded(5.0, 5.0, 1, 4), true);
});

Deno.test("computeDegraded is null (not false) when any side is unknown, rather than guessing healthy", () => {
  assertEquals(computeDegraded(null, 5.0, 4, 4), null);
  assertEquals(computeDegraded(5.0, null, 4, 4), null);
  assertEquals(computeDegraded(5.0, 5.0, null, 4), null);
  assertEquals(computeDegraded(5.0, 5.0, 4, null), null);
});

// --- capToUpstream ----------------------------------------------------------

Deno.test("capToUpstream caps an x4 Gen 3 endpoint at the Pi 5's x1 Gen 2 upstream port", () => {
  assertEquals(capToUpstream(4, 1), 1);
  assertEquals(capToUpstream(8.0, 5.0), 5.0);
  assertEquals(computeDegraded(5.0, capToUpstream(8.0, 5.0), 1, capToUpstream(4, 1)), false);
});

Deno.test("capToUpstream passes the device's own max through when there is no upstream value", () => {
  assertEquals(capToUpstream(4, null), 4);
  assertEquals(capToUpstream(null, 1), null);
});

// --- filterPcieDmesgLines ---------------------------------------------------

Deno.test("filterPcieDmesgLines keeps only pcie-matching lines, case-insensitively, and reports untruncated when everything fits", () => {
  const output = [
    "[0.1] some unrelated line",
    "[0.2] brcm-pcie 1000120000.pcie: host bridge ranges",
    "[0.3] another unrelated line",
    "[0.4] PCIE link up",
  ].join("\n");
  assertEquals(filterPcieDmesgLines(output, 20), {
    lines: [
      "[0.2] brcm-pcie 1000120000.pcie: host bridge ranges",
      "[0.4] PCIE link up",
    ],
    truncated: false,
  });
});

Deno.test("filterPcieDmesgLines caps to the most recent `limit` matches and reports truncated=true", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `[${i}] pcie line ${i}`);
  const result = filterPcieDmesgLines(lines.join("\n"), 2);
  assertEquals(result, {
    lines: ["[3] pcie line 3", "[4] pcie line 4"],
    truncated: true,
  });
});

// --- readPcie: real hardware + mocked degraded/HAT-present scenarios -----
//
// This model refuses to run at all off Pi 5 hardware, so — like the
// sibling extensions' method-level tests — the primary test exercises the
// real sysfs on whatever host runs the suite. This machine has no NVMe
// base attached, so the real run always sees the internal RP1 link
// (never degraded) and no HAT; the degraded-link and HAT-present cases
// are covered by mocked scenarios below and should be re-verified against
// real hardware once the NVMe base is physically attached.

Deno.test("readPcie writes a pcie resource from real sysfs with sane invariants", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readPcie",
  });

  await model.methods.readPcie.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "pcie");
  const data = written[0].data as {
    devices: Array<{ address: string; degraded: boolean | null }>;
    linkDegraded: boolean;
    hat: unknown;
    capturedAt: string;
  };
  // This Pi 5 always has at least the internal Broadcom root bridge and
  // RP1 south bridge, even with nothing externally attached.
  assert(data.devices.length >= 2);
  assertEquals(typeof data.linkDegraded, "boolean");
  assert(data.hat === null, "no HAT is attached on this machine");
});

Deno.test("readPcie sets linkDegraded=true when a mocked device's negotiated speed is below capable", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readPcie",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/bus/pci/devices") {
      return { stdout: "0001:01:00.0\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:01:00.0/vendor"
    ) {
      return { stdout: "0x144d\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:01:00.0/device"
    ) {
      return { stdout: "0xa808\n", code: 0 };
    }
    if (
      command === "cat" && args[0] === "/sys/bus/pci/devices/0001:01:00.0/class"
    ) {
      return { stdout: "0x010802\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:01:00.0/current_link_speed"
    ) {
      return { stdout: "2.5 GT/s PCIe\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:01:00.0/max_link_speed"
    ) {
      return { stdout: "16.0 GT/s PCIe\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:01:00.0/current_link_width"
    ) {
      return { stdout: "1\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:01:00.0/max_link_width"
    ) {
      return { stdout: "4\n", code: 0 };
    }
    // Behind the Pi 5's x1 Gen 2 external port: capable becomes 5 GT/s x1,
    // so the 2.5 GT/s training is still caught as degraded.
    if (
      command === "readlink" &&
      args[1] === "/sys/bus/pci/devices/0001:01:00.0"
    ) {
      return {
        stdout:
          "/sys/devices/platform/axi/1000110000.pcie/pci0001:00/0001:00:00.0/0001:01:00.0\n",
        code: 0,
      };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:00:00.0/max_link_speed"
    ) {
      return { stdout: "5.0 GT/s PCIe\n", code: 0 };
    }
    if (
      command === "cat" &&
      args[0] === "/sys/bus/pci/devices/0001:00:00.0/max_link_width"
    ) {
      return { stdout: "1\n", code: 0 };
    }
    if (command === "find" && args[0] === "/proc/device-tree/hat") {
      return { stdout: "", stderr: "No such file or directory", code: 1 };
    }
    if (command === "dmesg") return { stdout: "", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readPcie.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    devices: Array<
      { degraded: boolean | null; currentLinkSpeedGtps: number | null }
    >;
    linkDegraded: boolean;
  };
  assertEquals(data.devices[0].degraded, true);
  assertEquals(data.devices[0].currentLinkSpeedGtps, 2.5);
  assertEquals(data.linkDegraded, true);
});

Deno.test("readPcie reads HAT+ EEPROM fields when the hat directory is present", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readPcie",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/bus/pci/devices") {
      return { stdout: "", code: 0 };
    }
    if (command === "find" && args[0] === "/proc/device-tree/hat") {
      return { stdout: "vendor\nproduct\nproduct_id\nuuid\n", code: 0 };
    }
    if (command === "cat" && args[0] === "/proc/device-tree/hat/vendor") {
      return { stdout: "Pimoroni\0", code: 0 };
    }
    if (command === "cat" && args[0] === "/proc/device-tree/hat/product") {
      return { stdout: "NVMe Base\0", code: 0 };
    }
    if (command === "cat" && args[0] === "/proc/device-tree/hat/product_id") {
      return { stdout: "0x0001\0", code: 0 };
    }
    if (command === "cat" && args[0] === "/proc/device-tree/hat/uuid") {
      return { stdout: "12345678-0000-0000-0000-000000000000\0", code: 0 };
    }
    if (command === "dmesg") return { stdout: "", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readPcie.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    hat: { vendor: string | null; product: string | null } | null;
    devices: unknown[];
  };
  assertEquals(data.devices, []);
  assertEquals(data.hat?.vendor, "Pimoroni\0");
  assertEquals(data.hat?.product, "NVMe Base\0");
});

Deno.test("readPcie leaves recentPcieDmesgLines null when dmesg fails, without failing the method", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readPcie",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/bus/pci/devices") {
      return { stdout: "", code: 0 };
    }
    if (command === "find" && args[0] === "/proc/device-tree/hat") {
      return { stdout: "", stderr: "No such file or directory", code: 1 };
    }
    if (command === "dmesg") {
      return {
        stdout: "",
        stderr: "dmesg: read kernel buffer failed: Operation not permitted",
        code: 1,
      };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readPcie.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    recentPcieDmesgLines: string[] | null;
    recentPcieDmesgLinesTruncated: boolean | null;
  };
  assertEquals(data.recentPcieDmesgLines, null);
  assertEquals(data.recentPcieDmesgLinesTruncated, null);
});

Deno.test("assertRaspberryPi5Hardware strips the trailing NUL from /proc/device-tree/model on this real Pi 5", async () => {
  const hardware = await assertRaspberryPi5Hardware();
  assert(!hardware.model.includes("\0"));
  assertEquals(hardware.isPi5, true);
});
