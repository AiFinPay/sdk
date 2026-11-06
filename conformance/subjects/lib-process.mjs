import { spawn } from "node:child_process";
import { waitForPort } from "../lib/redis.mjs";

/** One child process on a port, restartable. */
export function managed(command, args, env, { port, cwd, log = () => {} }) {
  let child = null;
  const up = async () => {
    child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const output = [];
    const keep = (d) => {
      output.push(String(d));
      if (output.length > 200) output.shift();
      if (process.env.CONFORMANCE_DEBUG) process.stderr.write(d);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const died = new Promise((_, reject) => child.once("exit", (code) => reject(new Error(`exited ${code}: ${output.join("").slice(-600)}`))));
    await Promise.race([waitForPort(port), died]);
    child.removeAllListeners("exit");
    died.catch(() => {});
  };
  const down = async () => {
    if (!child) return;
    const dying = child;
    child = null;
    const gone = new Promise((r) => dying.once("exit", r));
    try { process.kill(-dying.pid, "SIGKILL"); } catch { dying.kill("SIGKILL"); }
    await gone;
  };
  return { up, down, restart: async () => { await down(); await up(); } };
}
