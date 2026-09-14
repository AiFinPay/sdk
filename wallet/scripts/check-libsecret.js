#!/usr/bin/env node
/**
 * Pre-install check for keytar dependencies on Linux.
 * keytar requires libsecret-1-dev (Debian/Ubuntu) or libsecret-devel (Red Hat).
 * 
 * Exit codes:
 *   0 - All good, proceed with install
 *   1 - Missing libsecret, show instructions
 */

import { platform } from "node:os";
import { execSync } from "node:child_process";

const isLinux = platform() === "linux";

if (!isLinux) {
  process.exit(0);
}

function checkCommand(cmd) {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPkgConfig = checkCommand("pkg-config --exists libsecret-1");
const hasDevHeaders = checkCommand("test -f /usr/include/libsecret-1/libsecret/secret.h") || 
                     checkCommand("test -f /usr/local/include/libsecret-1/libsecret/secret.h");

if (hasPkgConfig || hasDevHeaders) {
  process.exit(0);
}

const distro = getDistro();
const instructions = getInstallInstructions(distro);

process.stderr.write(`
╔══════════════════════════════════════════════════════════════════════════════╗
║  @aifinpay/wallet requires libsecret for OS keyring support on Linux        ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Install the required package for your distribution:                         ║
║                                                                              ║
`);

for (const line of instructions) {
  process.stderr.write(`║  ${line.padEnd(76)}║\n`);
}

process.stderr.write(`║                                                                              ║
║  Or install keytar without keyring support (not recommended):              ║
║    npm install keytar --ignore-scripts                                     ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝

`);

process.exit(1);

function getDistro() {
  try {
    const release = execSync("cat /etc/os-release", { encoding: "utf8" });
    const idMatch = release.match(/^ID="?([^"\n]+)"?/m);
    const idLikeMatch = release.match(/^ID_LIKE="?([^"\n]+)"?/m);
    return {
      id: idMatch?.[1]?.toLowerCase() || "",
      idLike: idLikeMatch?.[1]?.toLowerCase() || ""
    };
  } catch {
    return { id: "", idLike: "" };
  }
}

function getInstallInstructions(distro) {
  const { id, idLike } = distro;
  
  if (id.includes("ubuntu") || id.includes("debian") || idLike.includes("debian") || idLike.includes("ubuntu")) {
    return ["sudo apt-get update", "sudo apt-get install libsecret-1-dev"];
  }
  
  if (id.includes("rhel") || id.includes("centos") || id.includes("fedora") || id.includes("almalinux") || idLike.includes("rhel") || idLike.includes("fedora")) {
    return ["sudo yum install libsecret-devel"];
  }
  
  if (id.includes("arch") || idLike.includes("arch")) {
    return ["sudo pacman -S libsecret"];
  }
  
  return [
    "For Debian/Ubuntu:  sudo apt-get install libsecret-1-dev",
    "For Red Hat/CentOS: sudo yum install libsecret-devel",
    "For Arch Linux:     sudo pacman -S libsecret"
  ];
}
