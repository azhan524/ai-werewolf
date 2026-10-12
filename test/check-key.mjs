/**
 * 密钥体检脚本：把一把 Key 拿去各个 OpenAI 兼容平台试一遍，告诉你
 *   ① 它到底属于哪家 ② 能不能真的调通 ③ 有哪些模型可用
 *
 * 用法（推荐用环境变量传，避免密钥出现在命令行历史里）：
 *   $env:TEST_KEY='sk-xxx'; node test/check-key.mjs
 * 可选：
 *   $env:TEST_PROXY='http://127.0.0.1:7897'   走代理（测海外厂商需要）
 *   $env:TEST_ONLY='xai,openai'                只测指定平台
 *
 * 注意：脚本只用 **免费的 /models 列表接口** 探路，只有确认某家可用后，
 *       才做一次 max_tokens=1 的最小对话验证（花费可忽略）。
 */
import { ProxyAgent, fetch as uFetch } from 'undici';

const KEY = String(process.env.TEST_KEY || process.argv[2] || '').trim();
const PROXY = String(process.env.TEST_PROXY || 'http://127.0.0.1:7897').trim();
const ONLY = String(process.env.TEST_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!KEY) {
  console.error('缺少密钥：请设置环境变量 TEST_KEY，或作为第一个参数传入');
  process.exit(2);
}

const mask = (k) => (k.length <= 10 ? k.slice(0, 2) + '***' : `${k.slice(0, 6)}…${k.slice(-4)}（共 ${k.length} 字符）`);

/** 平台清单：baseUrl + 用来试对话的模型名 */
const PROVIDERS = [
  { id: 'xai', name: 'xAI Grok', base: 'https://api.x.ai/v1', model: 'grok-4', foreign: true, keyPrefix: 'xai-' },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', foreign: true, keyPrefix: 'sk-' },
  { id: 'anthropic', name: 'Anthropic Claude', base: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', foreign: true, keyPrefix: 'sk-ant-' },
  { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', foreign: true, keyPrefix: 'AIza' },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', foreign: true, keyPrefix: 'sk-or-' },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', foreign: false },
  { id: 'moonshot', name: '月之暗面 Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', foreign: false },
  { id: 'dashscope', name: '阿里云百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo', foreign: false },
  { id: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', foreign: false },
  { id: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', foreign: false },
  { id: 'volcengine', name: '火山方舟豆包', base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', foreign: false },
  { id: 'ppio', name: 'PPIO 派欧云', base: 'https://api.ppinfra.com/v3/openai', model: 'deepseek/deepseek-v3', foreign: false },
  { id: '302ai', name: '302.AI 聚合', base: 'https://api.302.ai/v1', model: 'gpt-4o-mini', foreign: true },
  { id: 'aihubmix', name: 'AiHubMix 聚合', base: 'https://aihubmix.com/v1', model: 'gpt-4o-mini', foreign: true },
];

const agent = PROXY ? new ProxyAgent(PROXY) : null;
const fetchOpts = (extra) => ({ ...(agent ? { dispatcher: agent } : {}), signal: AbortSignal.timeout(25000), ...extra });
const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 120);

async function probeModels(base, key = KEY) {
  for (const url of [`${base}/models`, `${base.replace(/\/v\d+[^/]*$/, '')}/models`]) {
    try {
      const res = await uFetch(url, fetchOpts({ headers: key ? { Authorization: `Bearer ${key}`, Accept: 'application/json' } : { Accept: 'application/json' } }));
      const text = await res.text();
      if (res.status === 404) continue;
      return { status: res.status, text };
    } catch (err) {
      return { status: 0, text: short(err.message) };
    }
  }
  return { status: 404, text: 'not found' };
}

function parseModelIds(text) {
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : j?.data || j?.models || j?.result || [];
    return arr.map((x) => (typeof x === 'string' ? x : x?.id || x?.name)).filter(Boolean);
  } catch {
    return [];
  }
}

async function probeChat(base, model) {
  try {
    const res = await uFetch(`${base}/chat/completions`, fetchOpts({
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '说一个字：好' }], max_tokens: 1, temperature: 0 }),
    }));
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: short(err.message) };
  }
}

function errMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.error || j?.message || j?.reason || '';
    return typeof m === 'string' && m ? m : text;
  } catch {
    return text;
  }
}

