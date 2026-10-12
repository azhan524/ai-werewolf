/**
 * AI 狼人杀 —— 本地服务
 * 人类是主持人：只点按钮 / 发指令推进流程，不参与游戏。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, uid, publicAgent, publicSeat, publicMessage } from './lib/store.js';
import { Orchestrator } from './lib/orchestrator.js';
import { CHANNELS, ROLES, allowedChannels, checkIsolation, parseIntent, saysNo, AI_LEVELS, resolveGeneration, DEFAULT_AI_LEVEL } from './lib/channels.js';
import * as Game from './lib/game.js';
import { PRESETS, PRESET_GROUPS, listModels, setProxy as setOpenAIProxy, getProxy, hasProxy, detectProxy } from './lib/openai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data', 'db.json');
const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || '127.0.0.1';

const store = new Store(DATA_FILE);

/* ==================== 首次启动：把 4 个固定频道补上（只补一次，之后永不重建） ==================== */
store.ensureChannels();

/* 首次启动给一副座位（标准 12 人局，暂不绑定 AI，等主持人来配） */
if (!store.seats.length) {
  Game.setupSeats(store, { rolePlan: Game.DEFAULT_ROLE_PLAN, agentIds: [] });
}

/* ==================== SSE 广播 ==================== */
const sseClients = new Set();

function emit(event) {
  const payload = JSON.stringify({ ...event, at: Date.now() });
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

const orchestrator = new Orchestrator({ store, emit });

/* ==================== 工具 ==================== */
const AVATARS = ['🐳', '🦊', '🐼', '🦉', '🐙', '🦄', '🐧', '🐯', '🐨', '🦁', '🐸', '🐵'];
const COLORS = ['#4f8ef7', '#e6739f', '#f2994a', '#27ae60', '#9b51e0', '#00b4d8'];

function agentsById() {
  return new Map(store.agents.map((a) => [a.id, a]));
}

/** 座位序列化（带上"是不是警长"这类对局信息） */
function seatsPayload() {
  return store.seats.map((s) => publicSeat(s, agentsById(), store.game));
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const sendError = (res, status, message) => sendJson(res, status, { error: message });

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function normalizeAgent(body, existing = null) {
  const trim = (v) => String(v ?? '').trim();
  const agent = {
    name: trim(body.name) || existing?.name || 'AI 玩家',
    avatar: trim(body.avatar) || existing?.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)],
    color: trim(body.color) || existing?.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    preset: trim(body.preset) || existing?.preset || 'custom',
    baseUrl: trim(body.baseUrl) || existing?.baseUrl || '',
    model: trim(body.model) || existing?.model || '',
    systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : existing?.systemPrompt || '',
    // ★ 默认「跟随智力总控」；勾掉之后这个成员才用自己的温度 / tokens
    followLevel: typeof body.followLevel === 'boolean' ? body.followLevel : existing?.followLevel !== false,
    temperature: Number.isFinite(Number(body.temperature)) ? Math.max(0, Math.min(2, Number(body.temperature))) : existing?.temperature ?? 0.85,
    maxTokens: Number.isFinite(Number(body.maxTokens)) ? Math.max(16, Math.min(32000, Number(body.maxTokens))) : existing?.maxTokens ?? 400,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing?.enabled !== false,
  };
  if (body.clearKey === true) agent.apiKey = '';
  else if (typeof body.apiKey === 'string' && body.apiKey.trim()) agent.apiKey = body.apiKey.trim();
  else agent.apiKey = existing?.apiKey || '';

  if (!agent.baseUrl) throw new Error('请填写 Base URL');
  if (!agent.model) throw new Error('请填写模型名（model）');
  return agent;
}

/**
 * 从最近的消息里找出"代理连不上"的错误（openai.js 的 friendlyNetworkError 会写成
 * 「代理 http://… 连不上，请确认代理软件在运行」）。返回一句给主持人看的话。
 */
function recentProxyError(channels) {
  // 只看"最近一次 AI 调用"：它失败了才提示；修好之后下一条成功消息就会把横幅收掉
  const ai = channels.flatMap((c) => c.messages || []).filter((m) => m.role === 'ai');
  if (!ai.length) return null;
  ai.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const err = ai[0].meta?.error;
  if (!err || !/代理\s*https?:\/\/\S+\s*连不上/.test(err)) return null;
  const url = err.match(/代理\s*(https?:\/\/\S+?)\s*连不上/);
  return `网络代理 ${url ? url[1] : ''} 连不上（代理软件没在运行？）`;
}

/**
 * 全量状态。
 * view=audience 时只返回公共频道、并且不返回任何身份信息（真正的观众视角）。
 */
function statePayload({ view = 'host' } = {}) {
  const byId = agentsById();
  const audience = view === 'audience';
  const channels = store.channels
    .filter((c) => !audience || c.id === 'lobby')
    .map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      desc: c.desc,
      messageCount: (c.messages || []).length,
      messages: (c.messages || []).map((m) => publicMessage(m, { showRoles: !audience })),
    }));

  return {
    buildId: process.env.BUILD_ID || 'dev',
    view,
    settings: store.settings,
    agents: store.agents.map(publicAgent),
    channels,
    channelMeta: CHANNELS.map((c) => ({
      ...c,
      /** 哪些身份能看到这个频道（主持人永远能看到全部） */
      visibleTo: Object.values(ROLES).filter((r) => (r.channels || []).includes(c.id)).map((r) => r.id),
    })),
    seats: store.seats.map((s) => {
      const pub = publicSeat(s, byId, store.game);
      if (audience) return { number: pub.number, name: pub.name, avatar: pub.avatar, alive: pub.alive };
      return pub;
    }),
    roles: ROLES,
    rolePresets: Game.ROLE_PRESETS,
    presets: PRESETS,
    presetGroups: PRESET_GROUPS,
    /** ★ 智力总控：档位表 + 当前档位（界面用它画 普通/聪明/智能） */
    aiLevels: Object.values(AI_LEVELS),
    aiLevel: store.settings.aiLevel || DEFAULT_AI_LEVEL,
    dataFile: DATA_FILE,
    /** ★ 网络代理状态（Node 不会自动使用系统代理，界面用它提示用户） */
    proxy: getProxy(),
    proxyActive: hasProxy(),
    /**
     * ★ 代理配了但连不上时给主持人的一句人话。
     *   真实踩过：设置里留着 http://127.0.0.1:7897 但代理软件没启动，
     *   于是每一次 AI 调用都失败、整局只剩空发言 —— 光看聊天区很难定位，
     *   所以直接从最近的错误里认出来，在顶部挂一条横幅。
     */
    proxyWarning: audience ? null : recentProxyError(channels),
    situation: Game.situation(store.data),
    /** ★ 发言队列：谁说过、现在轮到谁、谁还在等（界面用它显示发言顺序） */
    queue: Game.speakQueue(store),
    /** ★ 警长与遗言相关状态 */
    sheriff: (() => {
      const s = Game.getSheriff(store.data);
      return s ? { seatId: s.id, number: s.number, name: s.name, alive: !!s.alive } : null;
    })(),
    pendingLastWords: (store.game.pendingLastWords || []).map((x) => ({ seatNumber: x.seatNumber, name: x.name, reason: x.reason })),
    pendingBadge: store.game.pendingBadge || null,
    dayStep: store.game.dayStep || null,
    game: store.game,
    running: orchestrator.runningInfo(),
  };
}

