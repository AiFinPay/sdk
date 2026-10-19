/**
 * The per-install id: a random UUID at ~/.aifinpay/.telemetry-id, created on
 * first opt-in and never derived from anything about the machine or user.
 * Deleting the file resets it. The id is never logged.
 *
 * File rules follow the keystore rules in the root AGENTS.md: directory 700,
 * file 600, created exclusively so two processes cannot both write it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function identityPath(home: string = homedir()): string {
  return join(home, ".aifinpay", ".telemetry-id");
}

function readId(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return UUID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * `persist: false` (read-only mode) never touches the disk beyond one read.
 * A present but unreadable or malformed file is left alone — we do not
 * overwrite something we did not write — and this process gets an ephemeral id.
 */
export function resolveInstallId({ persist, home }: { persist: boolean; home?: string }): string {
  const path = identityPath(home);
  const existing = readId(path);
  if (existing) return existing;
  const fresh = randomUUID();
  if (!persist) return fresh;
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, fresh + "\n", { mode: 0o600, flag: "wx" });
    return fresh;
  } catch {
    // Lost a creation race, or the file exists but is not ours to repair.
    return readId(path) ?? fresh;
  }
}