console.log(`\n=== 密钥体检 ===`);
console.log(`密钥：${mask(KEY)}`);
console.log(`代理：${PROXY || '（直连）'}`);
console.log(`提示：xAI 的 Key 通常以 xai- 开头${KEY.startsWith('xai-') ? ' ✓ 你的符合' : `，而你这把是 ${KEY.slice(0, 3)}… 开头`}`);
console.log(`判定标准：**以对话接口为准**（很多平台的 /models 列表是公开的，不能用来验证身份）\n`);

const list = ONLY.length ? PROVIDERS.filter((p) => ONLY.includes(p.id)) : PROVIDERS;
const works = [];

for (const p of list) {
  // ① 先看 /models 带不带 Key 都能拿到 → 判断它是不是公开列表
  const withKey = await probeModels(p.base, KEY);
  const withoutKey = await probeModels(p.base, '');
  const listIsPublic = withKey.status === 200 && withoutKey.status === 200;
  const ids = withKey.status === 200 ? parseModelIds(withKey.text) : [];
  const model = ids.includes(p.model) ? p.model
    : (ids.find((m) => /grok|gpt|claude|gemini|deepseek|qwen|glm|moonshot|kimi/i.test(m)) || p.model);

  // ② 真正的判定：调用一次最小对话
  const chat = await probeChat(p.base, model);
  const body = errMessage(chat.text);
  let verdict;
  if (chat.status === 200) {
    verdict = '✅ 可用';
    works.push({ p, model, ids });
  } else if (/temperature/i.test(body)) {
    // 能抱怨 temperature 说明认证已经过了（Kimi K2 / OpenAI o 系列只允许 1）
    verdict = '🔑 Key 有效（该模型要求 temperature=1）';
    works.push({ p, model: '', ids, keyOnly: true });
  } else if (/invalid temperature|only 1 is allowed/i.test(body)) {
    verdict = '🔑 Key 有效（参数受限）';
    works.push({ p, model: '', ids, keyOnly: true });
  } else if (/insufficient|quota|balance|余额|额度/i.test(body)) {
    verdict = '🔑 Key 有效，但账户没余额';
    works.push({ p, model: '', ids, keyOnly: true });
  } else if (/model.*(not exist|not found|does not exist|invalid model|unknown)|no such model|无此模型|模型不存在/i.test(body) && ![401, 403].includes(chat.status)) {
    verdict = '🔑 Key 有效，但模型名不对';   // 能走到"模型不存在"说明认证已经过了
    works.push({ p, model: '', ids, keyOnly: true });
  } else if (chat.status === 401 || chat.status === 403) {
    verdict = '❌ Key 无效';
  } else if (/api key|token|credential|auth|认证|令牌/i.test(body) && chat.status === 400) {
    verdict = '❌ Key 无效';                 // 有些平台用 400 表达认证失败（比如 xAI）
  } else if (chat.status === 404) {
    verdict = '❓ 接口路径不对（该平台可能不走这个地址）';
  } else {
    verdict = `❌ HTTP ${chat.status}`;
  }

  const listNote = withKey.status === 200
    ? `模型列表 ${ids.length} 个${listIsPublic ? '（公开列表，任何人都能拿到，不能证明 Key 有效）' : ''}`
    : `列表 HTTP ${withKey.status}`;
  console.log(`${verdict.padEnd(21, ' ')} ${p.name.padEnd(16, ' ')} ${listNote}`);
  if (chat.status !== 200) console.log(`${' '.repeat(21)} └─ 对话返回：${short(body)}`);
}

console.log('');
if (!works.length) {
  console.log('结论：这把 Key 在所有试过的平台上都被拒绝（401/403）—— 它无效、已删除，或者不属于这些平台。');
  console.log('     · 如果它是从"中转站/代理站"买的，需要那个站自己的 Base URL，api.x.ai 是调不通的');
  console.log('     · 如果确定是 xAI 官方 Key，请到 https://console.x.ai 重新生成（注意 xAI 的 Key 以 xai- 开头）');
  process.exit(1);
}
console.log(`结论：可用平台 ${works.length} 个 —— ${works.map((w) => w.p.name).join('、')}`);
console.log('');
process.exit(0);
