/**
 * 编排器：把"某个座位在某个频道说一句话"这件事做完 ——
 *   组装 prompt（唯一入口）→ 泄漏自检 → 流式调用模型 → 写回频道 → SSE 推送。
 */
import { uid } from './store.js';
import { streamChat, chatOnce, AbortError } from './openai.js';
import { buildPrompt, assertNoLeak, channelById, ROLES, resolveGeneration } from './channels.js';
import { seatLabel } from './game.js';

/**
 * ★ 空回复自动重试。
 *   推理型模型（deepseek-v4-pro / kimi-k3 / glm-4.7 …）会把「单次发言最多 tokens」
 *   整段用在思考上，正文（content）于是返回空 —— 界面上就是一条"空发言"，
 *   而且狼刀/验人/投票这些靠正文解析的环节会直接解析失败。
 *   所以：正文为空且没有报错时，用同一张消息、更高的预算再要一次。
 */
const RETRY = {
  maxEmptyRetries: 1,     // 空回复最多重试几次
  extraTokens: 2500,      // 重试时额外补的输出预算（够思考 + 正文）
  maxTokensCeiling: 8000, // 重试后的上限，避免个别模型被巨额 max_tokens 拒收
};

/** 生成"上一次正文为空"的补充要求（不改动原 messages） */
function withEmptyRetryHint(messages) {
  const copy = messages.map((m) => ({ ...m }));
  const last = copy[copy.length - 1];
  if (last && last.role === 'user') {
    last.content +=
      '\n\n【补充要求】你上一次只输出了思考过程，正文是空的。' +
      '这一次请直接说出你的发言，不要长篇推理，也不要复述历史记录。';
  }
  return copy;
}

export class Orchestrator {
  constructor({ store, emit, logger = console }) {
    this.store = store;
    this.emit = emit;
    this.logger = logger;
    this.run = null; // 同一时刻只跑一个发言任务，避免串台
    /** 最近一次送给模型的 prompt（调试 / 自动化测试用） */
    this.lastPrompts = [];
  }

  get running() {
    return !!this.run;
  }

  runningInfo() {
    if (!this.run) return null;
    return { seatId: this.run.seatId, channelId: this.run.channelId, startedAt: this.run.startedAt };
  }

  stop() {
    if (!this.run) return false;
    this.run.aborted = true;
    this.run.controller.abort();
    this.emit({ type: 'run.stopping' });
    return true;
  }

  _guard() {
    if (this.run) {
      const err = new Error('上一位玩家还在发言，请等它说完或点「停止」');
      err.code = 'BUSY';
      throw err;
    }
  }

