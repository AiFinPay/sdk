// One-shot install event. Runs at `npm install` time, so it has its own consent
// level: it does anything only when AIFINPAY_TELEMETRY=install. Any other value
// (including unset) returns before the package is even loaded. It must never
// fail an install: every error is swallowed and the exit code is always 0.
if (process.env.AIFINPAY_TELEMETRY?.trim().toLowerCase() === "install") {
  try {
    const { emit, shutdown } = await import("../dist/index.js");
    const ua = process.env.npm_config_user_agent ?? "";
    emit("agent_sdk_install_completed", {
      package_manager: ua.split("/")[0] || "unknown",
      package_version: process.env.npm_package_version ?? null,
      node_version: process.versions.node,
      os: process.platform,
      arch: process.arch,
      ci: Boolean(process.env.CI),
    });
    await shutdown();
  } catch {
    // dist missing (source checkout) or network down — never break the install
  }
}
