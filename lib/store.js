/**
 * 本地 JSON 存储层。
 *
 * 关键设计：channels（频道）与 seats（座位）是两种不同寿命的东西 ——
 *   · channels 是"房子"，ensureChannels() 只会在缺失时补齐，**永远不会重建或清空**；
 *   · seats 是"住客"，换 AI 模型只改 seat.agentId 一个字段，房子和里面的历史纹丝不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CHANNELS, ROLES } from './channels.js';

export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export const DEFAULT_DB = {
  version: 2,
  settings: {
    /** ★ 网络代理：Node 不会自动使用 Windows 系统代理，走 VPN 的用户需要在这里填（如 http://127.0.0.1:7890） */
    proxy: '',
    /** ★ 用户手动记住的模型名：{ "https://api.deepseek.com/v1": ["deepseek-v4.1-flash"] }
     *  服务商的 /models 接口经常滞后，新模型要允许手动登记才不会"选不到" */
    knownModels: {},
    hostName: '主持人',
    /** 默认观众视角：true = 只能看公共频道、看不到身份（主持人视角为 false） */
    audienceView: false,
    /**
     * ★ 智力总控：plain / smart / genius / custom。
     *   决定全局的上下文条数、单次输出预算、温度和额外推理要求；
     *   成员默认「跟随总控」，勾掉之后才用成员自己填的温度 / tokens。
     */
    aiLevel: 'smart',
    /** 下面的三项：aiLevel 为 custom 时用到，同时作为兜底值 */
    contextLimit: 60,
    maxTokens: 1600,
    temperature: 0.85,
    /** 平票时是否进行 PK 重投（标准规则开：PK 发言 → 重投 → 再平票则平安日） */
    tieRevote: true,
    /** 女巫能否自救：never（从不） / first-night（仅首夜，标准规则） / always（总是） */
    witchSelfSave: 'first-night',
    /** 同一晚只能用一瓶药（标准规则） */
    onePotionPerNight: true,
    /** 同守同救是否必死（标准规则开） */
    sameGuardAndSaveDies: true,
    /** 胜负规则：side = 屠边（杀光神职或平民） / all = 屠城（杀光所有好人） */
    winRule: 'side',
    /** 是否允许狼人夜晚空刀 */
    allowWolfNoKill: false,
    /** ★ 遗言规则：谁出局后还能公开发言一次 */
    lastWords: {
      firstNight: true,    // 首夜被狼刀 → 有遗言（标准）
      laterNights: false,  // 第二夜及以后被狼刀 → 无遗言（标准）
      votedOut: true,      // 白天被投票放逐 → 有遗言（标准）
      poisoned: false,     // 被女巫毒杀 → 无遗言（毒杀是无声的，且枪也失效）
      shot: false,         // 被猎人/狼王开枪带走 → 无遗言（标准）
      exploded: false,     // 被白狼王自爆带走 → 无遗言
    },
    /** 遗言与开枪的先后：beforeShot = 先遗言再开枪（默认） / afterShot = 先开枪再遗言 */
    lastWordsOrder: 'beforeShot',
    /** 是否启用警长（上警 → 竞选发言 → 投票选警长 → 1.5 票 + 决定发言顺序 + 移交警徽） */
    sheriffEnabled: true,
  },
  agents: [],
  /** ★ 持久频道：创建一次，终身存在，换人不重建 */
  channels: [],
  /** 座位（住客） */
  seats: [],
  game: {
    phase: 'setup', // setup | night | day | vote | ended
    /** 第几局（每开一局 +1，用于区分不同对局） */
    gameNo: 0,
    /** 身份是怎么分配的：random（默认，洗牌）/ manual（主持人逐个指定） */
    assignMode: 'random',
    day: 1,
    nightStep: null, // guard | wolf | seer | witch | resolve
    /** 白天的子步骤：lastwords → badge → shot → campaign → sheriffVote → speak → vote → done */
    dayStep: null,
    winner: null, // 'wolf' | 'good'
    pendingKill: null,
    pendingGuard: null,
    pendingPoison: null,
    pendingShot: null,
    /** 待发表遗言的队列 */
    pendingLastWords: [],
    /** 出局的警长：待移交警徽 */
    pendingBadge: null,
    /** 当前警长（seatId） */
    sheriffId: null,
    /** 上警候选人 */
    candidates: [],
    /** 放逐投票平票时的 PK 状态 { candidates: [座位号] } */
    votePK: null,
    /** 警长竞选平票的候选座位号 */
    pkCandidates: [],
    /** 今天警长是否已归票 */
    sheriffSummarized: false,
    campaignDone: false,
    savedThisNight: false,
    witchUsedThisNight: false,
    speakOrder: [],
    speakIndex: 0,
    markers: {},
    lastNightReport: null,
    startedAt: null,
    endedAt: null,
  },
  hostLog: [],
  /**
   * ★ 私信：主持人 ↔ 单个 AI 的私下问答。
   *   刻意**不放在任何频道里** —— 组装 prompt 只读频道，所以私信内容
   *   一个字都不会进入 AI 之后的发言，天然不影响它的布局和逻辑。
   *   开新一局时整段清空（每局独立，不带上一局的记忆）。
   */
  dms: [],
};