/* ==================== 各种任务的指令文案 ==================== */
function taskForLastWords(seat, entry) {
  const roleName = ROLES[seat.role]?.name || seat.role;
  return [
    `你（${seat.number}号，身份【${roleName}】）因为「${entry.reason}」出局了，现在轮到你留遗言。`,
    `遗言是公开发言，所有人都能听到。请说 1~3 句：可以表明或跳自己的身份、给出你的推理、点出你怀疑谁、提醒同伴。`,
    `如果你有技能或身份牌要交代（猎人/狼王/白痴/警长），可以在这里说明，但不要编造你做不到的事。`,
  ].join('\n');
}

function taskForBadge(seat) {
  return [
    `你是本局警长（${seat.number}号 ${seat.name}），刚刚出局了。`,
    `请处理警徽：说「警徽给 X号」把它移交给一位存活玩家，或者说「撕警徽」让本局不再有警长。`,
    `只需要一句话。`,
  ].join('\n');
}

function taskForCampaign(seat) {
  return [
    `现在是第 1 天的警长竞选环节（本局 #${store.game.gameNo}），轮到你在公共频道表态。`,
    `想竞选就说「我要上警」并简单说一句理由；不想竞选就说「我不上警」并说一句原因。`,
    `如果你已经上警但想放弃，也可以直接说「我退水」。`,
    `1~2 句即可，不要长篇大论。`,
  ].join('\n');
}

function taskForSheriffVote(seat, candidates) {
  return [
    `现在是警长竞选投票（本局 #${store.game.gameNo}）。你这一轮没有上警，请从下面的候选人里投一位当警长。`,
    `候选人：${candidates.map((c) => `${c.number}号 ${c.name}`).join('、')}。`,
    `请说明理由，并在最后一行写：投 X号`,
  ].join('\n');
}

function taskForOrder(sheriff) {
  return [
    `你是本局警长（${sheriff.number}号），现在由你决定今天的发言顺序。`,
    `请用一行「从 X号 开始」指定今天由哪位存活玩家先发言（可以说自己）。`,
  ].join('\n');
}

function taskForWolfExplode(seat) {
  return [
    `现在是第 ${store.game.day} 天白天，你是狼人（${seat.number}号 ${seat.name}）。`,
    `你可以选择现在就翻牌自爆：自爆会让你立即出局（没有遗言），白天立刻结束、直接进入黑夜，能帮队友跳过这一轮发言和投票。`,
    `如果你决定自爆，请明确说「我自爆」；如果暂时不自爆，就说「不自爆」并给一句理由。`,
  ].join('\n');
}

function taskForExilePK(seat) {
  return [
    `放逐投票出现平票，你是平票玩家之一，现在轮到你做申辩（放逐PK 环节，其他人不会插话）。`,
    `请用 1~2 句为自己辩解，或者指出其他人更可疑的地方。`,
  ].join('\n');
}

function taskForExileRevote(seat, tiedNumbers) {
  return [
    `现在是放逐重投环节（本局 #${store.game.gameNo}）。你只能在这几位平票玩家中选择放逐一人：${tiedNumbers.map((n) => `${n}号`).join('、')}。`,
    `请说明一句理由，并在最后一行写：投票：X号`,
  ].join('\n');
}

function taskForSheriffSummary(sheriff) {
  return [
    `你是本局警长（${sheriff.number}号），今天所有人都发言完了，现在轮到你做最后的总结发言（归票）。`,
    `请用 1~3 句总结今天的局势，明确说出你建议放逐谁、为什么，并在最后一行写「归票：X号」。`,
  ].join('\n');
}

function taskForSheriffPK(seat) {
  return [
    `警长竞选出现了平票，你是平票候选人之一，这是你的拉票机会（警长PK 环节）。`,
    `请用 1~2 句说明你为什么适合当警长，或者指出对手哪里不可信。`,
  ].join('\n');
}

function taskForSheriffRevote(seat, tiedNumbers) {
  return [
    `现在是警长重投环节（本局 #${store.game.gameNo}）。请只从这些平票候选人里选一位当警长：${tiedNumbers.map((n) => `${n}号`).join('、')}。`,
    `请说明一句理由，并在最后一行写：投 X号`,
  ].join('\n');
}

function taskForGuard(seat, day, lastGuard) {
  return [
    `现在是第 ${day} 天夜晚，你在守卫频道。`,
    `请用一行「守 X号」告诉主持人你今晚要守护谁（可以守自己，也可以守别人）。`,
    lastGuard
      ? `注意：你上一晚守的是 ${lastGuard}号，规则不允许连续两晚守同一个人。`
      : '（你上一晚没有守人。）',
  ].join('\n');
}

function taskForShot(seat, roleName, reason) {
  return [
    `你（${seat.number}号，${roleName}）刚刚${reason}出局，现在轮到你开枪。`,
    `请用一行「带走 X号」说明你要带走哪位存活玩家（不能是自己）。`,
    `如果你决定不开枪，就明确写「不开枪」。`,
  ].join('\n');
}

function taskForExplode(seat, day) {
  return [
    `现在是第 ${day} 天白天，你是白狼王。`,
    `你可以选择自爆：自爆会让你自己出局，同时带走一名存活玩家，并直接进入黑夜。`,
    `如果你要自爆，请用一行「自爆 带走 X号」；如果你决定不自爆，就写「不自爆」。`,
  ].join('\n');
}

function taskForWolf(seat, day) {
  return [
    `现在是第 ${day} 天夜晚，你在狼人频道里，和队友一起商量今晚杀谁。`,
    `可以简短讨论、点出你怀疑的身份，但最后一行必须明确写出你要杀的目标，格式：刀 X号`,
    `（只能选存活的好人；如果你们决定空刀，写「空刀」。）`,
  ].join('\n');
}

function taskForSeer(seat, day) {
  return [
    `现在是第 ${day} 天夜晚，你在预言家频道。`,
    `请用一行「验 X号」告诉主持人你今晚要查验哪位玩家（只能验存活的其他玩家）。`,
    `可以顺便说一句你的怀疑，但必须包含「验 X号」。`,
  ].join('\n');
}

function taskForWitch(seat, day) {
  return [
    `现在是第 ${day} 天夜晚，你在女巫频道，主持人刚把今晚的情况告诉了你。`,
    `请回复你的决定：`,
    `- 是否使用解药：写明「用解药」或「不用解药」`,
    `- 是否使用毒药：写明「毒 X号」或「不用毒药」`,
    `两句话就够，不要写作文。`,
  ].join('\n');
}

function taskForDaySpeak(seat, day, queue) {
  const list = queue?.list || [];
  const pos = list.findIndex((x) => x.number === seat.number);
  const aliveTotal = list.filter((x) => x.alive).length || list.length;
  return [
    `现在是第 ${day} 天白天，轮到你（${seat.number}号）在公共频道公开发言。`,
    pos >= 0 ? `你是本轮第 ${pos + 1} 位发言的（本轮共 ${aliveTotal} 位存活玩家依次发言）。` : '',
    `★ 现在全场只有你一个人在说话，其他人都还没轮到。不要说别人的台词、不要写「X号：…」、也不要假装别人已经回应了你。`,
    `请分析局势、表达你的怀疑对象或为自己辩解，1~4 句。`,
  ].filter(Boolean).join('\n');
}

function taskForVote(seat, day) {
  return [
    `现在是第 ${day} 天的放逐投票环节，你在公共频道。`,
    `请用一两句说明你要投谁、为什么，最后一行必须写：投票：X号`,
    `（只能投存活的玩家，不能投自己。）`,
  ].join('\n');
}

/* ==================== 主持人动作 ==================== */

