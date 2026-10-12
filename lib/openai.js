// OpenAI 兼容接口适配器：DeepSeek / Kimi / 通义 / 智谱 / 硅基流动 / OpenRouter / 火山方舟 / Ollama 本地……都能用
import { ProxyAgent } from 'undici';
import net from 'node:net';

/**
 * 服务商预设。
 *   group: cn = 国内直连 | global = 海外（国内需要代理） | aggregator = 聚合平台 | local = 本地部署 | custom
 *   needsProxy: true 表示国内直连不通，需要在「设置 → 网络代理」里配代理
 *   keyUrl: 申请 API Key 的控制台地址
 *   models: 常用模型名，界面上会做成可点的快捷标签（拿不到模型列表时也能直接选）
 * 注：接口地址可能随厂商调整，填错了可以直接手动改，「测试连接」会给出明确报错。
 */
export const PRESETS = [
  /* ---------- 国内直连（不用代理） ---------- */
  {
    id: 'deepseek', label: 'DeepSeek 深度求索', group: 'cn',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot', label: '月之暗面 Kimi', group: 'cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'dashscope', label: '阿里云百炼（通义千问）', group: 'cn',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-max'],
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'zhipu', label: '智谱 GLM', group: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4.5'],
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow', label: '硅基流动 SiliconFlow', group: 'cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'volcengine', label: '火山方舟（豆包）', group: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-32k', 'doubao-lite-32k'],
    keyUrl: 'https://console.volcengine.com/ark',
    note: '模型名要填"接入点 ID"或模型 ID',
  },
  {
    id: 'qianfan', label: '百度千帆（文心一言）', group: 'cn',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.0-turbo-8k', 'ernie-speed-128k', 'deepseek-v3'],
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
  },
  {
    id: 'hunyuan', label: '腾讯混元', group: 'cn',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbo', 'hunyuan-pro', 'hunyuan-large'],
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  {
    id: 'spark', label: '讯飞星火', group: 'cn',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: ['generalv3.5', '4.0Ultra', 'lite'],
    keyUrl: 'https://console.xfyun.cn/services/cbm',
  },
  {
    id: 'minimax', label: 'MiniMax 稀宇', group: 'cn',
    baseUrl: 'https://api.minimax.chat/v1',
    models: ['abab6.5s-chat', 'MiniMax-Text-01'],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'stepfun', label: '阶跃星辰 StepFun', group: 'cn',
    baseUrl: 'https://api.stepfun.com/v1',
    models: ['step-1-flash', 'step-1-8k', 'step-2-16k'],
    keyUrl: 'https://platform.stepfun.com/interface-key',
  },
  {
    id: 'sensenova', label: '商汤日日新', group: 'cn',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
    models: ['SenseChat-5', 'SenseChat-5-1202'],
    keyUrl: 'https://console.sensecore.cn/',
  },
  {
    id: 'lingyiwanwu', label: '零一万物 Yi', group: 'cn',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    models: ['yi-lightning', 'yi-large'],
    keyUrl: 'https://platform.lingyiwanwu.com/apikeys',
  },
  {
    id: 'baichuan', label: '百川智能', group: 'cn',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    keyUrl: 'https://platform.baichuan-ai.com/console/apikey',
  },
  {
    id: 'ppio', label: 'PPIO 派欧云', group: 'cn',
    baseUrl: 'https://api.ppinfra.com/v3/openai',
    models: ['deepseek/deepseek-v3', 'qwen/qwen-2.5-72b-instruct'],
    keyUrl: 'https://ppinfra.com/user/register',
  },

  /* ---------- 聚合平台（一个 Key 用多家模型） ---------- */
  {
    id: '302ai', label: '302.AI 聚合', group: 'aggregator',
    baseUrl: 'https://api.302.ai/v1',
    models: ['gpt-4o-mini', 'claude-3-5-sonnet-20241022', 'deepseek-chat', 'gemini-2.0-flash'],
    keyUrl: 'https://dash.302.ai/',
  },
  {
    id: 'aihubmix', label: 'AiHubMix 聚合', group: 'aggregator',
    baseUrl: 'https://aihubmix.com/v1',
    models: ['gpt-4o-mini', 'claude-sonnet-4-20250514', 'deepseek-chat'],
    keyUrl: 'https://aihubmix.com/token',
  },
  {
    id: 'openrouter', label: 'OpenRouter（海外聚合）', group: 'aggregator', needsProxy: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'google/gemini-2.0-flash-001', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct'],
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'oneapi', label: '自建网关（One-API / New-API）', group: 'aggregator',
    baseUrl: 'http://127.0.0.1:3000/v1',
    models: ['gpt-4o-mini', 'deepseek-chat'],
    note: '自己搭的 OpenAI 兼容网关，地址按你的部署改',
  },

  /* ---------- 海外（国内需要代理） ---------- */
  {
    id: 'openai', label: 'OpenAI', group: 'global', needsProxy: true,
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic', label: 'Anthropic Claude', group: 'global', needsProxy: true,
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '走 Anthropic 官方的 OpenAI 兼容层',
  },
  {
    id: 'gemini', label: 'Google Gemini', group: 'global', needsProxy: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai', label: 'xAI Grok', group: 'global', needsProxy: true,
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai/',
  },
  {
    id: 'mistral', label: 'Mistral AI', group: 'global', needsProxy: true,
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    keyUrl: 'https://console.mistral.ai/api-keys/',
  },
  {
    id: 'groq', label: 'Groq（超快推理）', group: 'global', needsProxy: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-32b'],
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'together', label: 'Together AI', group: 'global', needsProxy: true,
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'fireworks', label: 'Fireworks AI', group: 'global', needsProxy: true,
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    keyUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'deepinfra', label: 'DeepInfra', group: 'global', needsProxy: true,
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    models: ['meta-llama/Meta-Llama-3.1-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    keyUrl: 'https://deepinfra.com/dash/api_keys',
  },
  {
    id: 'perplexity', label: 'Perplexity（联网搜索）', group: 'global', needsProxy: true,
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar', 'sonar-pro'],
    keyUrl: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'cerebras', label: 'Cerebras', group: 'global', needsProxy: true,
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama3.3-70b', 'llama3.1-8b'],
    keyUrl: 'https://cloud.cerebras.ai/',
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', group: 'global', needsProxy: true,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct', 'qwen/qwen2.5-72b-instruct'],
    keyUrl: 'https://build.nvidia.com/',
  },
  {
    id: 'sambanova', label: 'SambaNova', group: 'global', needsProxy: true,
    baseUrl: 'https://api.sambanova.ai/v1',
    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'],
    keyUrl: 'https://cloud.sambanova.ai/apis',
  },
  {
    id: 'novita', label: 'Novita AI', group: 'global', needsProxy: true,
    baseUrl: 'https://api.novita.ai/v3/openai',
    models: ['deepseek/deepseek-v3', 'meta-llama/llama-3.3-70b-instruct'],
    keyUrl: 'https://novita.ai/settings/key-management',
  },
  {
    id: 'hyperbolic', label: 'Hyperbolic', group: 'global', needsProxy: true,
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct'],
    keyUrl: 'https://app.hyperbolic.xyz/settings',
  },
  {
    id: 'github', label: 'GitHub Models（有免费额度）', group: 'global', needsProxy: true,
    baseUrl: 'https://models.github.ai/inference',
    models: ['openai/gpt-4o-mini', 'meta/Llama-3.3-70B-Instruct'],
    keyUrl: 'https://github.com/settings/tokens',
    note: '用 GitHub PAT 当 API Key',
  },

  /* ---------- 本地部署 ---------- */
  {
    id: 'ollama', label: 'Ollama（本地）', group: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
    keyUrl: 'https://ollama.com/download',
  },
  {
    id: 'lmstudio', label: 'LM Studio（本地）', group: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    keyUrl: 'https://lmstudio.ai/',
  },
  {
    id: 'vllm', label: 'vLLM / 其它本地服务', group: 'local',
    baseUrl: 'http://127.0.0.1:8000/v1',
    models: ['local-model'],
  },

  /* ---------- 自定义 ---------- */
  { id: 'custom', label: '自定义（任意兼容接口）', group: 'custom', baseUrl: '', models: [] },
];

/** 分组显示名（界面下拉用） */
export const PRESET_GROUPS = [
  { id: 'cn', label: '国内直连（不需要代理）' },
  { id: 'aggregator', label: '聚合平台（一个 Key 用多家模型）' },
  { id: 'global', label: '海外厂商（国内需要代理）' },
  { id: 'local', label: '本地部署' },
  { id: 'custom', label: '其它' },
];

/* ============================ 网络代理 ============================ */
/**
 * ★ Node.js 的 fetch **不会**自动使用 Windows 的"系统代理"设置（浏览器会，Node 不会），
 *   所以走 Clash / v2rayN 这类客户端的用户，必须在这里显式填代理地址，
 *   否则请求会直接裸连目标 IP —— 访问 Google / OpenAI 这类站点就会连接超时。
 *
 * 只支持 http(s) 代理（undici 的 ProxyAgent 不支持 socks5）。
 * Clash 默认混合端口就是 7890，v2rayN 的 HTTP 端口一般是 10809。
 */
let proxyAgent = null;
let proxyUrl = '';

export function setProxy(url) {
  const next = String(url || '').trim();
  if (next === proxyUrl) return { ok: true, changed: false, proxy: proxyUrl };
  if (!next) {
    proxyAgent = null;
    proxyUrl = '';
    return { ok: true, changed: true, proxy: '' };
  }
  if (/^socks/i.test(next)) {
    throw new Error('不支持 socks5 代理，请填你代理客户端里的 HTTP 端口（例如 Clash 是 http://127.0.0.1:7890）');
  }
  if (!/^https?:\/\//i.test(next)) {
    throw new Error('代理地址要以 http:// 或 https:// 开头，例如 http://127.0.0.1:7890');
  }
  const agent = new ProxyAgent(next);
  proxyAgent = agent;
  proxyUrl = next;
  return { ok: true, changed: true, proxy: proxyUrl };
}

export const getProxy = () => proxyUrl;
export const hasProxy = () => !!proxyAgent;

/** 给 fetch 加上代理 dispatcher（没配代理就是原样调用） */
function withProxy(init = {}) {
  return proxyAgent ? { ...init, dispatcher: proxyAgent } : init;
}

/* ============================ 代理端口自动检测 ============================ */
/**
 * 各家代理客户端的默认端口都不一样，用户很难猜：
 *   Clash Verge / Verge Rev → 7897   Clash for Windows → 7890   v2rayN → 10809
 *   Clash 混合端口旧版 → 7890        Surge → 6152/6153          Mihomo 默认 → 7890
 * 这里扫一遍本机常见端口，并用真实请求验证它是不是"能用的 HTTP 代理"。
 */
export const PROXY_PORT_CANDIDATES = [7897, 7890, 7891, 7898, 7899, 10809, 10808, 1080, 1081, 8889, 2080, 20171, 20172, 8118, 8080, 33210, 4780, 9909, 7078, 6152, 6153];

function tcpProbe(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function tryThroughProxy(url, target, timeoutMs) {
  const agent = new ProxyAgent(url);
  const t0 = Date.now();
  try {
    const res = await fetch(target, { dispatcher: agent, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 90) };
  } finally {
    try { await agent.close(); } catch { /* 忽略 */ }
  }
}

/** 检测本机哪些端口是可用代理。返回按"能用且能上 Google"排序的候选列表 */
export async function detectProxy({ timeoutMs = 6000 } = {}) {
  const openPorts = [];
  await Promise.all(PROXY_PORT_CANDIDATES.map(async (port) => {
    if (await tcpProbe('127.0.0.1', port)) openPorts.push(port);
  }));
  openPorts.sort((a, b) => a - b);

  const candidates = [];
  for (const port of openPorts) {
    const url = `http://127.0.0.1:${port}`;
    // 先看能不能连上 Google（Gemini / OpenAI 必需的），不行再看能不能连国内服务
    const google = await tryThroughProxy(url, 'https://www.gstatic.com/generate_204', timeoutMs);
    const domestic = google.ok ? { ok: true, skipped: true } : await tryThroughProxy(url, 'https://api.deepseek.com/v1/models', timeoutMs);
    candidates.push({
      url,
      port,
      ok: google.ok || domestic.ok,
      google: google.ok,
      domestic: !!domestic.ok,
      ms: google.ms || domestic.ms || 0,
      detail: google.ok ? `可访问 Google（HTTP ${google.status}，${google.ms}ms）`
        : domestic.ok ? '能连国内服务，但连不上 Google（节点可能不通）'
        : (google.error || domestic.error || '端口开着，但不像 HTTP 代理'),
    });
  }
  const working = candidates.filter((c) => c.ok).sort((a, b) => Number(b.google) - Number(a.google) || a.ms - b.ms);
  return { scanned: PROXY_PORT_CANDIDATES.length, open: openPorts, candidates, best: working[0]?.url || '' };
}

export class AbortError extends Error {
  constructor(message = '已停止') {
    super(message);
    this.name = 'AbortError';
  }
}

export function chatCompletionsUrl(baseUrl) {
  let url = normalizeBase(baseUrl);
  if (/\/chat\/completions$/i.test(url)) return url;
  return `${url}/chat/completions`;
}

function normalizeBase(baseUrl) {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('缺少 Base URL');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** 模型列表接口地址（从 Base URL 推导） */
export function modelsUrl(baseUrl) {
  let url = normalizeBase(baseUrl);
  url = url.replace(/\/chat\/completions$/i, '');
  return `${url}/models`;
}

/**
 * 拉取该厂商账号下可用的模型列表（OpenAI 兼容的 GET /models）。
 * 返回 [{ id, ownedBy, created }]，按接口返回顺序去重。
 */
export async function listModels({ baseUrl, apiKey, signal, timeoutMs = 30000 } = {}) {
  const primary = modelsUrl(baseUrl);
  const candidates = [primary];
  // 有些平台 Base URL 填的是域名根（没有 /v1），补一次 /v1/models 兜底
  if (!/\/v\d+\/models$/i.test(primary)) {
    candidates.push(primary.replace(/\/models$/, '/v1/models'));
  }

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    const isLast = i === candidates.length - 1;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await fetch(url, withProxy({
        method: 'GET',
        headers: apiKey
          ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
          : { Accept: 'application/json' },
        signal: controller.signal,
      }));

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 600); } catch {}
        if (res.status === 404 && !isLast) {
          lastError = new Error('HTTP 404');
          continue;
        }
        if (res.status === 404) {
          throw new Error('这个服务商不支持「获取模型列表」（HTTP 404）—— 直接在「模型名」框里手输模型名即可。');
        }
        throw new Error(friendlyApiError(res.status, detail));
      }

      const data = await res.json();
      const raw = Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : Array.isArray(data?.result) ? data.result
        : [];

      const seen = new Set();
      const models = [];
      for (const item of raw) {
        const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
        if (!id || typeof id !== 'string' || seen.has(id)) continue;
        seen.add(id);
        const ownedBy = typeof item === 'object' ? item?.owned_by || item?.ownedBy || '' : '';
        models.push({ id, ownedBy: String(ownedBy || '') });
      }
      if (models.length) return models;
      lastError = new Error('接口返回里没有模型（返回格式可能不兼容）');
    } catch (err) {
      const message = String(err?.message || err);
      lastError = /abort|timeout/i.test(message) && !/HTTP \d/.test(message)
        ? new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
        : new Error(message.startsWith('HTTP ') ? message : friendlyNetworkError(err));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError || new Error('获取模型列表失败');
}

