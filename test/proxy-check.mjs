// 验证：内置 undici 的 ProxyAgent 能不能让请求真的走代理
import { ProxyAgent, fetch as uFetch } from 'undici';

const PROXY = process.env.PROBE_PROXY || 'http://127.0.0.1:8888';
const TARGET = process.env.PROBE_TARGET || 'http://127.0.0.1:8801/v1/models';
const agent = new ProxyAgent(PROXY);

const stats = async () => (await fetch(`${PROXY}/__stats`)).json();

const before = await stats();
console.log(`  起始代理连接数：${before.connects}`);

// ① 用内置 undici 自己的 fetch + dispatcher
try {
  const r = await uFetch(TARGET, { dispatcher: agent });
  console.log(`  ① undici.fetch + dispatcher → HTTP ${r.status}`);
} catch (err) {
  console.log(`  ① undici.fetch + dispatcher → 失败：${err.message.slice(0, 70)}`);
}

// ② 用 Node 自带的全局 fetch，但传入内置 undici 的 dispatcher
try {
  const r = await fetch(TARGET, { dispatcher: agent });
  console.log(`  ② 全局 fetch + 外部 dispatcher → HTTP ${r.status}`);
} catch (err) {
  console.log(`  ② 全局 fetch + 外部 dispatcher → 失败：${err.message.slice(0, 70)}`);
}

const after = await stats();
console.log(`  结束代理连接数：${after.connects} → ${after.connects > before.connects ? '✅ 请求确实走了代理' : '❌ 没走代理'}`);
console.log(`  代理看到的目标：${after.seen.slice(before.seen.length).join(' | ') || '(无)'}`);
process.exit(0);
