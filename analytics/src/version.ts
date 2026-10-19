/** Wire schema version sent as `AIFP-Telemetry-Schema` and in every batch body.
 *  A breaking change waits at least 90 days after the previous one (ADR 0001). */
export const AIFINPAY_TELEMETRY_SCHEMA_VERSION = 1;

/** This package's own version, reported in `AIFP-Telemetry-User-Agent`. */
export const PACKAGE_VERSION = "0.1.0";
