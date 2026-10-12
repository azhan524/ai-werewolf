// 探针：起一个本地 CONNECT 代理，用来验证 Node 的 fetch 到底走不走代理
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PROBE_PORT || 8888);
let connects = 0;
const seen = [];

const server = http.createServer((req, res) => {
  // 统计查询：给测试用，确认代理到底有没有被使用
  if (req.url === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ connects, seen }));
  }
  // 普通 HTTP 代理请求（http:// 目标）
  connects++;
  seen.push(`HTTP ${req.url}`);
  res.writeHead(502).end('probe: http proxy not implemented');
});

server.on('connect', (req, clientSocket, head) => {
  connects++;
  seen.push(`CONNECT ${req.url}`);
  const [host, port] = req.url.split(':');
  const upstream = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`probe proxy listening on 127.0.0.1:${PORT}`));

setTimeout(() => {
  console.log(`RESULT connects=${connects} ${seen.join(' | ')}`);
  process.exit(0);
}, Number(process.env.PROBE_LIFETIME || 15000));