  /**
   * 让一个座位在指定频道发言（唯一的底层入口）
   * @param {string} seatId
   * @param {string} channelId  必须在该座位权限内，否则 buildPrompt 会直接抛错
   * @param {string} task       本轮任务指令
   */
  async speakOnce({ seatId, channelId, task, extraRules = [], reason = 'manual', allowDead = false }) {
    this._guard();
    const store = this.store;
    const db = store.data;
    const seat = store.getSeat(seatId);
    if (!seat) throw new Error('座位不存在');
    // 已经出局的玩家通常不能发言；但猎人/狼王"死后开枪"是例外
    if (!seat.alive && !allowDead) throw new Error(`${seatLabel(seat)} 已经出局，不能发言`);

    const agent = seat.agentId ? store.getAgent(seat.agentId) : null;
    if (!agent) {
      // 没有绑定 AI：在频道里留一条系统提示，主持人一眼能看到
      const msg = {
        id: uid('msg'),
        channelId,
        role: 'system',
        speakerName: '系统',
        content: `⚠️ ${seatLabel(seat)} 还没有绑定 AI 模型，无法发言。请在右侧座位面板给它选一个模型。`,
        status: 'done',
        createdAt: Date.now(),
        meta: { system: true, seatId },
      };
      store.addMessage(channelId, msg);
      this.emit({ type: 'message.created', channelId, message: msg });
      return { skipped: true, reason: 'no-agent' };
    }
    if (agent.enabled === false) {
      const msg = {
        id: uid('msg'),
        channelId,
        role: 'system',
        speakerName: '系统',
        content: `⚠️ ${seatLabel(seat)} 绑定的「${agent.name}」已被停用，跳过本次发言。`,
        status: 'done',
        createdAt: Date.now(),
        meta: { system: true, seatId },
      };
      store.addMessage(channelId, msg);
      this.emit({ type: 'message.created', channelId, message: msg });
      return { skipped: true, reason: 'agent-disabled' };
    }

    // ---------- ① 解析生成参数（智力总控 → 成员自己的设置） ----------
    const gen = resolveGeneration(store.settings, agent);

    // ---------- ② 组装 prompt（唯一入口，按权限矩阵过滤） ----------
    let built = buildPrompt(db, seat, {
      channelId,
      task,
      extraRules: [...gen.extraRules, ...extraRules],
      contextLimit: gen.contextLimit,
    });
    if (agent.systemPrompt && agent.systemPrompt.trim()) {
      built.messages[0].content += `\n\n【玩家自定人设（可选）】${agent.systemPrompt.trim()}`;
    }

    // ---------- ③ 泄漏自检：成品 prompt 里不允许出现无权频道的正文 ----------
    const leakCheck = assertNoLeak(db, seat, built.messages);

    // 记录本次 prompt（方便主持人自查 / 自动化测试断言隔离）
    const record = {
      at: Date.now(),
      seatId,
      seatNumber: seat.number,
      role: seat.role,
      channelId,
      reason,
      messages: built.messages,
      /** ★ 这一次实际用的生成参数（智力总控解析之后的结果，主持人可在调试里核对） */
      params: { ...gen },
      meta: { ...built.meta, denied: leakCheck.deniedChannels },
    };
    this.lastPrompts.push(record);
    if (this.lastPrompts.length > 50) this.lastPrompts.shift();
    this.emit({ type: 'prompt.built', seatId, channelId, meta: record.meta });

    // ---------- ④ 建消息 + 流式调用 ----------
    const message = {
      id: uid('msg'),
      channelId,
      role: 'ai',
      seatId: seat.id,
      seatNumber: seat.number,
      speakerName: seat.name,
      speakerRole: seat.role,
      content: '',
      reasoning: '',
      status: 'streaming',
      createdAt: Date.now(),
      meta: {
        model: agent.model,
        agentId: agent.id,
        agentName: agent.name,
        role: seat.role,
        includedChannels: built.meta.includedChannels,
        reason,
      },
    };
    store.addMessage(channelId, message);
    this.emit({ type: 'message.created', channelId, message });
    this.emit({ type: 'seat.typing', seatId: seat.id, typing: true, channelId });

    const controller = new AbortController();
    this.run = { seatId, channelId, controller, aborted: false, startedAt: Date.now(), messageId: message.id };

    let content = '';
    let reasoning = '';
    let error = null;
    let attempt = 0;
    const startedAt = Date.now();
    const baseMaxTokens = gen.maxTokens;

    while (true) {
      attempt += 1;
      const isRetry = attempt > 1;
      const maxTokens = isRetry
        ? Math.min(RETRY.maxTokensCeiling, baseMaxTokens + RETRY.extraTokens)
        : baseMaxTokens;
      const messages = isRetry ? withEmptyRetryHint(built.messages) : built.messages;

      try {
        const stream = streamChat({
          baseUrl: agent.baseUrl,
          apiKey: agent.apiKey,
          model: agent.model,
          messages,
          temperature: gen.temperature,
          maxTokens,
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (this.run?.aborted) break;
          if (chunk.type === 'reasoning') {
            reasoning += chunk.text;
            this.emit({ type: 'message.delta', channelId, messageId: message.id, channel: 'reasoning', text: chunk.text });
          } else {
            content += chunk.text;
            this.emit({ type: 'message.delta', channelId, messageId: message.id, channel: 'content', text: chunk.text });
          }
        }
      } catch (err) {
        if (err instanceof AbortError || this.run?.aborted) {
          // 主持人手动停止
        } else {
          error = err.message;
        }
      }

      if (error || this.run?.aborted) break;
      if (content.trim()) break;
      if (attempt > RETRY.maxEmptyRetries) break;

      // 正文为空：清掉正文、用同一张消息重来（不留一条空发言）。
      // 第一次的思考**保留**下来并加个分隔 —— 复盘时能一眼看出"它是想太多被截断了"。
      content = '';
      reasoning += reasoning.trim() ? '\n\n—— 空回复，自动重试 ——\n\n' : '';
      message.content = '';
      message.reasoning = reasoning;
      message.meta.retrying = true;
      this.emit({ type: 'message.updated', channelId, message });
    }

    message.content = content.trim();
    message.reasoning = reasoning;
    message.elapsedMs = Date.now() - startedAt;
    delete message.meta.retrying;
    message.meta.attempts = attempt;
    if (error) {
      message.status = 'error';
      message.meta.error = error;
    } else if (this.run?.aborted) {
      message.status = 'stopped';
    } else {
      message.status = 'done';
      // 重试后仍然为空：界面要明确说出来，别让主持人对着空白猜
      if (!message.content) message.meta.emptyOutput = true;
      if (attempt > 1) message.meta.emptyRetried = true;
    }

    this.run = null;
    store.save();
    this.emit({ type: 'seat.typing', seatId: seat.id, typing: false, channelId });
    this.emit({ type: 'message.updated', channelId, message });
    return { message, error, attempts: attempt, includedChannels: built.meta.includedChannels };
  }

  /** 依次让多个座位发言（每个之间隔一点时间，读起来像真人轮流说话） */
  async speakMany(list, { gapMs = 350 } = {}) {
    const results = [];
    for (const item of list) {
      if (!this.store.getSeat(item.seatId)?.alive) continue;
      try {
        const r = await this.speakOnce(item);
        results.push({ seatId: item.seatId, ok: !r?.error, skipped: !!r?.skipped });
      } catch (err) {
        if (err.code === 'MESSAGE_LEAK' || err.code === 'FORBIDDEN_CHANNEL') throw err;
        results.push({ seatId: item.seatId, ok: false, error: err.message });
      }
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
    return results;
  }

  /**
   * ★ 私信：主持人私下问这个座位一句话（例如"你刚才为什么自刀？"）。
   *
   *   和"发言"的三点区别：
   *     1. 结果**只存进 store.dms**、不进任何频道 —— 而组装发言 prompt 只读频道，
   *        所以这段对话一个字都不会影响它之后的布局和逻辑（这是这条功能的核心承诺）；
   *     2. 不走 this.run 的"单发锁"：它不是游戏里的发言，不占发言队列，
   *        主持人在别人说话时也能问；
   *     3. 用非流式调用一次拿完整回答。
   */
  async askPrivately({ seatId, question }) {
    const store = this.store;
    const seat = store.getSeat(seatId);
    if (!seat) throw new Error('座位不存在');
    const agent = seat.agentId ? store.getAgent(seat.agentId) : null;
    if (!agent) throw new Error('这个座位还没有绑定 AI 模型');
    const text = String(question || '').trim();
    if (!text) throw new Error('问题不能为空');

    const gen = resolveGeneration(store.settings, agent);
    const task = [
      '【当前任务 · 私信】',
      '主持人（上帝视角）私下问你一个问题，请像跟朋友复盘一样如实回答：',
      `「${text}」`,
      '',
      '【私信规则】',
      '1. 这是私下复盘：其他玩家看不到，也不会进入任何频道。',
      '2. 你可以放心说真话（甚至直接承认自己的身份和战术），不影响胜负判定。',
      '3. 回答完之后，你的立场和后续发言不受这段对话影响 —— 不用记得这里说了什么。',
      '4. 用中文简短回答，2~5 句，别写长篇作文，不要用 Markdown。',
    ].join('\n');

    // 把它自己最近的思考片段带上，帮它准确回答"你当时为什么这么做"
    const own = this._recentThinking(seat);
    const messages = buildPrompt(store.data, seat, {
      channelId: 'lobby',
      task: own ? `${task}\n\n【你当时的思考片段（仅供回忆，不要逐字复述）】\n${own}` : task,
      contextLimit: gen.contextLimit,
      dm: true,
    }).messages;

    const call = (maxTokens) => chatOnce({
      baseUrl: agent.baseUrl,
      apiKey: agent.apiKey,
      model: agent.model,
      messages,
      temperature: gen.temperature,
      maxTokens,
      timeoutMs: 120000,
    });

    let out = await call(gen.maxTokens);
    let content = String(out.content || '').trim();
    // 空正文（推理模型想太多被截断）→ 抬预算再要一次，和公开发言一个待遇
    if (!content) {
      out = await call(Math.min(8000, gen.maxTokens + 2500));
      content = String(out.content || '').trim();
    }

    const base = { seatId: seat.id, seatNumber: seat.number, seatName: seat.name, model: agent.model };
    store.addDm({ ...base, role: 'host', content: text });
    const answer = store.addDm({
      ...base,
      role: 'ai',
      content: content || '（模型只输出了思考，没有给出正文）',
      reasoning: out.reasoning || '',
      empty: !content,
    });
    return { question: text, answer };
  }

  /** 找这个座位最近两条带思考的消息（私信时附上，帮它回忆当时的想法） */
  _recentThinking(seat) {
    const parts = [];
    for (const ch of this.store.data.channels || []) {
      for (const m of ch.messages || []) {
        if (m.seatId === seat.id && String(m.reasoning || '').trim()) parts.push(m);
      }
    }
    return parts
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .slice(-2)
      .map((m) => `· ${String(m.reasoning).trim().slice(-800)}`)
      .join('\n');
  }

  /** 连接测试（不写频道） */
  async testAgent(agent) {
    const startedAt = Date.now();
    let paramFix = null;
    const { content, model } = await chatOnce({
      baseUrl: agent.baseUrl,
      apiKey: agent.apiKey,
      model: agent.model,
      messages: [
        { role: 'system', content: '你是测试助手，回答极简。' },
        { role: 'user', content: '请只回复四个字：连接正常' },
      ],
      temperature: 0,
      maxTokens: 32,
      timeoutMs: 45000,
      onParamFix: (fix) => { paramFix = fix; },
    });
    return { ok: true, reply: content.trim(), model, elapsedMs: Date.now() - startedAt, paramFix };
  }
}

export { channelById, ROLES };
