// Egress probe driven by the e2e (run with the Store's node inside the
// container). Two modes:
//
//   node probe.js connect <proxyHost:port> <targetHost>
//     Ask the egress proxy to CONNECT to <targetHost>:443 and print the proxy's
//     status line as "STATUS <code>". 200 → the proxy allowed it; 403 → refused.
//
//   node probe.js raw <host> <port>
//     Attempt a direct, non-proxied TCP connection and print "CONNECTED" or
//     "BLOCKED". Proves whether a client that ignores the proxy can still escape.
const net = require("node:net");

const [mode, a, b] = process.argv.slice(2);

if (mode === "connect") {
  const [proxyHost, proxyPort] = a.split(":");
  const target = b;
  const sock = net.connect(Number(proxyPort), proxyHost, () => {
    sock.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`);
  });
  let buf = "";
  sock.setEncoding("utf8");
  sock.setTimeout(8000);
  sock.on("data", (chunk) => {
    buf += chunk;
    const line = buf.split("\r\n", 1)[0];
    if (buf.includes("\r\n")) {
      const m = line.match(/\s(\d{3})\s/);
      console.log(`STATUS ${m ? m[1] : "???"}`);
      sock.destroy();
    }
  });
  sock.on("timeout", () => {
    console.log("STATUS timeout");
    sock.destroy();
  });
  sock.on("error", (err) => console.log(`STATUS error ${err.code || ""}`));
} else if (mode === "raw") {
  const sock = net.connect(Number(b), a, () => {
    console.log("CONNECTED");
    sock.destroy();
  });
  sock.setTimeout(5000);
  sock.on("timeout", () => {
    console.log("BLOCKED");
    sock.destroy();
  });
  sock.on("error", () => console.log("BLOCKED"));
} else {
  console.log("usage: probe.js connect <proxyHost:port> <target> | raw <host> <port>");
  process.exit(2);
}
