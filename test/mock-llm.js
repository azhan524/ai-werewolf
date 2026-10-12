/**
 * 假模型服务（测试用）：不联网，扮演一局狼人杀。
 *
 * 两个作用：
 *  1. 让整局游戏能在没有任何真实 API Key 的情况下跑完；
 *  2. ★ 每条发言末尾都会附上「〔可见频道：…〕」—— 这是它**从收到的 prompt 里解析出来**的，
 *     于是"待会儿那个平民到底有没有看到狼人频道"就变成了一条可以断言的硬证据。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8801);
const CHANNEL_NAMES = ['公共频道', '狼人频道', '预言家频道', '女巫频道', '守卫频道'];
/** 注意：假模型刻意做成**无状态**的（只按座位号推导），这样反复跑测试也不会互相影响 */
/** 例外：EMPTY_ONCE_xxx 标记要记数（第一次给空正文、第二次给正文），标记由测试随机生成 */
const EMPTY_ONCE_SEEN = new Map();

function parsePrompt(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const me = sys.match(/你是 (\d+) 号玩家「(.+?)」，身份是【(.+?)】/);

  const rosterLine = (sys.match(/【本局玩家】([^\n]+)/) || [])[1] || '';
  const players = [];
  for (const part of rosterLine.split('、')) {
    const m = part.match(/(\d+)\s*号\s*([^（]*)/);
    if (m) players.push({ number: Number(m[1]), name: m[2].trim(), alive: !part.includes('已出局') });
  }

  const mateLine = (sys.match(/【你的狼队友】([^\n]+)/) || [])[1] || '';
  const mates = [...mateLine.matchAll(/(\d+)\s*号/g)].map((m) => Number(m[1]));

  // 只从"历史记录"那一段里找频道名，避免把任务描述里的频道名也算进来
  const histStart = user.indexOf('【你可视频道的历史记录');
  const taskStart = user.indexOf('【当前任务】');
  const hist = user.slice(histStart >= 0 ? histStart : 0, taskStart >= 0 ? taskStart : user.length);
  const task = taskStart >= 0 ? user.slice(taskStart) : user;

  // ★ 只从"转录里的频道标题行"（—— 🏛 公共频道 ——）解析可见频道。
  //   不能全文搜频道名：别的玩家发言正文里提到"狼人频道"四个字会污染判断。
  const headerRe = /——\s*\S+\s+([^\s—]+)\s*——/g;
  const seen = new Set();
  let hm;
  while ((hm = headerRe.exec(hist)) !== null) seen.add(hm[1]);
  const channels = CHANNEL_NAMES.filter((n) => seen.has(n));

  return {
    number: me ? Number(me[1]) : 0,
    name: me ? me[2] : '?',
    role: me ? me[3] : '?',
    players,
    mates,
    channels,
    hist,
    task,
    system: sys,
  };
}

function pickTarget(p, { excludeMates = false } = {}) {
  const alive = p.players.filter((x) => x.alive && x.number !== p.number);
  const pool = excludeMates ? alive.filter((x) => !p.mates.includes(x.number)) : alive;
  const list = (pool.length ? pool : alive).slice().sort((a, b) => a.number - b.number);
  return list.length ? list[0].number : 0;
}