/**
 * ★ 发言秩序保护：这些动作要么会调用模型，要么会切换阶段，
 *   只要还有一位玩家在生成，就必须拒绝 ——
 *   否则会出现"抢麦"（两个 AI 同时说话）或"漏麦"（队列被推进但没人发言）。
 */
const ACTIONS_NEED_MIC = new Set([
  'night', 'guard', 'wolves', 'seer', 'seerReveal', 'witchAsk', 'witch', 'witchApply',
  'dawn', 'nextSpeaker', 'dayAll', 'voteStart', 'voteAll', 'voteResolve',
  'shoot', 'shootManual', 'skipShot', 'explode', 'explodeManual', 'seatSpeak',
  'lastWords', 'skipLastWords', 'badge', 'badgeManual', 'campaign', 'sheriffVote', 'askOrder',
  'sheriffSummary', 'sheriffPK', 'wolfExplode', 'withdraw', 'votePK',
]);

async function hostAction(action, body, res) {
  const db = store.data;

  // ---- 麦克风占用检查：发生在任何状态改动之前 ----
  if (ACTIONS_NEED_MIC.has(action) && orchestrator.running) {
    const info = orchestrator.runningInfo();
    const seat = info ? store.getSeat(info.seatId) : null;
    return sendError(
      res,
      409,
      `${seat ? `${seat.number}号 ${seat.name}` : '上一位玩家'}还在发言，发言队列已暂停。请等 TA 说完，或点「停止」再继续。`
    );
  }

  switch (action) {
    /* ---------- 主持人说话 ---------- */
    case 'say': {
      const { channelId, content } = body;
      if (!store.getChannel(channelId)) return sendError(res, 400, '频道不存在');
      if (!String(content || '').trim()) return sendError(res, 400, '内容不能为空');
      const msg = Game.hostSay(store, channelId, String(content).trim());
      emit({ type: 'message.created', channelId, message: msg });
      return sendJson(res, 200, { ok: true, message: msg });
    }

    /* ---------- 天黑 ---------- */
    case 'night': {
      const info = Game.startNight(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, ...info, game: store.game });
    }

    /* ---------- 守卫守人 ---------- */
    case 'guard': {
      const guard = db.seats.find((s) => s.role === 'guard' && s.alive);
      if (!guard) return sendError(res, 400, '守卫已出局（或本局没有守卫）');
      Game.setNightStep(store, 'guard');
      store.updateGame({ markers: { ...(store.game.markers || {}), guardFrom: (store.getChannel('guard').messages || []).length } });
      const r = await orchestrator.speakOnce({
        seatId: guard.id,
        channelId: 'guard',
        task: taskForGuard(guard, db.game.day, guard.guardLast),
        reason: 'night-guard',
      });
      const result = Game.resolveGuard(store, store.game.markers?.guardFrom ?? 0);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, guard: result, error: r?.error || null });
    }

    /* ---------- 狼人行动：所有存活狼人依次在狼人频道发言 ---------- */
    case 'wolves': {
      if (db.game.phase !== 'night') return sendError(res, 400, '现在不是夜晚，请先点「天黑请闭眼」');
      Game.setNightStep(store, 'wolf');
      const wolves = Game.aliveWolves(db);
      if (!wolves.length) return sendError(res, 400, '没有存活的狼人');
      // ★ 记游标：本轮结算只看这次之后狼人的发言。
      //   少了这一行，第 2 夜之后的刀口会把前几夜的旧投票一起统计 ——
      //   旧目标往往已经出局，于是"刀 A 号"被结算成别人，等于程序偷偷改掉了狼队的决策。
      store.updateGame({
        markers: { ...(store.game.markers || {}), wolfFrom: (store.getChannel('wolf').messages || []).length },
      });
      const list = wolves.map((s) => ({
        seatId: s.id,
        channelId: 'wolf',
        task: taskForWolf(s, db.game.day),
        reason: 'night-wolf',
      }));
      const results = await orchestrator.speakMany(list);
      const kill = Game.resolveWolfKill(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, {
        ok: true,
        results,
        kill: { number: kill.number, parsed: kill.parsed, noKill: !!kill.noKill, fallback: !!kill.fallback },
        game: store.game,
      });
    }

    /* ---------- 预言家验人 ---------- */
    case 'seer': {
      const seer = db.seats.find((s) => s.role === 'seer' && s.alive);
      if (!seer) return sendError(res, 400, '预言家已出局');
      Game.setNightStep(store, 'seer');
      // 记一个游标：只解析这之后的消息，避免把昨晚的查验重复算进来
      store.updateGame({ markers: { ...(store.game.markers || {}), seerFrom: (store.getChannel('seer').messages || []).length } });
      const r = await orchestrator.speakOnce({
        seatId: seer.id,
        channelId: 'seer',
        task: taskForSeer(seer, db.game.day),
        reason: 'night-seer',
      });
      const check = Game.resolveSeerCheck(store, store.game.markers?.seerFrom ?? 0);
      return sendJson(res, 200, { ok: true, check, error: r?.error || null });
    }

    /* ---------- 主持人告知验人结果（也可以自己手打） ---------- */
    case 'seerReveal': {
      const n = Number(body.number) || Game.resolveSeerCheck(store, store.game.markers?.seerFrom ?? 0)?.number;
      const seat = store.getSeatByNumber(n);
      if (!seat) return sendError(res, 400, '请指定要告知的座位号');
      const isWolf = seat.role === 'wolf';
      const msg = Game.hostSay(store, 'seer', `${seat.number}号 的身份是【${isWolf ? '狼人' : '好人'}】。`, {
        reveal: true,
        target: seat.number,
      });
      emit({ type: 'message.created', channelId: 'seer', message: msg });
      return sendJson(res, 200, { ok: true, message: msg, isWolf });
    }

    /* ---------- 主持人告知女巫今晚死讯 ---------- */
    case 'witchAsk': {
      const witch = db.seats.find((s) => s.role === 'witch' && s.alive);
      if (!witch) return sendError(res, 400, '女巫已出局');
      const kill = db.game.pendingKill;
      const victim = kill ? store.getSeatByNumber(kill) : null;
      const text = victim
        ? `🌙 今晚 ${victim.number}号 ${victim.name} 被狼人袭击。你要使用解药救他吗？（你的解药：${witch.antidote ? '还在' : '已用完'}）${
            victim.number === witch.number && store.settings.witchCanSelfSave === false ? '※ 本局规则：女巫不能自救。' : ''
          }`
        : `🌙 今晚狼人没有杀人（空刀）。你的解药：${witch.antidote ? '还在' : '已用完'}。`;
      const msg = Game.hostSay(store, 'witch', text, { phase: 'night' });
      emit({ type: 'message.created', channelId: 'witch', message: msg });
      Game.setNightStep(store, 'witch');
      // 记游标：女巫的决定只看这条提问之后的回复
      store.updateGame({ markers: { ...(store.game.markers || {}), witchFrom: (store.getChannel('witch').messages || []).length } });
      return sendJson(res, 200, { ok: true, message: msg, pendingKill: kill });
    }

    /* ---------- 女巫回复 ---------- */
    case 'witch': {
      const witch = db.seats.find((s) => s.role === 'witch' && s.alive);
      if (!witch) return sendError(res, 400, '女巫已出局');
      const r = await orchestrator.speakOnce({
        seatId: witch.id,
        channelId: 'witch',
        task: taskForWitch(witch, db.game.day),
        reason: 'night-witch',
      });
      const decision = Game.resolveWitchDecision(store, store.game.markers?.witchFrom ?? 0);
      return sendJson(res, 200, { ok: true, decision, error: r?.error || null });
    }

    /* ---------- 主持人执行女巫的决定 ---------- */
    case 'witchApply': {
      const parsed = Game.resolveWitchDecision(store, store.game.markers?.witchFrom ?? 0);
      const save = body.save === undefined ? parsed.save : !!body.save;
      const poisonRaw = body.poison === undefined ? parsed.poison : body.poison;
      const poison = poisonRaw ? Number(poisonRaw) : null;
      const poisonSeat = poison ? store.getSeatByNumber(poison) : null;
      store.updateGame({
        savedThisNight: !!save,
        pendingPoison: poisonSeat && poisonSeat.alive ? poisonSeat.number : null,
      });
      const victim = db.game.pendingKill ? store.getSeatByNumber(db.game.pendingKill) : null;
      Game.hostSay(
        store,
        'witch',
        `主持人执行：${save ? `使用解药救 ${victim ? victim.number + '号' : '（无人被袭击）'}` : '不使用解药'}；${
          store.game.pendingPoison ? `使用毒药毒 ${store.game.pendingPoison}号` : '不使用毒药'
        }。`,
        { phase: 'night', resolved: true }
      );
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, game: store.game });
    }

    /* ---------- 天亮了：结算夜晚并进入白天 ---------- */
    case 'dawn': {
      const report = Game.resolveNight(store);
      emit({ type: 'game.changed', game: store.game });
      const day = Game.startDay(store);
      emit({ type: 'game.changed', game: store.game });
      const seats = seatsPayload();
      emit({ type: 'seats.changed', seats });
      return sendJson(res, 200, { ok: true, report, day, game: store.game, seats });
    }

    /* ---------- 下一位发言 ---------- */
    case 'nextSpeaker': {
      // 注意顺序：先确认没人正在说话（上面的麦克风检查已保证），再推进队列
      const wasStart = (store.game.speakIndex || 0) === 0;
      const seat = Game.nextSpeaker(store);
      if (!seat) {
        emit({ type: 'game.changed', game: store.game });
        return sendJson(res, 200, { ok: true, done: true, message: '本轮发言已经全部结束，可以点「开始投票」了' });
      }
      if (wasStart) Game.hostSay(store, 'lobby', `请从 ${seat.number}号 开始依次发言。`, { phase: 'day' });
      const queue = Game.speakQueue(store);
      const r = await orchestrator.speakOnce({
        seatId: seat.id,
        channelId: 'lobby',
        task: taskForDaySpeak(seat, db.game.day, queue),
        reason: 'day-speak',
      });
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, {
        ok: true,
        seat: { number: seat.number, name: seat.name },
        queue,
        error: r?.error || null,
        game: store.game,
      });
    }

    /* ---------- 剩下的存活玩家逐个自动发言完 ---------- */
    case 'dayAll': {
      const spoken = [];
      for (let i = 0; i < 30; i++) {
        const seat = Game.nextSpeaker(store);
        if (!seat) break;
        spoken.push({ number: seat.number, name: seat.name });
        await orchestrator.speakOnce({
          seatId: seat.id,
          channelId: 'lobby',
          task: taskForDaySpeak(seat, db.game.day, Game.speakQueue(store)),
          reason: 'day-speak-auto',
        });
      }
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, spoken, queue: Game.speakQueue(store), game: store.game });
    }

    /* ---------- 开始投票 ---------- */
    case 'voteStart': {
      Game.startVote(store);
      const sheriff = Game.getSheriff(db);
      // 标准流程：警长在投票前做最后发言（归票）。没做的话提醒一下，但不强制。
      const warning = sheriff && sheriff.alive && !store.game.sheriffSummarized
        ? `警长 ${sheriff.number}号 ${sheriff.name} 还没做归票发言（标准流程里警长最后发言）`
        : null;
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, game: store.game, warning });
    }

    /* ---------- 全体投票 ---------- */
    case 'voteAll': {
      if (store.game.phase !== 'vote') return sendError(res, 400, '请先点「开始投票」');
      const alive = Game.aliveSeats(db);
      const list = alive.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForVote(s, db.game.day),
        reason: 'vote',
      }));
      const results = await orchestrator.speakMany(list);
      const tally = Game.tallyVotes(store);
      return sendJson(res, 200, { ok: true, results, tally });
    }

    /* ---------- 计票并放逐 ---------- */
    case 'voteResolve': {
      const result = Game.resolveVote(store);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, ...result, game: store.game });
    }

    /* ---------- 手动结束 ---------- */
    case 'end': {
      const r = Game.hostEndGame(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, ...r });
    }

    /* ---------- 让某个座位单独说一句（座位面板按钮） ---------- */
    case 'seatSpeak': {
      const seat = store.getSeat(body.seatId);
      if (!seat) return sendError(res, 400, '座位不存在');
      const channelId = store.getChannel(body.channelId) ? body.channelId : 'lobby';
      const task = body.task || [
        `现在是第 ${db.game.day} 天（${db.game.phase}），主持人让你在「${store.getChannel(channelId).name}」说一句。`,
        `请结合你能看到的记录，简短发言 1~3 句。`,
      ].join('\n');
      const r = await orchestrator.speakOnce({ seatId: seat.id, channelId, task, reason: 'manual' });
      return sendJson(res, 200, { ok: true, error: r?.error || null });
    }

    /* ---------- 猎人 / 狼王开枪（自动解析 + 可手动指定） ---------- */
    case 'shoot': {
      const pending = db.game.pendingShot;
      if (!pending) return sendError(res, 400, '当前没有待执行的开枪');
      const seat = store.getSeat(pending.seatId);
      const roleName = ROLES[pending.role]?.name || pending.role;
      const r = await orchestrator.speakOnce({
        seatId: pending.seatId,
        channelId: 'lobby',
        task: taskForShot(seat, roleName, pending.reason),
        reason: 'shot',
        allowDead: true, // 猎人/狼王是"死后开枪"
      });
      const text = r?.message?.content || '';
      const noShoot = saysNo(text, ['开枪', '带走', '带']);
      const target = noShoot ? null : parseIntent(text, ['带走', '枪毙', '杀掉', '带走', '带', '开枪']);
      if (!target) {
        return sendJson(res, 200, { ok: true, needManual: true, text, error: r?.error || null });
      }
      const applied = Game.resolveShot(store, target);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, target, applied, error: r?.error || null });
    }

    /* ---------- 主持人手动指定开枪目标（AI 没说清楚时用） ---------- */
    case 'shootManual': {
      const applied = Game.resolveShot(store, Number(body.number));
      if (!applied.ok) return sendError(res, 400, applied.error);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, applied });
    }

    /* ---------- 放弃开枪 ---------- */
    case 'skipShot': {
      const r = Game.skipShot(store);
      if (!r.ok) return sendError(res, 400, r.error);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true });
    }

    /* ---------- 白狼王自爆 ---------- */
    case 'explode': {
      const wolf = db.seats.find((s) => s.alive && s.role === 'whitewolfking');
      if (!wolf) return sendError(res, 400, '没有存活的白狼王');
      const r = await orchestrator.speakOnce({
        seatId: wolf.id,
        channelId: 'lobby',
        task: taskForExplode(wolf, db.game.day),
        reason: 'explode',
      });
      const text = r?.message?.content || '';
      const noExplode = saysNo(text, ['自爆', '爆']);
      if (noExplode) {
        return sendJson(res, 200, { ok: true, skipped: true, text, message: '白狼王决定不自爆' });
      }
      const target = parseIntent(text, ['带走', '带', '爆', '杀']);
      if (!target) {
        return sendJson(res, 200, { ok: true, needManual: true, text, error: r?.error || null });
      }
      const applied = Game.whiteWolfExplode(store, target);
      if (!applied.ok) return sendError(res, 400, applied.error);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, applied, error: r?.error || null });
    }

    /* ---------- 手动执行白狼王自爆 ---------- */
    case 'explodeManual': {
      const applied = Game.whiteWolfExplode(store, Number(body.number));
      if (!applied.ok) return sendError(res, 400, applied.error);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, applied });
    }

    /* ---------- 遗言 ---------- */
    case 'lastWords': {
      const entry = Game.nextLastWords(store);
      if (!entry) return sendError(res, 400, '当前没有待发表遗言的玩家');
      const seat = store.getSeat(entry.seatId);
      if (!seat) return sendError(res, 400, '座位不存在');
      const r = await orchestrator.speakOnce({
        seatId: seat.id,
        channelId: 'lobby',
        task: taskForLastWords(seat, entry),
        reason: 'last-words',
        allowDead: true, // 遗言是"死后发言"的唯一合法通道
      });
      const nextStep = Game.completeLastWords(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, seat: { number: seat.number, name: seat.name }, nextStep, error: r?.error || null });
    }

    /* ---------- 跳过遗言（主持人代打/玩家不发言） ---------- */
    case 'skipLastWords': {
      const entry = Game.nextLastWords(store);
      if (!entry) return sendError(res, 400, '当前没有待发表遗言的玩家');
      Game.hostSay(store, 'lobby', `${entry.seatNumber}号 ${entry.name} 没有留下遗言。`, { lastWords: true, skipped: true });
      const nextStep = Game.completeLastWords(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, nextStep });
    }

    /* ---------- 警徽移交 / 撕警徽 ---------- */
    case 'badge': {
      const pending = db.game.pendingBadge;
      if (!pending) return sendError(res, 400, '当前没有待处理的警徽');
      const seat = store.getSeat(pending.seatId);
      const r = await orchestrator.speakOnce({
        seatId: seat.id,
        channelId: 'lobby',
        task: taskForBadge(seat),
        reason: 'badge',
        allowDead: true,
      });
      const text = r?.message?.content || '';
      const wantsTear = /(撕|不用给|不带|放弃警徽)/.test(text);
      const target = wantsTear ? 0 : parseIntent(text, ['给', '交给', '移交', '传', '给到']);
      const applied = Game.transferBadge(store, target);
      if (!applied.ok) {
        // AI 没说清楚 → 保留 pending，让主持人手动指定
        return sendJson(res, 200, { ok: true, needManual: true, text, error: applied.error });
      }
      const nextStep = Game.advanceDayStep(store);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, applied, nextStep, error: r?.error || null });
    }

    /* ---------- 主持人手动移交警徽 ---------- */
    case 'badgeManual': {
      const applied = Game.transferBadge(store, body.number === undefined ? 0 : Number(body.number));
      if (!applied.ok) return sendError(res, 400, applied.error);
      const nextStep = Game.advanceDayStep(store);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, applied, nextStep });
    }

    /* ---------- 警长竞选：所有存活玩家依次表态 ---------- */
    case 'campaign': {
      const alive = Game.aliveSeats(db);
      const results = await orchestrator.speakMany(alive.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForCampaign(s),
        reason: 'campaign',
      })));
      const candidates = Game.collectCandidates(store);
      const nextStep = Game.advanceDayStep(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, {
        ok: true,
        results,
        candidates: candidates.map((c) => `${c.number}号 ${c.name}`),
        nextStep,
        game: store.game,
      });
    }

    /* ---------- 警长竞选投票（只有没上警的人能投） ---------- */
    case 'sheriffVote': {
      const candidates = db.game.candidates || [];
      if (!candidates.length) return sendError(res, 400, '没有人上警，跳过竞选');
      const candidateIds = new Set(candidates.map((c) => c.seatId));
      const voters = Game.aliveSeats(db).filter((s) => !candidateIds.has(s.id));
      if (!voters.length) {
        store.updateGame({ campaignDone: true, sheriffId: null });
        const nextStep = Game.advanceDayStep(store);
        return sendJson(res, 200, { ok: true, note: '所有人都上警了，无人可投票，本局无警长', nextStep });
      }
      store.updateGame({ markers: { ...(store.game.markers || {}), sheriffVoteFrom: (store.getChannel('lobby').messages || []).length } });
      const results = await orchestrator.speakMany(voters.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForSheriffVote(s, candidates),
        reason: 'sheriff-vote',
      })));
      const tally = Game.tallySheriffVotes(store);
      let sheriff = null;
      if (tally.top && !tally.tie) {
        const cand = candidates.find((c) => c.number === tally.top);
        const seat = cand ? store.getSeat(cand.seatId) : null;
        if (seat && seat.alive) {
          store.updateGame({ sheriffId: seat.id });
          sheriff = seat;
          Game.hostSay(store, 'lobby', `🏅 警长竞选结果：${seat.number}号 ${seat.name} 当选警长（${tally.max} 票）！警长拥有 1.5 票，并决定每天的发言顺序。`, { badge: true });
        }
      } else if (tally.tie) {
        // ★ 平票 → PK 发言 + 重投（标准规则）
        const tied = tally.counts.filter((c) => c.count === tally.max).map((c) => c.target);
        store.updateGame({ pkCandidates: tied });
        Game.hostSay(
          store,
          'lobby',
          `🏅 警长竞选平票（${tally.counts.map((c) => `${c.target}号${c.count}票`).join('、')}）—— ${tied.map((n) => `${n}号`).join('、')} 请做 PK 发言，之后由警下玩家重投。`,
          { badge: true }
        );
      } else {
        Game.hostSay(store, 'lobby', '🏅 警长竞选没有有效票，本局没有警长。', { badge: true });
      }
      if (!tally.tie) store.updateGame({ campaignDone: true });
      const nextStep = Game.advanceDayStep(store);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, {
        ok: true,
        results,
        tally,
        needPK: !!tally.tie,
        pkCandidates: tally.tie ? tally.counts.filter((c) => c.count === tally.max).map((c) => c.target) : [],
        sheriff: sheriff ? { number: sheriff.number, name: sheriff.name } : null,
        nextStep,
        game: store.game,
      });
    }

    /* ---------- 警长竞选 PK：平票候选人拉票 + 警下重投 ---------- */
    case 'sheriffPK': {
      const tied = db.game.pkCandidates || [];
      if (!tied.length) return sendError(res, 400, '当前没有需要 PK 的候选人');
      const pkSeats = tied.map((n) => store.getSeatByNumber(n)).filter((s) => s && s.alive);
      const pkResults = await orchestrator.speakMany(pkSeats.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForSheriffPK(s),
        reason: 'sheriff-pk',
      })));

      // 只有警下（没上警的人）能重投，且只能投平票的候选人
      const tiedIds = new Set(pkSeats.map((s) => s.id));
      const voters = Game.aliveSeats(db).filter((s) => !tiedIds.has(s.id));
      store.updateGame({ markers: { ...(store.game.markers || {}), sheriffRevoteFrom: (store.getChannel('lobby').messages || []).length } });
      const rvResults = await orchestrator.speakMany(voters.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForSheriffRevote(s, tied),
        reason: 'sheriff-revote',
      })));

      const tally = Game.tallySheriffVotes(store, {
        from: store.game.markers?.sheriffRevoteFrom ?? 0,
        allowedNumbers: tied,
      });
      let sheriff = null;
      if (tally.top && !tally.tie) {
        const seat = store.getSeatByNumber(tally.top);
        if (seat && seat.alive) {
          store.updateGame({ sheriffId: seat.id });
          sheriff = seat;
          Game.hostSay(store, 'lobby', `🏅 PK 重投结果：${seat.number}号 ${seat.name} 当选警长（${tally.max} 票）。`, { badge: true });
        }
      } else {
        Game.hostSay(store, 'lobby', '🏅 PK 之后依然平票 / 无有效票，警徽流失，本局没有警长。', { badge: true });
      }
      store.updateGame({ campaignDone: true, pkCandidates: [] });
      const nextStep = Game.advanceDayStep(store);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, {
        ok: true,
        pkResults,
        revoteResults: rvResults,
        tally,
        sheriff: sheriff ? { number: sheriff.number, name: sheriff.name } : null,
        nextStep,
        game: store.game,
      });
    }

    /* ---------- 警长归票（投票前的最后总结发言） ---------- */
    case 'sheriffSummary': {
      const sheriff = Game.getSheriff(db);
      if (!sheriff) return sendError(res, 400, '本局没有警长');
      if (!sheriff.alive) return sendError(res, 400, '警长已出局');
      const r = await orchestrator.speakOnce({
        seatId: sheriff.id,
        channelId: 'lobby',
        task: taskForSheriffSummary(sheriff),
        reason: 'sheriff-summary',
      });
      Game.markSheriffSummarized(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, error: r?.error || null });
    }

    /* ---------- 警长决定今天的发言顺序 ---------- */
    case 'askOrder': {
      const sheriff = Game.getSheriff(db);
      if (!sheriff) return sendError(res, 400, '本局没有警长');
      if (!sheriff.alive) return sendError(res, 400, '警长已出局，请先处理警徽');
      const r = await orchestrator.speakOnce({
        seatId: sheriff.id,
        channelId: 'lobby',
        task: taskForOrder(sheriff),
        reason: 'order',
      });
      const text = r?.message?.content || '';
      const n = parseIntent(text, ['从', '由', '开始']);
      if (!n) return sendJson(res, 200, { ok: true, needManual: true, text });
      const direction = /(逆时针|倒序|反向|逆序)/.test(text) ? 'ccw' : 'cw';
      const applied = Game.setSpeakOrderFrom(store, n, direction);
      if (!applied.ok) return sendJson(res, 200, { ok: true, needManual: true, text, error: applied.error });
      Game.hostSay(store, 'lobby', `🏅 警长 ${sheriff.number}号 ${sheriff.name} 指定发言顺序：从 ${n}号 开始，${direction === 'ccw' ? '逆时针' : '顺时针'}。`, { badge: true, order: true });
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, order: applied.order, direction, error: r?.error || null });
    }

    /* ---------- ★ 狼人自爆（任意狼人，白天任意时刻） ---------- */
    case 'wolfExplode': {
      const seat = store.getSeatByNumber(Number(body.number));
      if (!seat || !seat.alive) return sendError(res, 400, '请指定一位存活的狼人');
      if (!['wolf', 'wolfking', 'whitewolfking'].includes(seat.role)) return sendError(res, 400, '只有狼人可以自爆');

      if (body.force !== true) {
        // 先问 AI 自己的决定
        const r = await orchestrator.speakOnce({
          seatId: seat.id,
          channelId: 'lobby',
          task: taskForWolfExplode(seat),
          reason: 'explode-ask',
        });
        const text = r?.message?.content || '';
        const wants = /自爆/.test(text) && !saysNo(text, ['自爆']);
        if (!wants) {
          Game.hostSay(store, 'lobby', `💥 ${seat.number}号 ${seat.name} 表示现在不自爆。`, { explode: false });
          emit({ type: 'game.changed', game: store.game });
          return sendJson(res, 200, { ok: true, exploded: false, text, error: r?.error || null });
        }
      }
      const applied = Game.wolfExplode(store, seat.number);
      if (!applied.ok) return sendError(res, 400, applied.error);
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, exploded: true, ...applied });
    }

    /* ---------- 退水（放弃警长竞选） ---------- */
    case 'withdraw': {
      const applied = Game.withdrawCandidate(store, body.number);
      if (!applied.ok) return sendError(res, 400, applied.error);
      const nextStep = Game.advanceDayStep(store);
      emit({ type: 'game.changed', game: store.game });
      return sendJson(res, 200, { ok: true, ...applied, nextStep });
    }

    /* ---------- ★ 放逐投票 PK：申辩 + 重投 ---------- */
    case 'votePK': {
      const pk = store.game.votePK;
      if (!pk) return sendError(res, 400, '当前没有平票 PK');
      const tiedSeats = pk.candidates.map((n) => store.getSeatByNumber(n)).filter((s) => s && s.alive);
      const pkResults = await orchestrator.speakMany(tiedSeats.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForExilePK(s),
        reason: 'vote-pk',
      })));
      // 平票的玩家不能参与重投
      const tiedIds = new Set(tiedSeats.map((s) => s.id));
      const voters = Game.aliveSeats(db).filter((s) => !tiedIds.has(s.id));
      const rvResults = await orchestrator.speakMany(voters.map((s) => ({
        seatId: s.id,
        channelId: 'lobby',
        task: taskForExileRevote(s, pk.candidates),
        reason: 'vote-revote',
      })));
      const result = Game.resolveVote(store, { revote: true });
      emit({ type: 'game.changed', game: store.game });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, { ok: true, pkResults, revoteResults: rvResults, ...result });
    }

    /* ---------- 停止生成 ---------- */
    case 'stop': {
      return sendJson(res, 200, { ok: true, stopped: orchestrator.stop() });
    }

    /* ---------- 隔离自检（对全部座位跑一遍权限矩阵校验） ---------- */
    case 'checkIsolation': {
      const report = checkIsolation(store.data);
      return sendJson(res, 200, { ok: true, report });
    }

    default:
      return sendError(res, 404, `未知的主持人指令：${action}`);
  }
}