const MAX_MESSAGES_PER_CHANNEL = 2000;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULT_DB);
    this._timer = null;
    this.load();
    this.ensureChannels();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        ...structuredClone(DEFAULT_DB),
        ...parsed,
        settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) },
        game: { ...DEFAULT_DB.game, ...(parsed.game || {}) },
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        channels: Array.isArray(parsed.channels) ? parsed.channels : [],
        seats: Array.isArray(parsed.seats) ? parsed.seats : [],
      };
      for (const ch of this.data.channels) {
        if (!Array.isArray(ch.messages)) ch.messages = [];
        for (const m of ch.messages) {
          if (m.status === 'streaming') m.status = 'stopped';
        }
      }
      this.migrate(parsed.version);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[store] 读取失败：${err.message}（用空数据启动）`);
        try { fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`); } catch {}
      }
    }
  }

  /**
   * 配置迁移：老版本存下来的设置会覆盖新默认值，这里把语义变过的项纠正过来。
   *   v1 → v2：旧版没有"平票 PK"，tieRevote 默认 false；新标准规则改为 PK 重投，这里迁移成 true。
   */
  migrate(loadedVersion = 1) {
    const from = Number(loadedVersion) || 1;
    if (from >= DEFAULT_DB.version) return;
    const notes = [];
    if (from < 2) {
      this.data.settings.tieRevote = true;
      notes.push('平票处理改为标准 PK 重投');
    }
    this.data.version = DEFAULT_DB.version;
    this.save();
    if (notes.length) console.log(`[store] 已升级配置（v${from} → v${DEFAULT_DB.version}）：${notes.join('；')}`);
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 200);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // ★ 写新内容之前，先把上一版留一份（防止误删/写坏导致成员库和 API Key 全丢）
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.prev`);
      } catch { /* 备份失败不影响正常写入 */ }
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this.writeDailyBackup();
    } catch (err) {
      console.error(`[store] 写入失败：${err.message}`);
    }
  }

  /* ==================== ★ 备份：每天一份，保留最近 7 天 ==================== */
  backupDir() {
    return path.join(path.dirname(this.file), 'backup');
  }

  writeDailyBackup() {
    try {
      const dir = this.backupDir();
      fs.mkdirSync(dir, { recursive: true });
      const today = new Date();
      const name = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify(this.data, null, 2), 'utf8');
      const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 7))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    } catch { /* 备份是尽力而为，失败不影响主流程 */ }
  }

  /** 列出可用的备份（含 .prev 和按天备份） */
  listBackups() {
    const out = [];
    const prev = `${this.file}.prev`;
    if (fs.existsSync(prev)) {
      out.push(this.describeBackup('prev', '上一次保存前的状态', fs.statSync(prev)));
    }
    try {
      const dir = this.backupDir();
      for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().reverse()) {
        out.push(this.describeBackup(f, `${f.replace('.json', '')} 的每日备份`, fs.statSync(path.join(dir, f))));
      }
    } catch { /* 没有备份目录 */ }
    return out;
  }

  describeBackup(name, label, stat) {
    let info = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(name === 'prev' ? `${this.file}.prev` : path.join(this.backupDir(), name), 'utf8'));
      info = {
        agents: (parsed.agents || []).length,
        agentNames: (parsed.agents || []).map((a) => a.name).slice(0, 8),
        gameNo: parsed.game?.gameNo || 0,
        messages: (parsed.channels || []).reduce((n, c) => n + (c.messages || []).length, 0),
      };
    } catch { /* 读不出来就当空的 */ }
    return { name, label, size: stat.size, mtime: stat.mtime.toISOString(), ...info };
  }

  readBackup(name) {
    const file = name === 'prev' ? `${this.file}.prev` : path.join(this.backupDir(), path.basename(String(name)));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** 从某个备份里恢复成员库（只恢复 agents，不动当前对局） */
  restoreAgentsFromBackup(name) {
    const backup = this.readBackup(name);
    const agents = Array.isArray(backup.agents) ? backup.agents : [];
    if (!agents.length) return { ok: false, error: '这份备份里没有成员' };
    const existing = new Set(this.data.agents.map((a) => a.id));
    let added = 0;
    let updated = 0;
    for (const a of agents) {
      if (existing.has(a.id)) {
        const idx = this.data.agents.findIndex((x) => x.id === a.id);
        this.data.agents[idx] = { ...this.data.agents[idx], ...a };
        updated++;
      } else {
        this.data.agents.push(a);
        added++;
      }
    }
    this.flush();
    return { ok: true, added, updated, total: this.data.agents.length };
  }

  /* ==================== ★ 频道：只补不建，永不重建 ==================== */
  /**
   * 保证 4 个固定频道存在。已存在的频道**原样保留**（包括历史消息），
   * 只有缺失的才会被补上 —— 换 AI、换模型、开新一局都不会销毁频道。
   */
  ensureChannels() {
    let created = 0;
    for (const def of CHANNELS) {
      const exists = this.data.channels.find((c) => c.id === def.id);
      if (exists) {
        // 只同步展示用的元信息，绝不碰 messages
        exists.name = def.name;
        exists.icon = def.icon;
        exists.desc = def.desc;
        continue;
      }
      this.data.channels.push({
        id: def.id,
        name: def.name,
        icon: def.icon,
        desc: def.desc,
        createdAt: Date.now(),
        messages: [
          {
            id: uid('msg'),
            channelId: def.id,
            role: 'system',
            speakerName: '系统',
            content: `${def.icon} 频道已就绪：${def.desc}`,
            status: 'done',
            createdAt: Date.now(),
            meta: { system: true },
          },
        ],
      });
      created++;
    }
    if (created) this.save();
    return created;
  }

  get channels() {
    return this.data.channels;
  }

  getChannel(id) {
    return this.data.channels.find((c) => c.id === id) || null;
  }

  addMessage(channelId, message) {
    const ch = this.getChannel(channelId);
    if (!ch) return null;
    ch.messages.push(message);
    if (ch.messages.length > MAX_MESSAGES_PER_CHANNEL) {
      ch.messages.splice(0, ch.messages.length - MAX_MESSAGES_PER_CHANNEL);
    }
    this.save();
    return message;
  }

  getMessage(channelId, messageId) {
    return this.getChannel(channelId)?.messages.find((m) => m.id === messageId) || null;
  }

  /** 清空某个频道（只在主持人明确要求"重开"时用） */
  clearChannel(channelId) {
    const ch = this.getChannel(channelId);
    if (!ch) return false;
    ch.messages = [];
    this.save();
    return true;
  }

  clearAllChannels(reason = '主持人重开了一局') {
    for (const ch of this.data.channels) {
      ch.messages = [
        {
          id: uid('msg'),
          channelId: ch.id,
          role: 'system',
          speakerName: '系统',
          content: `🔄 ${reason}（频道本身保留，只是清空历史）`,
          status: 'done',
          createdAt: Date.now(),
          meta: { system: true },
        },
      ];
    }
    this.save();
  }

  /* ==================== 座位 ==================== */
  get seats() {
    return this.data.seats;
  }

  getSeat(id) {
    return this.data.seats.find((s) => s.id === id) || null;
  }

  getSeatByNumber(n) {
    return this.data.seats.find((s) => s.number === Number(n)) || null;
  }

  setSeats(seats) {
    this.data.seats = seats;
    this.save();
  }

  updateSeat(id, patch) {
    const seat = this.getSeat(id);
    if (!seat) return null;
    Object.assign(seat, patch, { id: seat.id });
    this.save();
    return seat;
  }

  /* ==================== 游戏状态 ==================== */
  get game() {
    return this.data.game;
  }

  updateGame(patch) {
    Object.assign(this.data.game, patch);
    this.save();
    return this.data.game;
  }

  /* ==================== 成员（AI 模型配置） ==================== */
  get agents() {
    return this.data.agents;
  }

  getAgent(id) {
    return this.data.agents.find((a) => a.id === id) || null;
  }

  addAgent(agent) {
    this.data.agents.push(agent);
    this.save();
    return agent;
  }

  updateAgent(id, patch) {
    const agent = this.getAgent(id);
    if (!agent) return null;
    Object.assign(agent, patch, { id: agent.id });
    this.save();
    return agent;
  }

  deleteAgent(id) {
    const idx = this.data.agents.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.data.agents.splice(idx, 1);
    // 座位上的 AI 被删掉：座位保留（房子不拆），只是换人，历史不动
    for (const seat of this.data.seats) {
      if (seat.agentId === id) seat.agentId = null;
    }
    this.save();
    return true;
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  addHostLog(entry) {
    this.data.hostLog.push({ ...entry, at: Date.now() });
    if (this.data.hostLog.length > 500) this.data.hostLog.splice(0, this.data.hostLog.length - 500);
    this.save();
  }

  /* ==================== 私信（不影响游戏，只在主持人和这个座位之间） ==================== */
  get dms() {
    if (!Array.isArray(this.data.dms)) this.data.dms = [];
    return this.data.dms;
  }

  addDm(entry) {
    const record = { id: uid('dm'), createdAt: Date.now(), ...entry };
    this.dms.push(record);
    if (this.dms.length > 2000) this.dms.splice(0, this.dms.length - 2000);
    this.save();
    return record;
  }

  getDms(seatId) {
    return this.dms.filter((d) => d.seatId === seatId);
  }

  clearDms(seatId) {
    this.data.dms = seatId ? this.dms.filter((d) => d.seatId !== seatId) : [];
    this.save();
    return this.data.dms.length;
  }
}

/* ==================== 对外序列化 ==================== */
export function publicAgent(agent) {
  const key = typeof agent.apiKey === 'string' ? agent.apiKey : '';
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar || '🤖',
    color: agent.color || '',
    preset: agent.preset || 'custom',
    baseUrl: agent.baseUrl || '',
    model: agent.model || '',
    systemPrompt: agent.systemPrompt || '',
    temperature: typeof agent.temperature === 'number' ? agent.temperature : 0.85,
    maxTokens: typeof agent.maxTokens === 'number' ? agent.maxTokens : 400,
    enabled: agent.enabled !== false,
    hasKey: !!key,
    apiKeyMask: key ? `${key.slice(0, 4)}····${key.slice(-4)}` : '',
  };
}

export function publicSeat(seat, agentsById, game = null) {
  const agent = seat.agentId ? agentsById.get(seat.agentId) : null;
  return {
    id: seat.id,
    number: seat.number,
    name: seat.name,
    avatar: seat.avatar || (agent ? agent.avatar : '🪑'),
    color: seat.color || (agent ? agent.color : ''),
    alive: !!seat.alive,
    role: seat.role,
    roleName: ROLES[seat.role]?.name || seat.role,
    roleIcon: ROLES[seat.role]?.icon || '',
    team: ROLES[seat.role]?.team || '',
    agentId: seat.agentId || null,
    agentName: agent ? agent.name : null,
    agentModel: agent ? agent.model : null,
    agentEnabled: agent ? agent.enabled !== false : false,
    deathDay: seat.deathDay || null,
    deathReason: seat.deathReason || null,
    antidote: seat.antidote !== false,
    poison: seat.poison !== false,
    guardLast: seat.guardLast || null,
    revealed: !!seat.revealed,
    canVote: seat.canVote !== false,
    gunUsed: !!seat.gunUsed,
    /** ★ 是不是当前警长 */
    sheriff: !!(game && game.sheriffId === seat.id),
  };
}

export function publicMessage(msg, { showRoles } = { showRoles: true }) {
  // ★ 观众视角必须把"能反推身份"的字段全部剥掉：
  //   includedChannels 会暴露"这个人看得到狼人频道"（= 他是狼），reason/role 同理。
  //   reasoning（思考过程）也必须剥掉 —— 里面经常直接写着"我是狼人，今晚刀谁"。
  const meta = showRoles
    ? msg.meta || {}
    : {
        model: msg.meta?.model || null,
        error: msg.meta?.error || null,
        system: msg.meta?.system || false,
      };
  return {
    id: msg.id,
    channelId: msg.channelId,
    role: msg.role,
    seatId: msg.seatId || null,
    seatNumber: msg.seatNumber || null,
    speakerName: msg.speakerName || '',
    speakerRole: showRoles ? msg.speakerRole || null : null,
    speakerRoleName: showRoles && msg.speakerRole ? ROLES[msg.speakerRole]?.name : null,
    content: msg.content || '',
    // ★ 思考过程带给前端（默认折叠），主持人才能判断"空发言"到底是模型没说话还是想太多被截断。
    //   以前这个字段只存进 db，前端完全拿不到，界面上只剩一条无从解释的空白。
    reasoning: showRoles ? clipReasoning(msg.reasoning) : undefined,
    status: msg.status || 'done',
    createdAt: msg.createdAt,
    meta,
  };
}

/** 思考过程可能很长，发给前端前截一下（完整内容仍在 db 里） */
const REASONING_MAX_CHARS = 2000;
function clipReasoning(text) {
  const s = String(text || '');
  return s.length > REASONING_MAX_CHARS ? `${s.slice(0, REASONING_MAX_CHARS)}…（思考过程过长，已截断）` : s;
}