function friendlyNetworkError(err) {
  const cause = err && err.cause;
  const code = (cause && cause.code) || (err && err.code) || '';
  const msg = String((cause && cause.message) || (err && err.message) || err || '');
  // 连不上时，如果没配代理，大概率就是"系统代理 Node 不走"这件事
  const proxyHint = proxyUrl
    ? `当前已启用代理 ${proxyUrl}，请确认它确实在运行`
    : '如果你在用 VPN / 代理，请在「设置 → 网络代理」里填上代理地址 —— Node.js 不会自动使用 Windows 的系统代理，浏览器能打开不代表这里能通';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|ENOTFOUND/i.test(msg)) {
    return `无法解析接口域名，请检查 Base URL 是否正确（${msg}）`;
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    if (/127\.0\.0\.1|localhost/.test(msg) && proxyUrl) return `代理 ${proxyUrl} 连不上，请确认代理软件在运行（${msg}）`;
    return `连接被拒绝，接口地址不通或本地模型服务没启动（${msg}）`;
  }
  if (code === 'ECONNRESET' || /socket hang up|ECONNRESET/i.test(msg)) {
    return `连接被对方重置，稍后重试或检查代理（${msg}）`;
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout|timed out/i.test(msg)) {
    return `连接超时：网络不通或接口响应太慢。${proxyHint}（${msg}）`;
  }
  if (/bad port/i.test(msg)) return `接口地址的端口不合法（${msg}）`;
  if (/certificate|self.signed|SSL|TLS/i.test(msg)) return `HTTPS 证书校验失败（${msg}）`;
  if (/aborted|abort/i.test(msg)) return '请求已中止';
  if (/fetch failed/i.test(msg)) return `网络请求失败，无法连接到接口地址（${code || msg}）。${proxyHint}`;
  return msg || '未知网络错误';
}

