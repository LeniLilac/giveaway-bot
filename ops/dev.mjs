import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scripts = ["dev:bot", "dev:worker", "dev:web"];
const children = scripts.map((script) =>
  spawn(npm, ["run", script], {
    env: process.env,
    stdio: "inherit",
  }),
);

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

const exits = children.map(
  (child, index) =>
    new Promise((resolve) => {
      child.once("error", (error) => resolve({ index, code: 1, error }));
      child.once("exit", (code, signal) => resolve({ index, code: code ?? 1, signal }));
    }),
);

const first = await Promise.race(exits);
if (first.error) console.error(`Could not start ${scripts[first.index]}:`, first.error);
stop();
await Promise.allSettled(exits);
process.exitCode = first.code;
