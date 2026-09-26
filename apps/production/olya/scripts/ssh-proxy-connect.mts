#!/usr/bin/env -S node --experimental-strip-types
// ssh's ProxyCommand for git over SSH, so `git push` goes through the egress proxy and shows up
// in its log like everything else (activescott/activeassistant#316). GIT_SSH_COMMAND in
// olya-statefulset.yaml runs it as `ssh-proxy-connect.mts %h %p`, and so does the ~/.ssh/config
// that seed-workspace.mts writes, for the shells that do not get that variable.
//
// It sends `CONNECT host:port` to $HTTPS_PROXY and, once the proxy answers 200, copies stdin to
// the tunnel and the tunnel to stdout. The image has no nc or socat to do this.
//
// The host and port are unchanged, so it is still github.com:22 and the known_hosts pin that
// seed-workspace writes still applies. The proxy does not see inside the tunnel.
import { connect } from "node:net"

const [host, port] = process.argv.slice(2)
if (!host || !port) {
  console.error("usage: ssh-proxy-connect.mts <host> <port>")
  process.exit(2)
}

const proxy = new URL(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "")
const socket = connect(Number(proxy.port || 80), proxy.hostname)

socket.on("error", (err) => {
  console.error(`ssh-proxy-connect: ${proxy.host}: ${err.message}`)
  process.exit(1)
})
socket.on("close", () => process.exit(0))

socket.once("connect", () => {
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
})

let head = Buffer.alloc(0)
function onHead(chunk: Buffer) {
  head = Buffer.concat([head, chunk])
  const end = head.indexOf("\r\n\r\n")
  if (end === -1) return
  socket.off("data", onHead)

  const status = head.subarray(0, head.indexOf("\r\n")).toString()
  if (!/^HTTP\/1\.[01] 200 /.test(status)) {
    console.error(`ssh-proxy-connect: CONNECT ${host}:${port} refused: ${status}`)
    process.exit(1)
  }
  // Anything after the header is already the server's SSH banner.
  const rest = head.subarray(end + 4)
  if (rest.length > 0) process.stdout.write(rest)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
}
socket.on("data", onHead)