/**
 * 把服务商返回的错误翻成人话。
 * 经验：同样是"连上了但被拒"，各家措辞差别很大，用户很难判断到底错在哪：
 *   xAI：    400 Incorrect API key provided  /  401 No credentials presented.
 *   OpenAI： 401 Incorrect API key provided
 *   智谱：   401 令牌验证失败
 */
export function friendlyApiError(status, raw) {
  const text = (() => {
    const s = String(raw == null ? '' : raw);
    try {
      const j = JSON.parse(s);
      const m = j?.error?.message || j?.error || j?.message || j?.msg || '';
      const out = typeof m === 'string' && m ? m : (m ? JSON.stringify(m) : s);
      return String(out).replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch {
      return s.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  })();
  const t = text.toLowerCase();
  const rules = [
    [/no credentials presented|no credentials|missing.*(api.?key|credential)|api key.*required/, '没有带上 API Key —— 检查「API Key」输入框是不是空的'],
    [/bad credentials/, 'API Key 是空的或格式不对'],
    [/incorrect api key|invalid api key|invalid_api_key|api key.*(invalid|incorrect)|invalid token|令牌验证失败|认证失败|unauthorized|authentication.*fail/, 'API Key 不正确'],
    [/insufficient|quota|credit|balance|余额|额度|欠费|arrears/, '账户余额 / 额度不足，请到服务商后台充值'],
    [/model.*(not exist|not found|does not exist|unknown model|invalid model)|no such model|无此模型|模型不存在/, '模型名不存在'],
    [/rate limit|too many requests|请求过于频繁|限流/, '请求太频繁（触发限流），稍后再试'],
    [/content.*(policy|filter|moderation)|safety|风控/, '内容被服务商的安全策略拦截了'],
    [/context length|too long|maximum context|max.*token.*exceed/, '上下文超出模型长度限制（把「上下文条数」调小试试）'],
    [/max_tokens|max_completion_tokens/, '这个模型的 token 参数名不对'],
  ];
  for (const [re, hint] of rules) {
    if (re.test(t)) return `${hint}。服务商原话：${text.slice(0, 200)}`;
  }
  const byStatus = {
    400: '请求被服务商拒绝（参数或模型名有问题）',
    401: 'API Key 无效或未授权',
    402: '账户余额不足',
    403: '没有权限（Key 未开通该模型，或账号未实名）',
    404: '接口地址不对（检查 Base URL 是否要带 /v1）',
    429: '触发限流或余额不足',
    500: '服务商内部错误，稍后重试',
    502: '服务商网关错误，稍后重试',
    503: '服务商暂时不可用，稍后重试',
  };
  return `${byStatus[status] || `HTTP ${status}`}。服务商原话：${text.slice(0, 200)}`;
}

function buildHeaders(apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildPayload(opts, stream) {
  const {
    model,
    messages,
    temperature = 0.8,
    maxTokens = 1024,
  } = opts;
  if (!model) throw new Error('缺少模型名（model）');
  const payload = { model, messages, stream };
  if (typeof temperature === 'number' && temperature >= 0) payload.temperature = temperature;
  if (typeof maxTokens === 'number' && maxTokens > 0) payload.max_tokens = Math.min(maxTokens, 32000);
  return payload;
}

/* ============================ 模型参数自动适配 ============================ */
/**
 * 有些模型对请求参数有硬性限制，用户填了正常值也会被 400 拒绝：
 *   · Kimi K2 系列：`invalid temperature: only 1 is allowed for this model`
 *   · OpenAI o1/o3/o4、gpt-5 等推理模型：只允许 temperature=1，甚至完全不允许该字段，
 *     且要写 `max_completion_tokens` 而不是 `max_tokens`
 * 这里做一次自动降级重试，并把生效的参数记住（同一个 baseUrl+model 后续直接照做）。
 */
const paramFixes = new Map();
const fixKey = (baseUrl, model) => `${baseUrl || ''}|${model || ''}`;

function applyFix(payload, fix) {
  if (!fix) return payload;
  if (fix.temperature === 'omit') delete payload.temperature;
  else if (typeof fix.temperature === 'number') payload.temperature = fix.temperature;
  if (fix.maxTokensKey && payload.max_tokens !== undefined) {
    payload[fix.maxTokensKey] = payload.max_tokens;
    delete payload.max_tokens;
  }
  return payload;
}

/** 400 且是参数问题 → 依次换参数重试；不是参数问题就原样返回让上层报错 */
async function postWithAutoFix({ url, apiKey, opts, stream, signal }) {
  const key = fixKey(opts.baseUrl, opts.model);
  const sequence = [];
  if (paramFixes.has(key)) sequence.push(paramFixes.get(key));
  for (const cand of [{}, { temperature: 1 }, { temperature: 'omit' }, { maxTokensKey: 'max_completion_tokens' }, { temperature: 1, maxTokensKey: 'max_completion_tokens' }]) {
    if (!sequence.some((x) => JSON.stringify(x) === JSON.stringify(cand))) sequence.push(cand);
  }
  let res = null;
  let detail = '';
  let usedFix = null;
  for (const fix of sequence) {
    const payload = applyFix(buildPayload(opts, stream), fix);
    res = await fetch(url, withProxy({
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(payload),
      signal,
    }));
    if (res.ok) {
      if (fix && Object.keys(fix).length) {
        paramFixes.set(key, fix);
        console.log(`[openai] ${opts.model} 需要特殊参数，已自动适配：${JSON.stringify(fix)}`);
      }
      usedFix = fix;
      return { res, fix: usedFix, detail: '' };
    }
    if (res.status !== 400) return { res, fix, detail: '' }; // 其它错误交回上层（401/404/429…）
    try { detail = (await res.clone().text()).slice(0, 600); } catch { detail = ''; }
    const isParamIssue = /temperature|max_tokens|max_completion_tokens|unsupported|invalid_?request|只允许|不支持/i.test(detail);
    if (!isParamIssue) break; // 不是参数问题（比如模型名写错），别瞎试
  }
  return { res, fix: usedFix, detail };
}

async function postJson(opts, stream) {
  const { baseUrl, apiKey, signal, timeoutMs = 180000 } = opts;
  const url = chatCompletionsUrl(baseUrl);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）`)), timeoutMs);

  let res;
  let fixNote = '';
  try {
    const attempt = await postWithAutoFix({ url, apiKey, opts, stream, signal: controller.signal });
    res = attempt.res;
    if (attempt.fix && Object.keys(attempt.fix).length) {
      fixNote = attempt.fix.temperature === 'omit'
        ? '（该模型不接受 temperature，已自动省略）'
        : `（该模型要求 temperature=${attempt.fix.temperature}${attempt.fix.maxTokensKey ? ' + max_completion_tokens' : ''}，已自动适配）`;
      // 把适配结果挂回调用方，界面上可以提示一句
      opts.onParamFix?.(attempt.fix, fixNote);
    }
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw new AbortError();
    throw new Error(friendlyNetworkError(err));
  }

  if (!res.ok) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 600);
    } catch {}
    // ★ 参数类错误先说清楚（这两个程序会自动重试，所以要解释一下）
    if (res.status === 400 && /temperature/i.test(detail)) {
      throw new Error(
        `这个模型对「温度」有硬性要求（Kimi K2 系列、OpenAI o 系列等只允许 temperature=1）。` +
        `程序已经自动尝试过 temperature=1 和省略该参数，仍然被拒绝。服务商原话：${detail.slice(0, 200)}`
      );
    }
    if (res.status === 400 && /max_tokens|max_completion_tokens/i.test(detail)) {
      throw new Error(`这个模型不接受 max_tokens（推理模型要用 max_completion_tokens），程序已自动重试仍未通过。服务商原话：${detail.slice(0, 200)}`);
    }
    throw new Error(friendlyApiError(res.status, detail));
  }
  void fixNote;

  return {
    res,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 流式对话：逐步 yield { type: 'content' | 'reasoning', text } */
export async function* streamChat(opts) {
  const { res, cleanup } = await postJson(opts, true);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return null;
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return { done: true };
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
    if (json.error) {
      throw new Error(`接口返回错误：${json.error.message || JSON.stringify(json.error)}`);
    }
    const delta = json.choices?.[0]?.delta || json.choices?.[0]?.message || {};
    const out = [];
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      out.push({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content) {
      out.push({ type: 'content', text: delta.content });
    }
    return out.length ? { chunks: out } : null;
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const result = handleLine(line);
        if (result?.done) {
          finished = true;
          break;
        }
        if (result?.chunks) for (const chunk of result.chunks) yield chunk;
      }
    }
    if (!finished && buffer.trim()) {
      const result = handleLine(buffer);
      if (result?.chunks) for (const chunk of result.chunks) yield chunk;
    }
  } catch (err) {
    if (opts.signal?.aborted) throw new AbortError();
    throw new Error(friendlyNetworkError(err));
  } finally {
    cleanup();
    try {
      await reader.cancel();
    } catch {}
  }
}

/** 一次性（非流式）对话，用于连接测试和主持人决策 */
export async function chatOnce(opts) {
  const { res, cleanup } = await postJson(opts, false);
  try {
    const json = await res.json();
    if (json.error) throw new Error(`接口返回错误：${json.error.message || JSON.stringify(json.error)}`);
    const choice = json.choices?.[0] || {};
    return {
      content: choice.message?.content || '',
      reasoning: choice.message?.reasoning_content || '',
      usage: json.usage || null,
      model: json.model || opts.model,
    };
  } catch (err) {
    if (opts.signal?.aborted) throw new AbortError();
    if (err instanceof SyntaxError) throw new Error('接口返回的不是合法 JSON，可能不是 OpenAI 兼容接口');
    throw err;
  } finally {
    cleanup();
  }
}
