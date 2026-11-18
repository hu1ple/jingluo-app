// 端口卫生：为什么 listen(0) 也会把用例搞成假红
//
// node 的 fetch（undici）会拒绝一批 WHATWG “bad port”，一个 TCP 连接都不发：
//   TypeError: fetch failed  →  cause: 'bad port'
// 而 Windows 的 TCP 动态端口范围不是 49152 起，而是从 1024 起共 64511 个
// （netsh int ipv4 show dynamicport tcp → start=1024 num=64511），所以 listen(0) 真的会把
// 1719 / 5060 / 6000 / 6566 / 6665-6669 / 6679 / 6697 / 10080 … 当“空闲端口”发给我们。
// 用例只要把 stub / dist 绑到这些端口上，fetch 必然失败：单跑时端口分配不紧张，撞不上；
// 多条 lane 并发跑全量时才会偶发，表现为「假红」（被测代码其实没坏）。

// WHATWG bad-port 名单里落在 1024-65534（本机可被动态分配的部分）的端口。
export const FETCH_REFUSED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
])

export const isFetchUsablePort = (port) =>
  Number.isInteger(port) && port > 1023 && port < 65536 && !FETCH_REFUSED_PORTS.has(port)

const listenOnce = (server, port, host) =>
  new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })

/**
 * 绑一个 fetch 一定能连上的空闲端口：把 listen(0) 拿到的坏端口（undici bad-port 名单上的）
 * 丢掉重绑，直到拿到可用端口。choosePort 只是测试注入点，默认就是交给系统分配（0）。
 */
export const listenFreePort = async (server, { host = '127.0.0.1', choosePort = () => 0, attempts = 32 } = {}) => {
  let lastTry = 'none'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let port
    try {
      port = await listenOnce(server, Number(choosePort(attempt) ?? 0), host)
    } catch (error) {
      lastTry = String(error.code ?? error.message)
      continue
    }
    if (isFetchUsablePort(port)) return port
    lastTry = `port ${port}`
    await closeServer(server)
  }
  throw new Error(
    `cannot bind a fetch-usable port in ${attempts} attempts (last: ${lastTry}); ` +
      'bad port: undici refuses WHATWG bad ports, so fetch can never reach it'
  )
}

/** 显式要一个端口时用：坏端口直接拒绝，别交出一个 fetch 永远连不上的地址。 */
export const listenFetchablePort = async (server, port, { host = '127.0.0.1' } = {}) => {
  const wanted = Number(port)
  if (!isFetchUsablePort(wanted)) {
    throw new Error(`bad port ${wanted}: on the undici/WHATWG bad-port list, fetch can never reach it`)
  }
  return listenOnce(server, wanted, host)
}
