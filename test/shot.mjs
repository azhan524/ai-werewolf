// 通过 Chrome DevTools 协议截图（可先在页面里执行一段 JS，用来打开弹窗等）
// 用法：node test/shot.mjs <url> <输出png> [在页面里执行的JS]
const [, , url, out, evalJs] = process.argv;
const PORT = Number(process.env.CDP_PORT || 9333);

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('找不到可调试的页面，Chrome 起了吗？');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        for (const l of [...listeners]) l(msg);
      }
    };
    ws.onerror = (err) => reject(err);
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        once(method) {
          return new Promise((res) => {
            const l = (msg) => {
              if (msg.method === method) {
                listeners.splice(listeners.indexOf(l), 1);
                res(msg.params);
              }
            };
            listeners.push(l);
          });
        },
        close: () => ws.close(),
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = await findTarget();
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const loaded = cdp.once('Page.loadEventFired');
await cdp.send('Page.navigate', { url });
await Promise.race([loaded, sleep(15000)]);
await sleep(1800);
if (evalJs) {
  const result = await cdp.send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    console.error('页面脚本报错：', JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails));
  } else if (result.result && result.result.value !== undefined) {
    console.log('页面返回值：', JSON.stringify(result.result.value));
  }
  await sleep(900);
}
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`已保存 ${out}`);
cdp.close();
process.exit(0);