/* ==================== 路由 ==================== */
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean);

  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, statePayload({ view: url.searchParams.get('view') || 'host' }));
  }

  /* SSE */
  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', running: orchestrator.runningInfo() })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return undefined;
  }

  /* ---------- 主持人指令 ---------- */
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'host' && parts[2]) {
    const body = await readBody(req);
    try {
      return await hostAction(parts[2], body, res);
    } catch (err) {
      console.error('[host]', err);
      if (!res.headersSent) return sendError(res, 400, err.message);
      return undefined;
    }
  }

  /* ---------- 开新一局（默认不动频道历史） ---------- */
  if (method === 'POST' && pathname === '/api/game/new') {
    const body = await readBody(req);
    // ★ 身份分配方式：random（默认，洗牌）/ manual（主持人逐个座位指定）
    const assignMode = body.assignMode === 'manual' ? 'manual' : 'random';
    const plan = assignMode === 'manual'
      ? (Array.isArray(body.roles) ? body.roles.slice() : [])
      : (Array.isArray(body.rolePlan) && body.rolePlan.length ? body.rolePlan : Game.DEFAULT_ROLE_PLAN);

    if (assignMode === 'manual' && !plan.length) {
      return sendError(res, 400, '手动分配需要给出每个座位的身份');
    }
    const bad = plan.find((r) => !ROLES[r]);
    if (bad) return sendError(res, 400, `未知身份：${bad}`);

    // 通用合法性校验（随机/手动都要满足）
    const wolves = plan.filter((r) => ['wolf', 'wolfking', 'whitewolfking'].includes(r)).length;
    if (plan.length < 4) return sendError(res, 400, '至少 4 名玩家');
    if (plan.length > 18) return sendError(res, 400, '最多 18 名玩家');
    if (wolves === 0) return sendError(res, 400, '至少要有一个狼人');
    if (wolves >= plan.length / 2) return sendError(res, 400, '狼人不能超过一半');

    const agentIds = Array.isArray(body.agentIds) ? body.agentIds.filter((id) => store.getAgent(id)) : store.agents.map((a) => a.id);
    const gameNo = (store.game.gameNo || 0) + 1;
    orchestrator.stop();
    store.clearAllChannels('主持人开了一局新游戏');
    // ★ 私信也跟着清空：每局独立，绝不带上一局的记忆
    store.clearDms(null);
    Game.setupSeats(store, {
      rolePlan: plan,
      agentIds,
      assignMode,
      names: Array.isArray(body.names) ? body.names : [],
    });
    store.updateGame({ gameNo });
    emit({ type: 'channels.changed' });
    emit({ type: 'seats.changed', seats: seatsPayload() });
    emit({ type: 'game.changed', game: store.game });
    return sendJson(res, 200, {
      ok: true,
      assignMode,
      seats: seatsPayload(),
      game: store.game,
      note: assignMode === 'manual' ? '身份按你指定的落座（没有洗牌）' : '身份已随机洗牌',
    });
  }

  /* ---------- ★ 换座位上的 AI（频道不重建、历史不清除） ---------- */
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'seats' && parts[2] && parts[3] === 'agent') {
    const seat = store.getSeat(parts[2]);
    if (!seat) return sendError(res, 404, '座位不存在');
    if (orchestrator.runningInfo()?.seatId === seat.id) return sendError(res, 400, '这位玩家正在发言，等它说完再换');
    const body = await readBody(req);
    const agentId = body.agentId || null;
    if (agentId && !store.getAgent(agentId)) return sendError(res, 404, 'AI 不存在');
    const before = seat.agentId;
    // 只改这一个字段：频道、历史消息、其他人的记录全都不受影响
    store.updateSeat(seat.id, { agentId });
    const seats = seatsPayload();
    emit({ type: 'seats.changed', seats });
    return sendJson(res, 200, {
      ok: true,
      seat: publicSeat(store.getSeat(seat.id), agentsById()),
      seats,
      note: '频道与历史消息保持不变，新接入的 AI 会读取本座位有权限的频道历史',
      before,
      after: agentId,
    });
  }

  /* ---------- 手动改座位（改名 / 改身份 / 复活，调试用） ---------- */
  if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'seats' && parts[2]) {
    const seat = store.getSeat(parts[2]);
    if (!seat) return sendError(res, 404, '座位不存在');
    const body = await readBody(req);
    const patch = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.avatar === 'string' && body.avatar.trim()) patch.avatar = body.avatar.trim();
    if (body.role && ROLES[body.role]) patch.role = body.role;
    if (typeof body.alive === 'boolean') patch.alive = body.alive;
    store.updateSeat(seat.id, patch);
    const seats = seatsPayload();
    emit({ type: 'seats.changed', seats });
    return sendJson(res, 200, { ok: true, seats });
  }

  /* ---------- 频道管理 ---------- */
  if (method === 'POST' && pathname === '/api/channels/clear') {
    orchestrator.stop();
    store.clearAllChannels('主持人手动清空了频道历史');
    emit({ type: 'channels.changed' });
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'channels' && parts[2] && parts[3] === 'clear') {
    if (!store.clearChannel(parts[2])) return sendError(res, 404, '频道不存在');
    emit({ type: 'channels.changed' });
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- ★ 成员库导出 / 导入 / 备份恢复（防丢数据） ---------- */
  if (method === 'GET' && pathname === '/api/agents/export') {
    const payload = {
      kind: 'ai-werewolf-agents',
      exportedAt: new Date().toISOString(),
      agents: store.agents.map((a) => ({ ...a })),
    };
    return sendJson(res, 200, { ok: true, count: payload.agents.length, json: JSON.stringify(payload, null, 2) });
  }
  if (method === 'POST' && pathname === '/api/agents/import') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = typeof body.json === 'string' ? JSON.parse(body.json) : body.json;
    } catch (err) {
      return sendError(res, 400, `导入内容不是合法 JSON：${err.message}`);
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.agents;
    if (!Array.isArray(list) || !list.length) return sendError(res, 400, '导入内容里没有 agents 数组');
    let added = 0;
    let updated = 0;
    for (const raw of list) {
      const item = normalizeAgent(raw);
      // 同名同地址视为同一个成员，做覆盖更新；否则新增
      const dup = store.agents.find((a) => a.name === item.name && a.baseUrl === item.baseUrl);
      if (dup) {
        store.updateAgent(dup.id, item);
        updated++;
      } else {
        store.addAgent({ ...item, id: raw.id && !store.getAgent(raw.id) ? raw.id : uid('agt'), createdAt: raw.createdAt || Date.now() });
        added++;
      }
    }
    emit({ type: 'agents.changed' });
    return sendJson(res, 200, { ok: true, added, updated, total: store.agents.length });
  }
  if (method === 'GET' && pathname === '/api/backups') {
    return sendJson(res, 200, { ok: true, dataFile: DATA_FILE, backups: store.listBackups() });
  }
  if (method === 'POST' && pathname === '/api/backups/restore') {
    const body = await readBody(req);
    try {
      const r = store.restoreAgentsFromBackup(body.name);
      if (!r.ok) return sendError(res, 400, r.error);
      emit({ type: 'agents.changed' });
      emit({ type: 'seats.changed', seats: seatsPayload() });
      return sendJson(res, 200, r);
    } catch (err) {
      return sendError(res, 400, `恢复失败：${err.message}`);
    }
  }

  /* ---------- AI 成员管理 ---------- */
  if (method === 'POST' && pathname === '/api/agents') {
    const body = await readBody(req);
    const agent = normalizeAgent(body);
    agent.id = uid('agt');
    agent.createdAt = Date.now();
    store.addAgent(agent);
    emit({ type: 'agents.changed' });
    return sendJson(res, 200, publicAgent(agent));
  }
  if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'agents' && parts[2]) {
    const existing = store.getAgent(parts[2]);
    if (!existing) return sendError(res, 404, 'AI 不存在');
    const body = await readBody(req);
    const patch = normalizeAgent(body, existing);
    delete patch.id;
    store.updateAgent(existing.id, patch);
    emit({ type: 'agents.changed' });
    return sendJson(res, 200, publicAgent(store.getAgent(existing.id)));
  }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'agents' && parts[2]) {
    if (!store.deleteAgent(parts[2])) return sendError(res, 404, 'AI 不存在');
    emit({ type: 'agents.changed' });
    emit({ type: 'seats.changed', seats: seatsPayload() });
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/agents/test') {
    const body = await readBody(req);
    let candidate;
    try {
      candidate = normalizeAgent({ name: 'test', ...body }, body.id ? store.getAgent(body.id) : null);
    } catch (err) {
      return sendError(res, 400, err.message);
    }
    try {
      return sendJson(res, 200, await orchestrator.testAgent(candidate));
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  /* ---------- 模型列表 ---------- */
  if (method === 'POST' && pathname === '/api/models') {
    const body = await readBody(req);
    const existing = body.id ? store.getAgent(body.id) : null;
    const baseUrl = String(body.baseUrl || existing?.baseUrl || '').trim();
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : existing?.apiKey || '';
    if (!baseUrl) return sendError(res, 400, '请先填写 Base URL');
    try {
      const models = await listModels({ baseUrl, apiKey });
      return sendJson(res, 200, { ok: true, count: models.length, models });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  /* ---------- 代理端口自动检测 ---------- */
  if (method === 'GET' && pathname === '/api/proxy/detect') {
    try {
      const r = await detectProxy();
      return sendJson(res, 200, { ok: true, current: getProxy(), ...r });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }
  if (method === 'POST' && pathname === '/api/proxy/apply') {
    const body = await readBody(req);
    const url = String(body.url || '').trim();
    try {
      setOpenAIProxy(url);
      store.updateSettings({ proxy: url });
      emit({ type: 'settings.changed', settings: store.settings });
      return sendJson(res, 200, { ok: true, proxy: url });
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  }

  /* ---------- 手动登记模型名（接口列表滞后时的兜底） ---------- */
  if (method === 'POST' && pathname === '/api/models/known') {
    const body = await readBody(req);
    const baseUrl = String(body.baseUrl || '').trim();
    const model = String(body.model || '').trim();
    if (!baseUrl) return sendError(res, 400, '缺少 Base URL');
    if (!model) return sendError(res, 400, '缺少模型名');
    const map = { ...(store.settings.knownModels || {}) };
    const list = new Set(map[baseUrl] || []);
    if (body.remove) list.delete(model);
    else list.add(model);
    map[baseUrl] = [...list];
    if (!map[baseUrl].length) delete map[baseUrl];
    store.updateSettings({ knownModels: map });
    emit({ type: 'settings.changed', settings: store.settings });
    return sendJson(res, 200, { ok: true, baseUrl, models: map[baseUrl] || [] });
  }

  /* ---------- 设置 ---------- */
  if (method === 'PUT' && pathname === '/api/settings') {
    const body = await readBody(req);
    const patch = {};
    for (const key of ['hostName', 'audienceView']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    for (const key of ['contextLimit', 'maxTokens', 'temperature']) {
      if (body[key] !== undefined) patch[key] = Number(body[key]);
    }
    // ★ 智力总控（普通 / 聪明 / 智能 / 自定义）
    if (body.aiLevel !== undefined) {
      const next = String(body.aiLevel);
      patch.aiLevel = AI_LEVELS[next] ? next : 'custom';
    }
    for (const key of ['tieRevote', 'allowWolfNoKill', 'onePotionPerNight', 'sameGuardAndSaveDies']) {
      if (body[key] !== undefined) patch[key] = !!body[key];
    }
    if (body.witchSelfSave !== undefined) patch.witchSelfSave = String(body.witchSelfSave);
    if (body.winRule !== undefined) patch.winRule = body.winRule === 'all' ? 'all' : 'side';
    if (body.lastWordsOrder !== undefined) patch.lastWordsOrder = body.lastWordsOrder === 'afterShot' ? 'afterShot' : 'beforeShot';
    if (body.sheriffEnabled !== undefined) patch.sheriffEnabled = !!body.sheriffEnabled;
    if (body.lastWords && typeof body.lastWords === 'object') {
      patch.lastWords = { ...(store.settings.lastWords || {}), ...body.lastWords };
    }
    // ★ 网络代理：Node 不会自动用系统代理，这里允许用户显式指定
    if (body.proxy !== undefined) {
      const next = String(body.proxy || '').trim();
      try {
        setOpenAIProxy(next);
        patch.proxy = next;
      } catch (err) {
        return sendError(res, 400, err.message);
      }
    }
    store.updateSettings(patch);
    emit({ type: 'settings.changed', settings: store.settings });
    return sendJson(res, 200, store.settings);
  }

  /* ---------- ★ 私信：主持人 ↔ 单个 AI（不进频道，不影响游戏） ---------- */
  if (method === 'GET' && pathname === '/api/dm') {
    const seatId = url.searchParams.get('seatId') || '';
    return sendJson(res, 200, { ok: true, seatId, messages: store.getDms(seatId) });
  }
  if (method === 'POST' && pathname === '/api/dm') {
    const body = await readBody(req);
    const seat = store.getSeat(body.seatId);
    if (!seat) return sendError(res, 404, '座位不存在');
    try {
      const r = await orchestrator.askPrivately({ seatId: seat.id, question: body.question });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  }
  if (method === 'POST' && pathname === '/api/dm/clear') {
    const body = await readBody(req);
    store.clearDms(body.seatId || null);
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- 调试：最近送给模型的 prompt（自动化测试断言隔离用） ---------- */
  if (method === 'GET' && pathname === '/api/debug/prompts') {
    const seatId = url.searchParams.get('seatId');
    const list = seatId ? orchestrator.lastPrompts.filter((p) => p.seatId === seatId) : orchestrator.lastPrompts;
    return sendJson(res, 200, { count: list.length, prompts: list });
  }
  if (method === 'POST' && pathname === '/api/debug/prompt') {
    const body = await readBody(req);
    const seat = store.getSeat(body.seatId);
    if (!seat) return sendError(res, 404, '座位不存在');
    const { buildPrompt, assertNoLeak } = await import('./lib/channels.js');
    // ★ 和真实发言保持一致：带上智力总控决定的上下文条数 / 生成参数
    const gen = resolveGeneration(store.settings, seat.agentId ? store.getAgent(seat.agentId) : null);
    const built = buildPrompt(store.data, seat, {
      channelId: body.channelId || allowedChannels(seat.role).slice(-1)[0],
      task: body.task || '（调试用，不调用模型）',
      contextLimit: gen.contextLimit,
      extraRules: gen.extraRules,
    });
    let leak = null;
    try { assertNoLeak(store.data, seat, built.messages); } catch (e) { leak = { message: e.message, leaks: e.leaks }; }
    return sendJson(res, 200, { ok: true, messages: built.messages, meta: built.meta, leak, params: gen });
  }

  return sendError(res, 404, `未知接口：${method} ${pathname}`);
}

/* ==================== 静态文件 ==================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return res.writeHead(403).end('Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/* ==================== 启动 ==================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end('Method Not Allowed');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendError(res, 500, err.message || '服务器内部错误');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  // 启动时把保存的代理配置装载进来（Node 不会自动使用系统代理）
  try {
    const r = setOpenAIProxy(store.settings.proxy);
    if (r.proxy) console.log(`  ➜  已启用网络代理：${r.proxy}`);
  } catch (err) {
    console.warn(`  ⚠️  代理配置无效（${err.message}），已忽略`);
  }
  console.log('');
  console.log('  🐺  AI 狼人杀已启动');
  console.log(`  ➜  主持人控制台：http://${HOST}:${PORT}`);
  console.log(`  ➜  数据文件：${DATA_FILE}`);
  console.log(`  ➜  已载入 ${store.agents.length} 个 AI 成员${store.agents.length ? '：' + store.agents.map((a) => a.name).join('、') : '（成员库是空的，去「AI 成员库」加一个）'}`);
  console.log(`  ➜  自动备份：${path.join(path.dirname(DATA_FILE), 'backup')}`);
  console.log('  ➜  频道（持久存在，换人不重建）：' + CHANNELS.map((c) => c.name).join(' / '));
  console.log('');
});

process.on('SIGINT', () => {
  orchestrator.stop();
  store.flush();
  console.log('\n已保存，再见 👋');
  process.exit(0);
});
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