function buildReply(messages) {
  const p = parsePrompt(messages);
  const visible = `〔可见频道：${p.channels.join('、') || '无'}〕`;
  const other = pickTarget(p);
  const task = p.task;

  // 白狼王自爆（任务里含"白狼王"，必须排在普通"自爆"之前）
  if (task.includes('白狼王')) {
    const target = pickTarget(p, { excludeMates: /狼/.test(p.role) });
    return `我自爆，带走 ${target} 号。自爆 带走 ${target}号。${visible}`;
  }
  // 普通狼人自爆询问（偶数号愿意自爆，方便测试两条分支）
  if (task.includes('自爆')) {
    if (p.number % 2 === 0) return `我是 ${p.number} 号，我自爆！${visible}`;
    return `我是 ${p.number} 号，现在还不是自爆的时候。${visible}`;
  }
  // 猎人 / 狼王开枪
  if (task.includes('开枪')) {
    const target = pickTarget(p, { excludeMates: /狼/.test(p.role) });
    return `我带 ${target} 号一起走。带走 ${target}号。${visible}`;
  }
  // 遗言（死后公开发言）
  if (task.includes('留遗言')) {
    const target = pickTarget(p);
    return `我是 ${p.number} 号。我的遗言：${target} 号的表现很可疑，好人跟我一起投他。${visible}`;
  }
  // 警徽移交
  if (task.includes('警徽')) {
    const target = pickTarget(p);
    return `警徽给 ${target} 号，我相信他能带队。${visible}`;
  }
  // 放逐投票：PK 申辩
  if (task.includes('放逐PK')) {
    return `我是 ${p.number} 号，我不该被投出去，${other} 号比我更像狼。${visible}`;
  }
  // 放逐投票：PK 重投（偶数号投号小的、奇数号投号大的 → 平票 → 平安日）
  if (task.includes('放逐重投')) {
    const cands = [...new Set([...task.matchAll(/(\d+)\s*号/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    const target = cands.length ? cands[p.number % 2 === 0 ? 0 : cands.length - 1] : other;
    return `我投 ${target} 号。投票：${target}号。${visible}`;
  }
  // 警长竞选 PK 发言
  if (task.includes('警长PK')) {
    return `我是 ${p.number} 号，我坚持上警，我的判断比对手更稳，请把警徽给我。${visible}`;
  }
  // 警长竞选 PK 重投（取号最大的平票者）
  if (task.includes('警长重投')) {
    const cands = [...new Set([...task.matchAll(/(\d+)\s*号/g)].map((m) => Number(m[1])))];
    const target = cands.length ? Math.max(...cands) : 0;
    return `我投 ${target} 号。投 ${target}号。${visible}`;
  }  // 警长归票（投票前的总结发言）
  if (task.includes('归票')) {
    const target = pickTarget(p);
    return `我是警长，今天的情况我总结一下。我的归票是 ${target} 号，请大家跟我投。归票：${target}号。${visible}`;
  }
  // 警长竞选投票（必须排在普通"投票"之前判断）
  // 偶数号投第一位候选人、奇数号投第二位 → 警下人数为偶数时必然 3:3/4:4 平票，稳定复现 PK
  if (task.includes('警长竞选投票')) {
    const cands = [...new Set([...task.matchAll(/(\d+)\s*号/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    const target = cands.length ? cands[p.number % 2 === 0 ? 0 : Math.min(1, cands.length - 1)] : 0;
    return `我支持 ${target} 号当警长。投 ${target}号。${visible}`;
  }
  // 警长指定发言顺序
  if (task.includes('发言顺序')) {
    const first = p.players.filter((x) => x.alive).sort((a, b) => a.number - b.number)[0];
    return `今天从 ${first ? first.number : 1} 号开始发言。从 ${first ? first.number : 1}号 开始。${visible}`;
  }
  // 守卫守人
  if (task.includes('守 X号')) {
    const lastGuard = (p.system.match(/上一晚你守的是：(\d+)\s*号/) || [])[1];
    const pool = p.players.filter((x) => x.alive && x.number !== p.number && String(x.number) !== lastGuard);
    const list = (pool.length ? pool : p.players.filter((x) => x.alive && x.number !== p.number)).sort((a, b) => a.number - b.number);
    const target = list.length ? list[0].number : 0;
    return `我守 ${target} 号，他今晚可能有危险。守 ${target}号。${visible}`;
  }
  // 上警表态：座位号是 3 的倍数就上警（固定 4 位候选人、警下人数为偶数 → 稳定平票）
  if (task.includes('警长竞选')) {
    if (p.number % 3 === 0) return `我要上警，我对局势有判断，愿意带队。${visible}`;
    return `我不上警，我更适合在下面投票。${visible}`;
  }
  // 投票（测试可以用 "投票给X号" 强制指定，便于构造确定性的局面）
  if (task.includes('投票')) {
    const forced = (task.match(/投票给\s*(\d+)\s*号/) || [])[1];
    const target = forced ? Number(forced) : other;
    return `我投 ${target} 号，他刚才的发言最不像好人。投票：${target}号。${visible}`;
  }
  // 狼人刀人
  if (task.includes('刀 X号')) {
    const target = pickTarget(p, { excludeMates: true });
    return `今晚先刀 ${target} 号吧，他白天话太多。刀 ${target}号。${visible}`;
  }
  // 预言家验人
  if (task.includes('验 X号')) {
    return `我先查验 ${other} 号。验 ${other}号。${visible}`;
  }
  // 女巫
  if (task.includes('解药')) {
    const lastAntidoteLine = p.hist
      .split('\n')
      .filter((l) => l.includes('解药'))
      .slice(-1)[0] || '';
    const attacked = /被狼人袭击/.test(lastAntidoteLine);
    if (attacked && lastAntidoteLine.includes('还在')) {
      return `我用解药救他。不用毒药。${visible}`;
    }
    return `不用解药。毒 ${other}号。${visible}`;
  }
  // 白天公开发言
  return `我是 ${p.number} 号，我觉得 ${other} 号的发言有点飘，先听听 ${other} 号怎么解释。${visible}`;
}

const MODEL_LIST = [
  { id: 'werewolf-mock', object: 'model', owned_by: 'mock-lab' },
  { id: 'werewolf-mock-mini', object: 'model', owned_by: 'mock-lab' },
  { id: 'werewolf-mock-pro', object: 'model', owned_by: 'mock-lab' },
];
function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    return sendJson(res, 200, { object: 'list', data: MODEL_LIST });
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    return sendJson(res, 404, { error: { message: 'not found' } });
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'bad json' } }); }
    // 专门用来测"余额不足"提示的模型名
    if (body.model === 'mock-no-balance') {
      return sendJson(res, 402, { error: { message: 'Insufficient Balance' } });
    }
    // 专门用来测"模型只允许 temperature=1"的自动适配（Kimi K2 / OpenAI o 系列就是这样）
    if (body.model === 'mock-strict-temp' && body.temperature !== 1) {
      return sendJson(res, 400, { error: { message: 'invalid temperature: only 1 is allowed for this model', type: 'invalid_request_error' } });
    }
    // ★ 专门用来测"模型只输出思考、正文为空"（deepseek-v4-pro / kimi-k3 / glm-4.7 这类）：
    //   任务里带 EMPTY_ONCE_xxx 时，同一个标记的**第一次**调用只吐 reasoning_content，
    //   第二次才正常给正文 —— 于是"程序有没有自动重试"就成了一条可断言的硬证据。
    //   用随机标记（每次跑 e2e 都不同），所以这个 Map 不需要清理也不会互相影响。
    const userText = String((body.messages || []).find((m) => m.role === 'user')?.content || '');
    const magic = (userText.match(/EMPTY_ONCE_[A-Za-z0-9_]+/) || [])[0];
    if (magic) {
      const seen = (EMPTY_ONCE_SEEN.get(magic) || 0) + 1;
      EMPTY_ONCE_SEEN.set(magic, seen);
      if (seen === 1) {
        const thinking = '（假模型：第一次只输出思考）我先想想该说什么……还没想完。';
        if (!body.stream) {
          return sendJson(res, 200, {
            id: 'mock', model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: thinking }, finish_reason: 'length' }],
            usage: { prompt_tokens: 30, completion_tokens: 400, total_tokens: 430 },
          });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        const sendOnly = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        sendOnly({ id: 'mock', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' } }] });
        sendOnly({ id: 'mock', model: body.model, choices: [{ index: 0, delta: { reasoning_content: thinking } }] });
        sendOnly({ id: 'mock', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
    }
    const reply = buildReply(body.messages || []);

    if (!body.stream) {
      return sendJson(res, 200, {
        id: 'mock', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 },
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // 模型名里带 slow 就慢慢吐字：用来复现"发言还没说完就被开新局打断"这类竞态
    const chunkDelay = /slow/i.test(body.model) ? 300 : 6;
    send({ id: 'mock', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    for (const piece of reply.match(/[\s\S]{1,10}/g) || ['']) {
      await new Promise((r) => setTimeout(r, chunkDelay));
      send({ id: 'mock', model: body.model, choices: [{ index: 0, delta: { content: piece } }] });
    }
    send({ id: 'mock', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`🐺 假模型服务已启动：http://127.0.0.1:${PORT}/v1`));
