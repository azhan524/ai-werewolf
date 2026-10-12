// 造一局 12 人演示对局（跑完第一夜 + 部分白天发言），用于截图 / 手工体验。--clean 可清理
const BASE = process.env.APP_URL || 'http://127.0.0.1:8791';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8801/v1';
import fs from 'node:fs';

const IDS = new URL('../build/demo-ids.json', import.meta.url);

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

if (process.argv.includes('--clean')) {
  if (fs.existsSync(IDS)) {
    const ids = JSON.parse(fs.readFileSync(IDS, 'utf8'));
    for (const id of ids) await api('DELETE', `/api/agents/${id}`).catch(() => {});
    fs.rmSync(IDS, { force: true });
  }
  console.log('演示数据已清理');
  process.exit(0);
}

const NAMES = [
  { name: '小深', avatar: '🐳' }, { name: '灵犀', avatar: '🦄' }, { name: '老K', avatar: '🦉' },
  { name: '阿澄', avatar: '🐼' }, { name: '影子', avatar: '🦊' }, { name: '叮当', avatar: '🐧' },
  { name: '山鬼', avatar: '🐯' }, { name: '松果', avatar: '🐨' }, { name: '米粒', avatar: '🐰' },
  { name: '铁牛', avatar: '🐻' }, { name: '青柠', avatar: '🐸' }, { name: '大魔王', avatar: '🦁' },
];

const agents = [];
for (const n of NAMES) {
  agents.push(await api('POST', '/api/agents', {
    ...n, preset: 'custom', baseUrl: MOCK, model: 'werewolf-mock', apiKey: 'sk-demo',
    temperature: 0.85, maxTokens: 300, enabled: true,
  }));
}

await api('POST', '/api/channels/clear');
// 12 人「预女猎守」局
await api('POST', '/api/game/new', {
  rolePlan: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'],
  agentIds: agents.map((a) => a.id),
});

// 跑完第一夜 + 前几位白天发言，停在可以继续点的状态
await api('POST', '/api/host/night', {});
await api('POST', '/api/host/guard', {});
await api('POST', '/api/host/wolves', {});
await api('POST', '/api/host/seer', {});
await api('POST', '/api/host/seerReveal', {});
await api('POST', '/api/host/witchAsk', {});
await api('POST', '/api/host/witch', {});
await api('POST', '/api/host/witchApply', {});
await api('POST', '/api/host/dawn', {});
await api('POST', '/api/host/nextSpeaker', {});
await api('POST', '/api/host/nextSpeaker', {});
await api('POST', '/api/host/nextSpeaker', {});

fs.mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
fs.writeFileSync(IDS, JSON.stringify(agents.map((a) => a.id), null, 2));
const st = await api('GET', '/api/state');
console.log(`演示对局就绪：${st.seats.length} 人 · ` + st.seats.map((s) => `${s.number}:${s.roleName}`).join(' '));
