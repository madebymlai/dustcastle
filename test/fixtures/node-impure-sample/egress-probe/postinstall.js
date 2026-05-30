// Untrusted install-time code (ADR 0005). This runs inside the container during
// `npm ci`, AFTER dustcastle's egress confinement is in place. It does two things
// the e2e asserts on:
//   1. Drops a marker proving lifecycle code actually executed under the scoped
//      net (a postinstall that hit the network is the whole reason for impurity).
//   2. Tries to "exfiltrate" to an off-allowlist host the way a compromised dep
//      would — and records that it was blocked. The default route is gone, so a
//      raw connection has nowhere to go; the proxy is the only path out, and it
//      refuses anything off the allowlist.
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

// npm sets INIT_CWD to the directory `npm ci` was invoked in (the workspace).
const workspace = process.env.INIT_CWD || process.cwd();
const markerPath = path.join(workspace, ".postinstall-ran");

function recordExfilAttempt(outcome) {
  fs.writeFileSync(markerPath, `ran; exfil=${outcome}\n`);
}

// Attempt a direct, non-proxied connection to a host that is NOT on the
// allowlist. Under confinement this must fail (no route / refused).
const sock = net.connect({ host: "example.com", port: 443 });
let settled = false;
const finish = (outcome) => {
  if (settled) return;
  settled = true;
  sock.destroy();
  recordExfilAttempt(outcome);
};
sock.setTimeout(4000);
sock.on("connect", () => finish("REACHED")); // would mean confinement FAILED
sock.on("error", () => finish("blocked"));
sock.on("timeout", () => finish("blocked"));
