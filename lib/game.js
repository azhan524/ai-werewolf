/**
 * 游戏状态机 + 规则引擎（标准 12 人局）
 *
 *   夜晚：守卫 → 狼人 → 预言家 → 女巫 → 结算
 *   白天：公布死讯 → 猎人/狼王开枪 → 依次发言 → 投票放逐 → 白痴翻牌 / 狼王开枪 → 下一夜
 *   胜负：屠边（狼人杀光所有神职 或 所有平民即获胜） / 好人杀光狼人获胜
 *
 * 人类主持人只负责点按钮推进，所有判定都在这里。
 */
import {
  parseIntent, parseSeatNumbers, ROLES,
  isWolfRole, isGodRole, isVillagerRole, saysNo,
} from './channels.js';
import { uid } from './store.js';

/* ========================== 座位与身份 ========================== */

/** 默认：标准 12 人局「预女猎白」 */
export const DEFAULT_ROLE_PLAN = [
  'wolf', 'wolf', 'wolf', 'wolf',
  'seer', 'witch', 'hunter', 'idiot',
  'villager', 'villager', 'villager', 'villager',
];

/** 常见板子预设（UI 里可直接选） */
export const ROLE_PRESETS = [
  {
    id: 'std12',
    name: '12人标准局 · 预女猎白',
    desc: '4狼 + 预言家/女巫/猎人/白痴 + 4平民（最经典）',
    plan: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'],
  },
  {
    id: 'guard12',
    name: '12人守卫局 · 预女猎守',
    desc: '4狼 + 预言家/女巫/猎人/守卫 + 4平民',
    plan: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'],
  },
  {
    id: 'wolfking12',
    name: '12人狼王守卫局',
    desc: '狼王+3狼 + 预言家/女巫/猎人/守卫 + 4平民',
    plan: ['wolfking', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'],
  },
  {
    id: 'whitewolf12',
    name: '12人白狼王守卫局',
    desc: '白狼王+3狼 + 预言家/女巫/猎人/守卫 + 4平民',
    plan: ['whitewolfking', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'],
  },
  {
    id: 'std9',
    name: '9人局 · 预女猎',
    desc: '3狼 + 预言家/女巫/猎人 + 3平民',
    plan: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'],
  },
  {
    id: 'std6',
    name: '6人新手局',
    desc: '2狼 + 预言家/女巫 + 2平民（人少跑得快）',
    plan: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'],
  },
];

const AVATARS = ['🦊', '🐼', '🦉', '🐙', '🦄', '🐧', '🐯', '🐨', '🦁', '🐸', '🐵', '🐝', '🦋', '🐺', '🐰', '🐻'];
const COLORS = ['#4f8ef7', '#e6739f', '#f2994a', '#27ae60', '#9b51e0', '#00b4d8', '#eb5757', '#6fcf97'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 重置座位并重新洗身份。
 *
 * ★ 分配方式：
 *   - assignMode = 'random'（默认）：把 rolePlan 洗牌后依次发给座位，谁是什么身份全看运气
 *   - assignMode = 'manual'：rolePlan **按座位顺序原样落座**，即 rolePlan[i] 就是 (i+1) 号的身份
 *     （主持人可在「开新一局」里逐个指定，也可以在座位上事后用「编辑」改）
 *
 * 注意：只动 seats 和 game，**不碰 channels** —— 频道是房子，永远不拆。
 */
export function setupSeats(store, { rolePlan = DEFAULT_ROLE_PLAN, agentIds = [], names = [], assignMode = 'random' } = {}) {
  const roles = assignMode === 'manual' ? rolePlan.slice() : shuffle(rolePlan);
  const seats = roles.map((role, i) => {
    const agent = agentIds.length ? store.getAgent(agentIds[i % agentIds.length]) : null;
    return {
      id: `seat_${i + 1}`,
      number: i + 1,
      name: names[i] || agent?.name || `玩家${i + 1}`,
      avatar: agent?.avatar || AVATARS[i % AVATARS.length],
      color: agent?.color || COLORS[i % COLORS.length],
      role,
      alive: true,
      deathDay: null,
      deathReason: null,
      agentId: agent ? agent.id : null,
      /* --- 各角色的私有状态 --- */
      antidote: true,      // 女巫解药
      poison: true,        // 女巫毒药
      guardLast: null,     // 守卫上一晚守的人（不能连守）
      revealed: false,     // 白痴是否已翻牌
      canVote: true,       // 白痴翻牌后失去投票权
      gunUsed: false,      // 猎人/狼王是否已用过枪
    };
  });
  store.setSeats(seats);
  store.updateGame({
    phase: 'setup',
    assignMode: assignMode === 'manual' ? 'manual' : 'random',
    day: 1,
    nightStep: null,
    dayStep: null,
    winner: null,
    pendingKill: null,
    pendingGuard: null,
    pendingPoison: null,
    pendingShot: null,
    pendingLastWords: [],
    pendingBadge: null,
    sheriffId: null,
    candidates: [],
    pkCandidates: [],
    votePK: null,
    sheriffSummarized: false,
    campaignDone: false,
    savedThisNight: false,
    witchUsedThisNight: false,
    speakOrder: [],
    speakIndex: 0,
    markers: {},
    lastNightReport: null,
    startedAt: Date.now(),
    endedAt: null,
  });
  return seats;
}

/* ========================== 死亡处理（统一入口） ========================== */
/**
 * ★ 所有死亡都必须走这里，才能保证：
 *   · 死亡原因/天数记录一致
 *   · 出局的是警长时自动登记"待移交警徽"
 *   · 需要遗言的人被正确排队
 */
function killSeat(store, seat, reason, { canShoot = true, lastWords = false } = {}) {
  if (!seat || !seat.alive) return null;
  const g = store.data.game;
  store.updateSeat(seat.id, { alive: false, deathDay: g.day, deathReason: reason });

  // 警长出局 → 登记待移交警徽（撕掉还是给人，由主持人那一步处理）
  if (g.sheriffId === seat.id) {
    store.updateGame({ pendingBadge: { seatId: seat.id, seatNumber: seat.number, name: seat.name, role: seat.role, reason } });
  }
  // 需要遗言的人排队
  if (lastWords) {
    const list = store.data.game.pendingLastWords || [];
    if (!list.some((x) => x.seatId === seat.id)) {
      list.push({ seatId: seat.id, seatNumber: seat.number, name: seat.name, role: seat.role, reason, day: g.day });
      store.updateGame({ pendingLastWords: list });
    }
  }
  return { seatId: seat.id, number: seat.number, name: seat.name, role: seat.role, reason, canShoot };
}

/** 判断某个死因是否享有遗言（全部可在设置里改） */
export function lastWordsAllowed(store, seat, reason) {
  const rule = store.settings.lastWords || {};
  const day = store.data.game.day;
  if (reason === '被投票放逐') return rule.votedOut !== false;
  if (reason === '被女巫毒杀') return rule.poisoned !== false;
  if (/被(猎人|狼王)开枪带走/.test(reason)) return rule.shot === true;
  if (/自爆/.test(reason)) return rule.exploded === true;
  // 被狼刀 / 同守同救
  return day === 1 ? rule.firstNight !== false : rule.laterNights === true;
}

/**
 * ★ 白天推进顺序（把"谁还能说话"这件事完全交给这一个函数决定）：
 *   遗言 → 警徽移交 → 开枪 → 上警 → 警长投票 → 正式发言
 *   （遗言与开枪的先后由设置 lastWordsOrder 决定）
 */
export function advanceDayStep(store) {
  const db = store.data;
  const g = db.game;
  const s = store.settings;
  const hasLW = (g.pendingLastWords || []).length > 0;
  const hasBadge = !!g.pendingBadge;
  const hasShot = !!g.pendingShot;
  const hasCandidates = (g.candidates || []).length > 0;
  const hasPK = (g.pkCandidates || []).length > 0;
  // 第 1 天、还没上过警、也还没产生候选人 → 进入上警环节
  const needCampaign = s.sheriffEnabled !== false && !g.campaignDone && !hasCandidates && !hasPK && !g.sheriffId && g.day === 1;
  // 已经有候选人了但还没选出警长 → 进入警长投票
  const needSheriffVote = !g.campaignDone && hasCandidates && !hasPK && !g.sheriffId;
  // 警长竞选平票 → PK 发言 + 重投
  const needPK = !g.campaignDone && hasPK && !g.sheriffId;

  // 顺序：遗言 → 警徽 → 开枪（遗言与开枪的先后可配，警徽跟在遗言后面）
  const order = (s.lastWordsOrder === 'afterShot'
    ? ['shot', 'lastwords', 'badge']
    : ['lastwords', 'badge', 'shot']
  ).concat(['campaign', 'sheriffVote', 'sheriffPK']);

  for (const step of order) {
    if (step === 'lastwords' && hasLW) return setDayStep(store, 'lastwords');
    if (step === 'badge' && hasBadge) return setDayStep(store, 'badge');
    if (step === 'shot' && hasShot) return setDayStep(store, 'shot');
    if (step === 'campaign' && needCampaign) return setDayStep(store, 'campaign');
    if (step === 'sheriffVote' && needSheriffVote) return setDayStep(store, 'sheriffVote');
    if (step === 'sheriffPK' && needPK) return setDayStep(store, 'sheriffPK');
  }
  // 今天的投票已经走完 → 只剩"进入下一夜"
  if (g.voteDone) return setDayStep(store, 'done');
  return setDayStep(store, 'speak');
}

function setDayStep(store, step) {
  store.updateGame({ dayStep: step });
  return step;
}

/* ========================== 遗言 ========================== */
export function nextLastWords(store) {
  const list = store.data.game.pendingLastWords || [];
  return list.length ? list[0] : null;
}

/** 某位死者的遗言说完了 → 出队 → 推进到下一个步骤 */
export function completeLastWords(store) {
  const list = store.data.game.pendingLastWords || [];
  list.shift();
  store.updateGame({ pendingLastWords: list });
  return advanceDayStep(store);
}

/* ========================== 警长 ========================== */
export const getSheriff = (db) => (db.game.sheriffId ? db.seats.find((s) => s.id === db.game.sheriffId) || null : null);

/** 上警发言结束后，从发言里解析出候选人 */
export function collectCandidates(store) {
  const db = store.data;
  const lobby = store.getChannel('lobby');
  const msgs = (lobby.messages || []).filter((m) => m.meta?.reason === 'campaign' && m.role === 'ai');
  const candidates = [];
  const seen = new Set();
  for (const m of msgs) {
    const text = m.content || '';
    if (/(不上警|不参与|不竞选|不当警长|不选警长|放弃上警)/.test(text)) continue;
    if (!/(上警|竞选|我想当警长|我要当警长|选我当警长)/.test(text)) continue;
    if (!m.seatId || seen.has(m.seatId)) continue;
    const seat = store.getSeat(m.seatId);
    if (!seat || !seat.alive) continue;
    seen.add(m.seatId);
    candidates.push({ seatId: seat.id, number: seat.number, name: seat.name });
  }
  store.updateGame({ candidates, campaignDone: candidates.length === 0 });
  return candidates;
}

/** 警长竞选计票（候选人不能投票）。可指定统计区间与可选候选人（PK 重投时用） */
export function tallySheriffVotes(store, { from, allowedNumbers } = {}) {
  const db = store.data;
  const lobby = store.getChannel('lobby');
  const start = from ?? db.game.markers?.sheriffVoteFrom ?? 0;
  const allowed = new Set(
    allowedNumbers || (db.game.candidates || []).map((c) => c.number)
  );
  const candidateSeatIds = new Set(
    (db.game.candidates || []).filter((c) => allowed.has(c.number)).map((c) => c.seatId)
  );
  const msgs = (lobby.messages || []).slice(start).filter((m) => m.role === 'ai');
  const counts = new Map();
  const detail = [];
  const voted = new Set();
  for (const m of msgs) {
    if (!m.seatId || candidateSeatIds.has(m.seatId) || voted.has(m.seatId)) continue;
    const voter = store.getSeat(m.seatId);
    if (!canSeatVote(voter)) continue;
    const target = parseIntent(m.content, ['投', '投票', '选', '支持']) ?? parseSeatNumbers(m.content).slice(-1)[0];
    if (!target || !allowed.has(target)) continue;
    voted.add(m.seatId);
    counts.set(target, (counts.get(target) || 0) + 1);
    detail.push({ voterNumber: voter.number, target });
  }
  let top = null;
  let max = 0;
  let tie = false;
  for (const [t, c] of counts) {
    if (c > max) { max = c; top = t; tie = false; }
    else if (c === max) tie = true;
  }
  return {
    counts: [...counts.entries()].map(([target, count]) => ({ target, count })),
    detail,
    top,
    max,
    tie,
  };
}

/** 警徽移交 / 撕警徽 */
export function transferBadge(store, targetNumber) {
  const db = store.data;
  const pending = db.game.pendingBadge;
  if (!pending) return { ok: false, error: '当前没有待处理的警徽' };
  if (targetNumber === null || targetNumber === 0) {
    store.updateGame({ sheriffId: null, pendingBadge: null });
    hostSay(store, 'lobby', `🏅 ${pending.seatNumber}号 ${pending.name} 撕掉了警徽，本局不再有警长。`, { badge: true });
    return { ok: true, torn: true };
  }
  const target = store.getSeatByNumber(Number(targetNumber));
  if (!target || !target.alive) return { ok: false, error: '警徽只能交给存活玩家' };
  store.updateGame({ sheriffId: target.id, pendingBadge: null });
  hostSay(store, 'lobby', `🏅 ${pending.seatNumber}号 ${pending.name} 把警徽移交给了 ${target.number}号 ${target.name}。`, { badge: true });
  return { ok: true, target };
}

/** 警长指定发言顺序：把队列旋转到从某人开始，支持顺时针 / 逆时针 */
export function setSpeakOrderFrom(store, startNumber, direction = 'cw') {
  const db = store.data;
  const alive = aliveSeats(db);
  const startIdx = alive.findIndex((s) => s.number === Number(startNumber));
  if (startIdx < 0) return { ok: false, error: '指定的玩家不在场或已出局' };
  let seq = alive.slice(startIdx).concat(alive.slice(0, startIdx));
  if (direction === 'ccw') {
    // 逆时针 = 从起点开始按座位号倒序
    seq = [seq[0]].concat(seq.slice(1).reverse());
  }
  store.updateGame({ speakOrder: seq.map((s) => s.id), speakIndex: 0 });
  return { ok: true, direction, order: seq.map((s) => s.number) };
}

/** 警长归票：投票前的总结发言（每天一次） */
export function markSheriffSummarized(store) {
  store.updateGame({ sheriffSummarized: true });
}

/* ========================== 查询 ========================== */
export const aliveSeats = (db) => db.seats.filter((s) => s.alive);
export const aliveWolves = (db) => db.seats.filter((s) => s.alive && isWolfRole(s.role));
export const aliveGods = (db) => db.seats.filter((s) => s.alive && isGodRole(s.role));
export const aliveVillagers = (db) => db.seats.filter((s) => s.alive && isVillagerRole(s.role));
export const seatLabel = (seat) => (seat ? `${seat.number}号 ${seat.name}` : '（未知玩家）');
export const findSeatByRole = (db, role) => db.seats.find((s) => s.role === role);

/** 该座位是否还能投票（白痴翻牌后不能） */
export const canSeatVote = (seat) => !!seat && seat.alive && seat.canVote !== false;

/**
 * 胜负判定（屠边规则）：
 *   好人胜：狼人全部出局
 *   狼人胜：所有神职出局 或 所有平民出局（屠边）；或狼人数 ≥ 好人数（兜底）
 */
export function checkWinner(db, { rule = 'side' } = {}) {
  const wolves = aliveWolves(db).length;
  const gods = aliveGods(db).length;
  const villagers = aliveVillagers(db).length;
  if (wolves === 0) return 'good';
  if (rule === 'side') {
    if (gods === 0 || villagers === 0) return 'wolf';
  }
  if (wolves >= gods + villagers) return 'wolf';
  return null;
}

/** 给 UI 用的局势统计 */
export function situation(db) {
  return {
    alive: aliveSeats(db).length,
    wolves: aliveWolves(db).length,
    gods: aliveGods(db).length,
    villagers: aliveVillagers(db).length,
    total: db.seats.length,
  };
}

/* ========================== 主持人发言 ========================== */
export function hostSay(store, channelId, content, meta = {}) {
  const msg = {
    id: uid('msg'),
    channelId,
    role: 'host',
    speakerName: store.settings.hostName || '主持人',
    content,
    status: 'done',
    createdAt: Date.now(),
    meta,
  };
  store.addMessage(channelId, msg);
  store.addHostLog({ action: 'say', channelId, content });
  return msg;
}

/* ========================== 夜晚 ========================== */
export function startNight(store) {
  const db = store.data;
  const day = db.game.phase === 'setup' ? 1 : db.game.day + 1;
  store.updateGame({
    phase: 'night',
    day,
    nightStep: 'guard',
    dayStep: null,
    pendingKill: null,
    pendingGuard: null,
    pendingPoison: null,
    pendingShot: null,
    pendingLastWords: [],
    savedThisNight: false,
    witchUsedThisNight: false,
    voteDone: false,
    lastNightReport: null,
    markers: {},
  });
  hostSay(store, 'lobby', `🌙 天黑请闭眼 —— 第 ${day} 夜开始。守卫请睁眼。`, { phase: 'night', day });
  return { day };
}

export function setNightStep(store, step) {
  store.updateGame({ nightStep: step });
  return step;
}

/** 解析守卫的守护目标（只看 from 之后的消息，避免把昨晚的重复算进来） */
export function resolveGuard(store, from = 0) {
  const ch = store.getChannel('guard');
  const msgs = (ch.messages || []).slice(from).filter((m) => m.role === 'ai');
  const guard = findSeatByRole(store.data, 'guard');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const n = parseIntent(msgs[i].content, ['守', '守护', '保护', '守住']);
    if (!n) continue;
    const seat = store.getSeatByNumber(n);
    if (!seat || !seat.alive) continue;
    // 规则：不能连续两晚守同一个人
    if (guard && guard.guardLast === seat.number) continue;
    store.updateGame({ pendingGuard: seat.number });
    if (guard) store.updateSeat(guard.id, { guardLast: seat.number });
    return { number: seat.number, seat, blocked: false };
  }
  store.updateGame({ pendingGuard: null });
  return { number: null, blocked: msgs.length > 0 };
}

/**
 * 汇总狼人频道本轮的讨论，解析出今晚要刀谁。
 * 统计所有狼发言里"刀/杀 X号"出现的次数，取票数最高者；平票取最后一次提到的。
 */
export function resolveWolfKill(store) {
  const db = store.data;
  const ch = store.getChannel('wolf');
  const from = db.game.markers?.wolfFrom ?? 0;
  const msgs = (ch.messages || []).slice(from).filter((m) => m.role === 'ai');
  const tally = new Map();
  let last = null;
  const validTarget = (n) => {
    const s = store.getSeatByNumber(n);
    return s && s.alive && !isWolfRole(s.role) ? s : null;
  };
  for (const m of msgs) {
    const n = parseIntent(m.content, ['刀', '杀', '袭击', '杀掉', '干掉']);
    if (!n) continue;
    // ★ 只统计"合法刀口"（存活且不是狼）。无效目标不进票池，
    //   否则一句"刀一个已经死了的人"会把整晚的多数决带偏。
    if (!validTarget(n)) continue;
    tally.set(n, (tally.get(n) || 0) + 1);
    last = n;
  }
  let target = null;
  let max = 0;
  for (const [n, c] of tally) {
    if (c > max) { max = c; target = n; }
  }
  if (!target) target = last;
  const seat = target ? validTarget(target) : null;
  if (seat) {
    store.updateGame({ pendingKill: seat.number });
    return { number: seat.number, seat, parsed: true };
  }
  // 狼人这一晚没给出有效刀口
  if (store.settings.allowWolfNoKill) {
    store.updateGame({ pendingKill: null });
    return { number: null, seat: null, parsed: false, noKill: true };
  }
  const candidates = db.seats.filter((s) => s.alive && !isWolfRole(s.role));
  if (!candidates.length) {
    store.updateGame({ pendingKill: null });
    return { number: null, seat: null, parsed: false, noKill: true };
  }
  // ★ 兜底不再"随机"：取存活好人里座位号最小的，结果可复现、可复盘，
  //   并且用 fallback 标记让主持人在界面上看到"这不是狼队选的"。
  const pick = candidates.slice().sort((a, b) => a.number - b.number)[0];
  store.updateGame({ pendingKill: pick.number });
  return { number: pick.number, seat: pick, parsed: false, fallback: true };
}

/** 从预言家频道解析查验目标 */
export function resolveSeerCheck(store, from = 0) {
  const ch = store.getChannel('seer');
  const msgs = (ch.messages || []).slice(from).filter((m) => m.role === 'ai');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const n = parseIntent(msgs[i].content, ['验', '查验', '查', '看']);
    if (n) {
      const seat = store.getSeatByNumber(n);
      if (seat && seat.alive && seat.number !== msgs[i].seatNumber) {
        return { number: seat.number, seat, isWolf: isWolfRole(seat.role) };
      }
    }
  }
  return null;
}

/** 女巫决定解析：只看本轮（from 之后）的发言 */
export function resolveWitchDecision(store, from = 0) {
  const ch = store.getChannel('witch');
  const msgs = (ch.messages || []).slice(from).filter((m) => m.role === 'ai');
  const text = msgs.map((m) => m.content).join('\n');
  const last = msgs.length ? msgs[msgs.length - 1].content : '';

  const noSave = /(不救|不用解药|不用药|不使用解药|放弃解救|留着解药|不浪费解药|不必救)/.test(text);
  const yesSave = /(用解药|使用解药|我救|要救|救他|救她|救一下|用掉解药)/.test(text);
  const noPoison = /(不毒|不用毒|不使用毒药|不下毒|留着毒药|不用毒药)/.test(text);
  const poisonNumber = parseIntent(last, ['毒', '毒杀', '毒掉', '毒死']);

  const witch = findSeatByRole(store.data, 'witch');
  let save = !!yesSave && !noSave && !!witch && witch.antidote !== false;

  // 规则：女巫不能自救（可配置为"仅首夜可自救"）
  const killTarget = store.data.game.pendingKill;
  const selfSaveMode = store.settings.witchSelfSave || 'first-night';
  if (witch && save && killTarget === witch.number) {
    if (selfSaveMode === 'never') save = false;
    if (selfSaveMode === 'first-night' && store.data.game.day > 1) save = false;
  }
  // 规则：同一晚只能用一瓶药
  const usePoison = !noPoison && poisonNumber ? poisonNumber : null;
  if (save && usePoison && store.settings.onePotionPerNight !== false) {
    return { save, poison: null, raw: last, note: '同一晚只能用一瓶药，已按解药优先处理' };
  }
  return { save, poison: usePoison, raw: last };
}

/**
 * 结算夜晚：守护 / 狼刀 / 解药 / 毒药，处理"同守同救"，并登记死者能否开枪。
 */
export function resolveNight(store) {
  const db = store.data;
  const deaths = [];
  const killNumber = db.game.pendingKill;
  const guardNumber = db.game.pendingGuard;
  const poisonNumber = db.game.pendingPoison;
  const savedByWitch = !!db.game.savedThisNight && !!killNumber;

  // ① 狼刀是否生效
  const sameGuardAndSave = !!(guardNumber && killNumber && guardNumber === killNumber && savedByWitch);
  const guardBlocks = !!(guardNumber && killNumber && guardNumber === killNumber && !sameGuardAndSave);
  let wolfKillDied = false;
  let killNote = '';
  if (killNumber) {
    if (sameGuardAndSave && store.settings.sameGuardAndSaveDies !== false) {
      wolfKillDied = true;
      killNote = '同守同救，反而死亡';
    } else if (guardBlocks) {
      wolfKillDied = false;
      killNote = '被守卫守住，免于狼刀';
    } else if (savedByWitch) {
      wolfKillDied = false;
      killNote = '被女巫用解药救下';
    } else {
      wolfKillDied = true;
    }
  }

  // 死亡的统一入口：自动处理遗言排队与警徽移交登记
  const pushDeath = (seat, reason, canShoot) => {
    if (!seat || !seat.alive) return;
    const lw = lastWordsAllowed(store, seat, reason);
    const entry = killSeat(store, seat, reason, { canShoot, lastWords: lw });
    if (entry) deaths.push({ ...entry, lastWords: lw });
  };

  if (killNumber && wolfKillDied) pushDeath(store.getSeatByNumber(killNumber), '被狼人杀害', true);
  if (poisonNumber) pushDeath(store.getSeatByNumber(poisonNumber), '被女巫毒杀', false);

  // ③ 消耗药水
  const witch = findSeatByRole(db, 'witch');
  if (witch) {
    const patch = {};
    if (savedByWitch && witch.antidote) patch.antidote = false;
    if (poisonNumber && witch.poison) patch.poison = false;
    if (Object.keys(patch).length) store.updateSeat(witch.id, patch);
  }

  // ④ 登记"出局可开枪"的角色（猎人 / 狼王）
  const shooters = deaths.filter((d) => d.canShoot && (d.role === 'hunter' || d.role === 'wolfking'));
  let pendingShot = null;
  if (shooters.length) {
    const s = shooters[0];
    const seat = store.getSeatByNumber(s.number);
    if (seat && !seat.gunUsed) {
      pendingShot = { seatId: seat.id, seatNumber: seat.number, name: seat.name, role: seat.role, reason: s.reason };
    }
  }

  const report = {
    day: db.game.day,
    deaths,
    saved: savedByWitch && !sameGuardAndSave,
    guarded: guardNumber,
    guardBlocked: guardBlocks,
    sameGuardAndSave,
    killNote,
    killNumber: killNumber || null,
    poisonNumber: poisonNumber || null,
    peaceful: deaths.length === 0,
  };
  store.updateGame({ nightStep: 'resolve', lastNightReport: report, pendingShot });
  return report;
}

/* ========================== 开枪 / 翻牌 / 自爆 ========================== */
/**
 * 执行猎人 / 狼王开枪：结算目标死亡，清掉待开枪状态。
 * 目标必须是存活玩家，不能打自己。
 */
export function resolveShot(store, targetNumber) {
  const db = store.data;
  const pending = db.game.pendingShot;
  if (!pending) return { ok: false, error: '当前没有待执行的开枪' };
  const shooter = store.getSeat(pending.seatId);
  const target = store.getSeatByNumber(Number(targetNumber));
  if (!target || !target.alive) return { ok: false, error: '开枪目标无效' };
  if (target.id === pending.seatId) return { ok: false, error: '不能带走自己' };

  const roleName = ROLES[pending.role]?.name || pending.role;
  hostSay(store, 'lobby', `🔫 ${pending.seatNumber}号 ${pending.name}（${roleName}）开枪带走了 ${target.number}号 ${target.name}！`, {
    phase: db.game.phase,
    shot: true,
  });
  const reason = `被${roleName}开枪带走`;
  const lw = lastWordsAllowed(store, target, reason);
  killSeat(store, target, reason, { canShoot: true, lastWords: lw });
  if (shooter) store.updateSeat(shooter.id, { gunUsed: true });
  store.updateGame({ pendingShot: null });

  const winner = checkWinner(db, { rule: store.settings.winRule });
  return {
    ok: true,
    target,
    lastWords: lw,
    winner: winner ? endGame(store, winner) : null,
    nextStep: winner ? null : advanceDayStep(store),
  };
}

/** 猎人/狼王放弃开枪 */
export function skipShot(store) {
  const pending = store.data.game.pendingShot;
  if (!pending) return { ok: false, error: '当前没有待执行的开枪' };
  const shooter = store.getSeat(pending.seatId);
  if (shooter) store.updateSeat(shooter.id, { gunUsed: true });
  hostSay(store, 'lobby', `🔫 ${pending.seatNumber}号 ${pending.name} 没有开枪。`, { shot: true });
  store.updateGame({ pendingShot: null });
  const winner = checkWinner(store.data, { rule: store.settings.winRule });
  return { ok: true, winner: winner ? endGame(store, winner) : null, nextStep: winner ? null : advanceDayStep(store) };
}

/**
 * 白狼王自爆：自爆者出局 + 带走一人，直接进入黑夜。
 */
export function whiteWolfExplode(store, targetNumber) {
  const db = store.data;
  const exploder = db.seats.find((s) => s.alive && s.role === 'whitewolfking');
  if (!exploder) return { ok: false, error: '没有存活的白狼王' };
  const target = store.getSeatByNumber(Number(targetNumber));
  if (!target || !target.alive) return { ok: false, error: '自爆目标无效' };

  hostSay(store, 'lobby', `💥 ${exploder.number}号 ${exploder.name} 自爆了！狼人自爆，带走 ${target.number}号 ${target.name}，直接进入黑夜。`, { explode: true });
  killSeat(store, exploder, '白狼王自爆', { canShoot: false, lastWords: lastWordsAllowed(store, exploder, '白狼王自爆') });
  killSeat(store, target, '被白狼王自爆带走', { canShoot: false, lastWords: lastWordsAllowed(store, target, '被白狼王自爆带走') });
  store.updateGame({ phase: 'night', nightStep: 'guard' });

  const winner = checkWinner(db, { rule: store.settings.winRule });
  if (winner) return { ok: true, exploder, target, winner: endGame(store, winner) };
  // 自爆后直接进入新的夜晚
  const info = startNight(store);
  return { ok: true, exploder, target, nextNight: info };
}

/** 白痴翻牌：被投票放逐时翻牌不死，但失去投票权 */
export function idiotFlip(store, seat) {
  store.updateSeat(seat.id, { alive: true, revealed: true, canVote: false, deathReason: null });
  hostSay(store, 'lobby', `🃏 ${seat.number}号 ${seat.name} 翻开身份牌 —— 他是【白痴】！不死亡，但从此失去投票权（仍可发言）。`, {
    reveal: true,
    idiot: true,
  });
  return { flipped: true, seat };
}

/* ========================== 白天 ========================== */
export function startDay(store) {
  const db = store.data;
  const report = db.game.lastNightReport || { deaths: [], peaceful: true, day: db.game.day };

  if (report.peaceful) {
    hostSay(store, 'lobby', `☀️ 天亮了 —— 第 ${db.game.day} 天。昨晚是个平安夜，没有人死亡。`, { phase: 'day' });
  } else {
    const list = report.deaths.map((d) => `${d.number}号 ${d.name}`).join('、');
    hostSay(store, 'lobby', `☀️ 天亮了 —— 第 ${db.game.day} 天。昨晚死亡的是：${list}。（不公布身份）`, { phase: 'day' });
  }

  const alive = aliveSeats(db);
  const order = alive.map((s) => s.id);
  const rotate = order.length ? (db.game.day - 1) % order.length : 0;
  const speakOrder = order.slice(rotate).concat(order.slice(0, rotate));

  store.updateGame({ phase: 'day', nightStep: null, speakOrder, speakIndex: 0, voteDone: false, sheriffSummarized: false, pkCandidates: [], votePK: null });

  // ★ 用统一的状态机决定"接下来该谁说话"：遗言 → 警徽 → 开枪 → 上警 → 警长投票 → 发言
  const step = advanceDayStep(store);
  const g = store.data.game;
  const notes = [];
  if ((g.pendingLastWords || []).length) notes.push(`${g.pendingLastWords.map((x) => x.seatNumber + '号').join('、')} 需要留遗言`);
  if (g.pendingBadge) notes.push(`警徽需要处理（${g.pendingBadge.seatNumber}号出局）`);
  if (g.pendingShot) notes.push(`${g.pendingShot.seatNumber}号 ${g.pendingShot.name} 需要开枪`);
  if (step === 'campaign') notes.push('进入警长竞选：所有存活玩家依次表态是否上警');
  if (notes.length) hostSay(store, 'lobby', `📋 接下来的流程：${notes.join('；')}。`, { phase: 'day', step });

  const winner = checkWinner(db, { rule: store.settings.winRule });
  if (winner) return endGame(store, winner);
  return { order: speakOrder, step, first: step === 'speak' ? store.getSeat(speakOrder[0]) : null, notes };
}

export function nextSpeaker(store) {
  const db = store.data;
  const order = db.game.speakOrder?.length ? db.game.speakOrder : aliveSeats(db).map((s) => s.id);
  let idx = db.game.speakIndex || 0;
  while (idx < order.length) {
    const seat = store.getSeat(order[idx]);
    idx++;
    if (seat && seat.alive) {
      store.updateGame({ speakIndex: idx });
      return seat;
    }
  }
  store.updateGame({ speakIndex: idx });
  return null;
}

/**
 * ★ 发言队列快照：谁已经说过、现在轮到谁、还有谁在等。
 * 主持人界面用它显示"发言顺序"，避免出现抢麦/漏麦的观感。
 */
export function speakQueue(store) {
  const db = store.data;
  const order = db.game.speakOrder?.length ? db.game.speakOrder : aliveSeats(db).map((s) => s.id);
  const idx = db.game.speakIndex || 0;

  // 当前该发言的位置：从 idx 往后第一个存活的人
  let currentIdx = -1;
  for (let i = idx; i < order.length; i++) {
    if (store.getSeat(order[i])?.alive) { currentIdx = i; break; }
  }

  const list = order
    .map((id, i) => {
      const seat = store.getSeat(id);
      if (!seat) return null;
      return {
        number: seat.number,
        name: seat.name,
        alive: !!seat.alive,
        state: !seat.alive ? 'dead' : i < idx ? 'spoken' : i === currentIdx ? 'current' : 'waiting',
      };
    })
    .filter(Boolean);

  return {
    list,
    index: idx,
    total: list.length,
    aliveTotal: list.filter((x) => x.alive).length,
    spokenCount: list.filter((x) => x.state === 'spoken').length,
    finished: currentIdx === -1,
  };
}

/* ========================== 狼人自爆（任意狼人，白天） ========================== */
/**
 * 规则：白天任意时刻，狼人可以翻牌自爆 ——
 *   · 自爆的狼人立即出局，**没有遗言**
 *   · 白天立即中止（未完成的发言/投票/遗言/开枪全部作废），直接进入黑夜
 *   · 如果自爆发生在警长竞选阶段 → 警徽流失，本局没有警长
 */
export function wolfExplode(store, seatNumber) {
  const db = store.data;
  const seat = store.getSeatByNumber(Number(seatNumber));
  if (!seat || !seat.alive) return { ok: false, error: '目标无效或已出局' };
  if (!isWolfRole(seat.role)) return { ok: false, error: '只有狼人可以自爆' };

  const duringCampaign = ['campaign', 'sheriffVote', 'sheriffPK'].includes(db.game.dayStep);
  hostSay(store, 'lobby', `💥 ${seat.number}号 ${seat.name} 翻牌自爆 —— 他是狼人！白天立即结束，直接进入黑夜。`, {
    explode: true,
    selfDestruct: true,
  });

  // 自爆没有遗言
  killSeat(store, seat, '狼人自爆', { canShoot: true, lastWords: false });

  if (duringCampaign) {
    hostSay(store, 'lobby', '（自爆发生在警长竞选阶段 → 警徽流失，本局没有警长）', { badge: true });
    store.updateGame({ campaignDone: true, candidates: [], pkCandidates: [], votePK: null, sheriffId: null });
  }
  // 中止白天：遗言/开枪/投票全部作废，直接入夜
  store.updateGame({
    phase: 'night',
    nightStep: 'guard',
    dayStep: null,
    day: db.game.day,
    votePK: null,
    voteDone: false,
    markers: {},
  });

  const winner = checkWinner(db, { rule: store.settings.winRule });
  if (winner) return { ok: true, seat, campaignLost: duringCampaign, winner: endGame(store, winner) };
  const info = startNight(store);
  return { ok: true, seat, campaignLost: duringCampaign, nextNight: info };
}

/* ========================== 退水（放弃警长竞选） ========================== */
/**
 * 规则：上警的人可以在投票前退水，退水后不再参与本次竞选，**转为警下、可以投票**。
 */
export function withdrawCandidate(store, seatNumber) {
  const db = store.data;
  const cands = (db.game.candidates || []).slice();
  const idx = cands.findIndex((c) => c.number === Number(seatNumber));
  if (idx < 0) return { ok: false, error: '该玩家不在候选人名单里' };
  const [removed] = cands.splice(idx, 1);
  store.updateGame({ candidates: cands, campaignDone: cands.length === 0 ? true : db.game.campaignDone });
  hostSay(store, 'lobby', `🙋 ${removed.number}号 ${removed.name} 退水，放弃竞选警长（转为警下，可以投票）。`, {
    badge: true,
    withdraw: true,
  });
  if (!cands.length) {
    hostSay(store, 'lobby', '🏅 所有候选人都退水了，本局没有警长。', { badge: true });
  }
  return { ok: true, removed, remaining: cands.map((c) => c.number) };
}

/* ========================== 投票 ========================== */
export function startVote(store) {
  const db = store.data;
  const lobby = store.getChannel('lobby');
  store.updateGame({
    phase: 'vote',
    markers: { ...(db.game.markers || {}), voteFrom: (lobby.messages || []).length },
  });
  const voters = aliveSeats(db).filter(canSeatVote);
  hostSay(store, 'lobby', `🗳 投票环节开始 —— ${voters.length} 位有投票权的玩家请投出你要放逐的人，格式：投票：X号`, { phase: 'vote' });
  return { from: (lobby.messages || []).length };
}

/** 统计投票：每个有投票权的存活玩家在本轮投票区间里的最后一条发言算数 */
export function tallyVotes(store, { from, allowed, excludeVoterIds } = {}) {
  const db = store.data;
  const lobby = store.getChannel('lobby');
  const start = from ?? db.game.markers?.voteFrom ?? 0;
  const allowedSet = allowed ? new Set(allowed.map(Number)) : null;
  const excluded = new Set(excludeVoterIds || []);
  const msgs = (lobby.messages || []).slice(start).filter((m) => m.role === 'ai');

  const bySeat = new Map();
  for (const m of msgs) {
    if (!m.seatId || excluded.has(m.seatId)) continue;
    const voter = store.getSeat(m.seatId);
    if (!canSeatVote(voter)) continue;
    const target =
      parseIntent(m.content, ['投票', '投', '放逐', '票', '出']) ??
      parseSeatNumbers(m.content).slice(-1)[0] ??
      null;
    if (!target) continue;
    if (allowedSet && !allowedSet.has(target)) continue;
    bySeat.set(m.seatId, target);
  }

  const counts = new Map();
  const detail = [];
  // ★ 警长票权 1.5
  const weightOf = (seatId) => (db.game.sheriffId && db.game.sheriffId === seatId ? 1.5 : 1);
  for (const [seatId, target] of bySeat) {
    const voter = store.getSeat(seatId);
    const w = weightOf(seatId);
    counts.set(target, (counts.get(target) || 0) + w);
    detail.push({ voterNumber: voter.number, voterName: voter.name, target, weight: w, sheriff: w > 1 });
  }

  let top = null;
  let max = 0;
  let tie = false;
  for (const [target, c] of counts) {
    if (c > max) { max = c; top = target; tie = false; }
    else if (c === max) tie = true;
  }
  const topSeat = top ? store.getSeatByNumber(top) : null;
  if (!topSeat || !topSeat.alive) { top = null; tie = false; }

  const notVoted = aliveSeats(db).filter(canSeatVote).filter((s) => !bySeat.has(s.id) && !excluded.has(s.id)).map((s) => s.number);
  return {
    counts: [...counts.entries()].map(([target, c]) => ({ target, count: c })),
    detail,
    top,
    max,
    tie,
    notVoted,
  };
}

/** 把某个玩家放逐出局（投票 / PK 重投共用） */
function exileSeat(store, seat, result) {
  const db = store.data;

  // —— 白痴：被投票放逐时翻牌不死，但失去投票权 ——
  if (seat.role === 'idiot' && !seat.revealed) {
    idiotFlip(store, seat);
    store.updateGame({ phase: 'day', voteDone: true, votePK: null });
    return { exiled: null, result, flipped: seat, nextStep: advanceDayStep(store) };
  }

  const reason = '被投票放逐';
  const lw = lastWordsAllowed(store, seat, reason);
  killSeat(store, seat, reason, { canShoot: true, lastWords: lw });
  const detail = result.detail.map((d) => `${d.voterNumber}号→${d.target}号${d.sheriff ? '(警长1.5票)' : ''}`).join('，');
  hostSay(store, 'lobby', `⚖️ ${seat.number}号 ${seat.name} 被投票放逐出局（${result.max} 票，明细：${detail}）。身份是【${ROLES[seat.role].name}】。`, {
    phase: 'vote',
    reveal: true,
  });

  let pendingShot = null;
  if ((seat.role === 'hunter' || seat.role === 'wolfking') && !seat.gunUsed) {
    pendingShot = { seatId: seat.id, seatNumber: seat.number, name: seat.name, role: seat.role, reason };
    store.updateGame({ pendingShot });
  }
  store.updateGame({ phase: 'day', voteDone: true, votePK: null });

  const winner = checkWinner(db, { rule: store.settings.winRule });
  return {
    exiled: seat,
    result,
    pendingShot,
    lastWords: lw,
    nextStep: winner ? null : advanceDayStep(store),
    winner: winner ? endGame(store, winner) : null,
  };
}

/** 平票 → 进入 PK：平票的人依次申辩，之后由其他人重投 */
function startExilePK(store, result) {
  const db = store.data;
  const tied = result.counts.filter((c) => c.count === result.max).map((c) => c.target);
  const lobby = store.getChannel('lobby');
  store.updateGame({
    votePK: { candidates: tied },
    markers: { ...(db.game.markers || {}), votePKFrom: (lobby.messages || []).length },
    dayStep: 'votePK',
    // ★ 这里必须把 phase 切回 day：前端的「PK 申辩 + 重投」按钮只画在白天分支里。
    //   之前只改了 dayStep 没改 phase，界面上仍然显示"计票并放逐"，
    //   再点一次还是平票 —— 主持人会卡在同一个死循环里出不来。
    phase: 'day',
  });
  hostSay(
    store,
    'lobby',
    `⚖️ 平票（${result.counts.map((c) => `${c.target}号${c.count}票`).join('、')}）—— 进入 PK：${tied.map((n) => `${n}号`).join('、')} 请依次申辩，之后由其他人重投。`,
    { phase: 'vote', pk: true }
  );
  return { tied, step: 'votePK' };
}

/**
 * 结算放逐投票。
 * revote = true 表示这是 PK 之后的重投（统计范围与可投对象都限定在平票者之间）
 */
export function resolveVote(store, { revote = false } = {}) {
  const db = store.data;
  const pk = db.game.votePK || null;
  const result = revote && pk
    ? tallyVotes(store, {
        from: db.game.markers?.votePKFrom ?? 0,
        allowed: pk.candidates,
        excludeVoterIds: pk.candidates.map((n) => store.getSeatByNumber(n)?.id).filter(Boolean),
      })
    : tallyVotes(store);

  const summary = result.detail.length
    ? result.detail.map((d) => `${d.voterNumber}号→${d.target}号`).join('，')
    : '（没有人有效投票）';
  hostSay(store, 'lobby', `${revote ? '🧾 PK 重投结果' : '🧾 计票结果'}：${summary}${result.notVoted.length ? `（未投票：${result.notVoted.join('、')}号）` : ''}`, { phase: 'vote' });

  if (!result.top) {
    hostSay(store, 'lobby', '本轮没有形成有效票数，无人被放逐（平安日）。', { phase: 'vote' });
    store.updateGame({ phase: 'day', voteDone: true, votePK: null });
    return { exiled: null, result, nextStep: advanceDayStep(store) };
  }

  if (result.tie) {
    // 第一次平票 → 进入 PK（标准规则）
    if (!revote && store.settings.tieRevote !== false) {
      const pkInfo = startExilePK(store, result);
      return { exiled: null, result, tie: true, pk: pkInfo };
    }
    // PK 之后再次平票 → 平安日
    hostSay(store, 'lobby', `PK 之后依然平票，本轮无人被放逐（平安日）。`, { phase: 'vote' });
    store.updateGame({ phase: 'day', voteDone: true, votePK: null });
    return { exiled: null, result, tie: true, peacefulDay: true, nextStep: advanceDayStep(store) };
  }

  return exileSeat(store, store.getSeatByNumber(result.top), result);
}

/* ========================== 结束 ========================== */
export function endGame(store, winner) {
  const db = store.data;
  const wolfList = db.seats.filter((s) => isWolfRole(s.role)).map((s) => `${s.number}号 ${s.name}(${ROLES[s.role].name})`).join('、');
  const text =
    winner === 'wolf'
      ? `🐺 游戏结束：狼人阵营获胜！（狼人：${wolfList}）`
      : `🎉 游戏结束：好人阵营获胜！（狼人：${wolfList}）`;
  store.updateGame({ phase: 'ended', winner, endedAt: Date.now() });
  hostSay(store, 'lobby', text, { phase: 'ended', winner });
  return { winner, text };
}

/** 主持人手动结束 */
export function hostEndGame(store) {
  const winner = checkWinner(store.data, { rule: store.settings.winRule }) || (aliveWolves(store.data).length ? 'wolf' : 'good');
  return endGame(store, winner);
}

export { ROLES, isWolfRole, isGodRole, isVillagerRole, parseIntent, saysNo };
