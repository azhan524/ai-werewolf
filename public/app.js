/* AI 狼人杀 —— 主持人控制台前端 */
'use strict';

/* ============================ 工具 ============================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const escapeHtml = (t) =>
  String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  const codes = [];
  html = html.replace(/```[ \t]*(\w*)\n?([\s\S]*?)```/g, (_m, _l, code) => {
    codes.push(code.replace(/\n+$/, ''));
    return `\u0000C${codes.length - 1}\u0000`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|\n)[ \t]*[-*][ \t]+/g, '$1• ');
  html = html.replace(/@([^\s@<]{1,24})/g, '<span class="mention">@$1</span>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<pre class="code"><code>${codes[Number(i)]}</code></pre>`);
  return html;
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function softColor(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return '';
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r + (255 - r) * 0.82)}, ${Math.round(g + (255 - g) * 0.82)}, ${Math.round(b + (255 - b) * 0.82)})`;
}

function toast(message, isError = false) {
  const node = el('div', { class: `toast${isError ? ' err' : ''}`, text: message });
  $('#toast-root').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, isError ? 6000 : 2800);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================ 状态 ============================ */
const state = {
  view: 'host',           // host | audience
  settings: {},
  agents: [],
  agentMap: new Map(),
  channels: [],
  seats: [],
  roles: {},
  rolePresets: [],
  presets: [],
  presetGroups: [],
  proxy: '',
  dataFile: '',
  /** ★ AI 托管：{ on, note, nightPlanKey, nightStep, votedDay } */
  auto: { on: false, note: '' },
  situation: null,
  queue: null,
  game: {},
  activeChannel: 'lobby',
  running: null,
  typingSeatIds: new Set(),
  busy: false,
  unread: {},             // channelId -> 未读条数
  liveEls: new Map(),
};

const MODAL_ROOT = () => $('#modal-root');
const ROLE_CLASS = (role) => role || 'villager';
/** 狼人阵营的全部身份（自爆等规则用） */
const WOLF_ROLE_IDS = ['wolf', 'wolfking', 'whitewolfking'];

/* ============================ 弹窗基建 ============================ */
function showModal({ title, size = 'w-md', bodyHtml = '', footer = [], mount }) {
  const root = MODAL_ROOT();
  root.hidden = false;
  root.innerHTML = '';
  const body = el('div', { class: 'modal-body', html: bodyHtml });
  const foot = el('div', { class: 'modal-foot' });
  for (const b of footer) foot.append(b);
  const modalEl = el('div', { class: `modal ${size}` }, [
    el('div', { class: 'modal-head' }, [
      el('span', { text: title }),
      el('button', { class: 'icon-btn', text: '✕', onclick: () => close() }),
    ]),
    body,
    footer.length ? foot : null,
  ]);
  root.append(modalEl);
  root.onclick = (e) => { if (e.target === root) close(); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('keydown', onKey);
  // ★ 保险：弹窗初始化一旦抛错，直接在界面上显示出来。
  //   （曾经因为一个 ReferenceError 让"添加 AI"表单所有按钮失效，却毫无提示）
  try {
    mount?.(body, modalEl, close);
  } catch (err) {
    console.error('[弹窗] 初始化失败：', err);
    body.append(el('div', { class: 'test-result bad', text: `⚠️ 界面初始化失败：${err.message} —— 请把这条信息反馈给开发者` }));
  }
  return { close, body, modal: modalEl };
}

function confirmDialog({ title = '确认操作', message = '', detail = '', okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const cancelBtn = el('button', { class: 'ghost-btn', text: '取消' });
    const okBtn = el('button', { class: `primary-btn${danger ? ' danger' : ''}`, text: okText });
    const root = el('div', { class: 'modal-root confirm-root', style: 'z-index:300' }, [
      el('div', { class: 'modal w-sm' }, [
        el('div', { class: 'modal-head' }, [el('span', { text: title })]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'confirm-msg', text: message }),
          detail ? el('div', { class: 'confirm-detail', text: detail }) : null,
        ]),
        el('div', { class: 'modal-foot' }, [cancelBtn, okBtn]),
      ]),
    ]);
    const done = (v) => { document.removeEventListener('keydown', onKey, true); root.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.stopImmediatePropagation(); e.preventDefault(); done(e.key === 'Enter'); }
    };
    cancelBtn.onclick = () => done(false);
    okBtn.onclick = () => done(true);
    root.onclick = (e) => { if (e.target === root) done(false); };
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 30);
  });
}

/* ============================ 数据加载 ============================ */
async function refresh({ keepScroll = true } = {}) {
  const data = await api('GET', `/api/state?view=${state.view}`);
  state.settings = data.settings;
  state.agents = data.agents;
  state.agentMap = new Map(data.agents.map((a) => [a.id, a]));
  state.channels = data.channels;
  state.seats = data.seats;
  state.roles = data.roles || {};
  state.rolePresets = data.rolePresets || [];
  // ★ 这些是服务端下发的全局信息，别忘了带过来（曾漏掉导致服务商下拉为空）
  state.presets = data.presets || [];
  state.presetGroups = data.presetGroups || [];
  // ★ 智力总控（普通 / 聪明 / 智能）的档位表 + 当前档位
  state.aiLevels = data.aiLevels || [];
  state.aiLevel = data.aiLevel || 'smart';
  state.proxy = data.proxy || '';
  state.dataFile = data.dataFile || '';
  state.situation = data.situation || null;
  state.queue = data.queue || null;
  state.game = data.game || {};
  state.running = data.running;
  // ★ 代理连不上时（每条 AI 调用都会失败），服务端会给一句人话提示
  state.proxyWarning = data.proxyWarning || null;
  if (!state.channels.find((c) => c.id === state.activeChannel)) {
    state.activeChannel = state.channels[0]?.id || 'lobby';
  }
  renderAll({ keepScroll });
}

function currentChannel() {
  return state.channels.find((c) => c.id === state.activeChannel) || null;
}

/* ============================ 渲染：左侧频道 ============================ */
function renderChannels() {
  const list = $('#channel-list');
  list.innerHTML = '';
  for (const ch of state.channels) {
    const active = ch.id === state.activeChannel;
    const lock = ch.id === 'lobby' ? null : el('span', { class: `lock ${ch.id}`, text: `${ch.icon} 仅限` });
    list.append(
      el('div', { class: `room-item${active ? ' active' : ''}`, onclick: () => switchChannel(ch.id) }, [
        el('div', { class: 'avatar', text: ch.icon }),
        el('div', { class: 'r-info' }, [
          el('div', { class: 'r-name', text: ch.name }),
          el('div', { class: 'r-last', text: ch.desc }),
        ]),
        lock,
        state.unread[ch.id] ? el('span', { class: 'unread' }) : null,
      ])
    );
  }
  const phaseNames = { setup: '未开始', night: '夜晚', day: '白天', vote: '投票', ended: '已结束' };
  const chip = $('#phase-chip');
  chip.textContent = `${phaseNames[state.game.phase] || state.game.phase}${state.game.day ? ` D${state.game.day}` : ''}`;
  chip.className = `phase-chip ${state.game.phase || ''}`;
  $('#view-sub').textContent = state.view === 'audience' ? '观众视角 · 只能看公共频道' : '主持人视角 · 可见全部频道';
}

function switchChannel(id) {
  state.activeChannel = id;
  delete state.unread[id];
  renderChannels();
  renderHeader();
  renderMessages();
}

/* ============================ 渲染：顶部与消息 ============================ */
function renderHeader() {
  const ch = currentChannel();
  $('#channel-title').textContent = ch ? `${ch.icon} ${ch.name}` : '频道';
  $('#channel-sub').textContent = ch ? ch.desc : '';
  const running = !!state.running;
  $('#running-chip').hidden = !running;
  $('#btn-stop').hidden = !running;
  if (running) {
    const seat = state.seats.find((s) => s.id === state.running.seatId);
    $('#running-text').textContent = seat ? `${seat.number}号 ${seat.name} 正在思考…` : 'AI 正在思考…';
  }
  // 代理不通 → 顶部挂一条横幅（比一屏红字更快看出问题）
  const banner = $('#warn-banner');
  if (state.proxyWarning && state.view !== 'audience') {
    banner.hidden = false;
    banner.innerHTML = '';
    banner.append(el('span', { class: 'wb-icon', text: '⚠️' }));
    banner.append(el('span', { class: 'wb-text', text: `${state.proxyWarning} —— 这一局的 AI 调用都会失败，请打开「对局设置」清空代理，或先启动代理软件。` }));
    banner.append(el('button', { class: 'soft-btn', text: '打开设置', onclick: openSettings }));
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }
}

function messageEl(msg, grouped) {
  if (msg.role === 'system') {
    const warn = /⚠️|告警/.test(msg.content);
    return { el: el('div', { class: `sys-line${warn ? ' warn' : ''}`, text: msg.content }), refs: null };
  }
  const isHost = msg.role === 'host';
  const refs = {};
  refs.text = el('div', { class: 'bubble-text' });
  refs.reason = null;
  refs.reasonWrap = el('div', { class: 'reason-wrap' });
  refs.bubble = el('div', { class: 'bubble' }, [refs.reasonWrap, refs.text]);
  refs.meta = el('div', { class: 'm-meta' });
  const nameBits = [];
  nameBits.push(el('span', { text: isHost ? '📢 主持人' : `${msg.seatNumber ?? ''}号 ${msg.speakerName}` }));
  if (msg.speakerRoleName) nameBits.push(el('span', { class: `role-badge ${ROLE_CLASS(msg.speakerRole)}`, text: msg.speakerRoleName }));
  refs.nameEl = el('div', { class: 'm-name' }, nameBits);
  const avatar = el('div', {
    class: 'avatar',
    text: isHost ? '📢' : String(msg.seatNumber ?? '?'),
    style: isHost ? 'background:#eef3ff;color:#23365c;font-size:15px;font-weight:700' : '',
  });
  refs.el = el('div', { class: `msg${isHost ? ' host' : ''}${grouped ? ' grouped' : ''}` }, [
    avatar,
    el('div', { class: 'm-body' }, [refs.nameEl, refs.bubble, refs.meta]),
  ]);
  paintMessage(refs, msg);
  return { el: refs.el, refs };
}

function paintMessage(refs, msg) {
  const streaming = msg.status === 'streaming';
  const reason = String(msg.reasoning || '');
  if (msg.content) {
    refs.text.innerHTML = renderMarkdown(msg.content) + (streaming ? '<span class="cursor"></span>' : '');
  } else if (streaming) {
    refs.text.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
  } else if (msg.status === 'error') {
    refs.text.innerHTML = '<span style="color:#b32b28">（调用模型失败）</span>';
  } else if (msg.meta?.emptyOutput) {
    refs.text.innerHTML = '<span style="color:#c07a00">（模型只输出了思考，没有给出正文；已自动重试一次）</span>';
  } else {
    refs.text.innerHTML = '<span style="color:#aaa">（空发言）</span>';
  }
  // 思考过程：有内容才挂上去（没有就一个节点都不留），默认折叠
  if (reason.trim()) {
    if (!refs.reason) {
      refs.reasonBody = el('div', { class: 'reason-text' });
      refs.reason = el('details', { class: 'reason-box' }, [
        el('summary', { text: '思考过程' }),
        refs.reasonBody,
      ]);
      refs.reasonWrap.append(refs.reason);
    }
    refs.reason.querySelector('summary').textContent = `思考过程（${reason.length} 字）`;
    refs.reasonBody.textContent = reason;
  } else if (refs.reason) {
    refs.reason.remove();
    refs.reason = null;
  }
  refs.bubble.classList.toggle('stopped', msg.status === 'stopped');
  refs.bubble.classList.toggle('error', msg.status === 'error');
  const bits = [];
  if (msg.meta?.model) bits.push(msg.meta.model);
  if (msg.meta?.includedChannels) bits.push(`可见：${msg.meta.includedChannels.map((id) => state.channels.find((c) => c.id === id)?.name || id).join('+')}`);
  if (msg.meta?.error) bits.push(`⚠ ${msg.meta.error}`);
  if (msg.meta?.retrying) bits.push('空回复，正在重试…');
  else if (msg.meta?.emptyRetried) bits.push(msg.meta?.emptyOutput ? '重试后仍为空' : '空回复已自动重试');
  bits.push(fmtTime(msg.createdAt));
  refs.meta.textContent = bits.join(' · ');
}

function scrollBottom(force = false) {
  const box = $('#messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
  if (force || near) box.scrollTop = box.scrollHeight;
}

function renderMessages() {
  const box = $('#messages');
  const ch = currentChannel();
  box.innerHTML = '';
  state.liveEls.clear();
  if (!ch) return;
  const msgs = ch.messages || [];
  if (!msgs.length) {
    box.append(el('div', { class: 'empty', html: '<span class="big">🐺</span>这个频道还没有消息' }));
    return;
  }
  let prev = null;
  for (const m of msgs) {
    const grouped = prev && prev.role === m.role && prev.seatId === m.seatId && m.role !== 'system' && m.createdAt - prev.createdAt < 3 * 60 * 1000;
    const { el: node, refs } = messageEl(m, grouped);
    box.append(node);
    if (refs) state.liveEls.set(m.id, { refs, msg: m });
    prev = m;
  }
  box.scrollTop = box.scrollHeight;
}

function appendMessageLive(channelId, msg) {
  const ch = state.channels.find((c) => c.id === channelId);
  if (ch) ch.messages.push(msg);
  if (channelId !== state.activeChannel) {
    state.unread[channelId] = (state.unread[channelId] || 0) + 1;
    renderChannels();
    return;
  }
  const box = $('#messages');
  if (box.querySelector('.empty')) box.innerHTML = '';
  const prev = (ch?.messages || [])[ch.messages.length - 2];
  const grouped = prev && prev.role === msg.role && prev.seatId === msg.seatId && msg.role !== 'system';
  const { el: node, refs } = messageEl(msg, grouped);
  box.append(node);
  if (refs) state.liveEls.set(msg.id, { refs, msg });
  scrollBottom();
}

function updateMessageLive(channelId, msg) {
  const ch = state.channels.find((c) => c.id === channelId);
  if (ch) {
    const i = ch.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) ch.messages[i] = msg;
    else ch.messages.push(msg);
  }
  if (channelId !== state.activeChannel) return;
  const entry = state.liveEls.get(msg.id);
  if (entry) {
    Object.assign(entry.msg, msg);
    paintMessage(entry.refs, entry.msg);
    scrollBottom();
  } else {
    refresh().catch(() => {});
  }
}

/* ============================ 渲染：座位面板 ============================ */
function renderSeats() {
  const list = $('#seat-list');
  list.innerHTML = '';
  const alive = state.seats.filter((s) => s.alive).length;
  const modeText = state.game?.assignMode === 'manual' ? '手动分配' : '随机分配';
  const noText = state.game?.gameNo ? ` · 第 ${state.game.gameNo} 局` : '';
  $('#alive-count').textContent = state.view === 'audience' ? '' : `${alive} / ${state.seats.length} 存活 · ${modeText}${noText}`;
  for (const seat of state.seats) {
    const typing = state.typingSeatIds.has(seat.id);
    const card = el('div', { class: `seat-card${seat.alive ? '' : ' dead'}${typing ? ' typing' : ''}` });

    card.append(
      el('div', { class: 'seat-top' }, [
        el('div', { class: 'num', text: String(seat.number) }),
        el('div', { class: 'avatar sm', text: seat.avatar || '🪑', style: seat.color ? `background:${softColor(seat.color)}` : '' }),
        el('div', { class: 's-name', text: `${seat.sheriff ? '👑 ' : ''}${seat.name}` }),
        el('div', { class: 's-state', text: typing ? '发言中…' : seat.alive ? (seat.sheriff ? '警长 · 存活' : '存活') : `出局·${seat.deathReason || ''}` }),
      ])
    );

    if (state.view !== 'audience') {
      // 各角色的私有状态徽章
      const extra = [];
      if (seat.role === 'witch') extra.push(el('span', { class: 'tag', text: `解药${seat.antidote ? '✓' : '✗'} 毒药${seat.poison ? '✓' : '✗'}` }));
      if (seat.role === 'guard') extra.push(el('span', { class: 'tag', text: seat.guardLast ? `昨晚守 ${seat.guardLast}号` : '还没守过人' }));
      if (seat.role === 'hunter' || seat.role === 'wolfking') extra.push(el('span', { class: 'tag', text: seat.gunUsed ? '枪已用' : '🔫 有枪' }));
      if (seat.revealed) extra.push(el('span', { class: 'tag warn', text: '已翻牌·无投票权' }));
      if (seat.alive && seat.canVote === false && !seat.revealed) extra.push(el('span', { class: 'tag', text: '无投票权' }));
      card.append(
        el('div', { class: 'row-badges' }, [
          el('span', { class: `role-badge ${ROLE_CLASS(seat.role)}`, text: `${seat.roleIcon || ''} ${seat.roleName || seat.role}` }),
          ...extra,
        ])
      );
    }

    // ★ 换模型下拉框：只改绑定，不动频道历史
    const select = el('select', { class: `seat-agent${seat.agentId ? '' : ' empty'}`, title: '换这个座位的 AI 模型' });
    select.append(el('option', { value: '', text: seat.agentId ? '— 解除绑定 —' : '⚠ 未绑定 AI，点此选择' }));
    for (const a of state.agents) {
      select.append(el('option', { value: a.id, text: `${a.avatar || '🤖'} ${a.name} · ${a.model}${a.enabled ? '' : '（已停用）'}`, selected: a.id === seat.agentId ? true : null }));
    }
    select.onchange = async () => {
      const agentId = select.value || null;
      try {
        const r = await api('POST', `/api/seats/${seat.id}/agent`, { agentId });
        toast(r.note || '已切换模型');
        state.seats = r.seats;
        renderSeats();
      } catch (err) {
        toast(err.message, true);
        select.value = seat.agentId || '';
      }
    };
    card.append(select);

    if (state.view !== 'audience') {
      card.append(
        el('div', { class: 'seat-actions' }, [
          el('button', { text: '💬 私信', title: '私下问它一句话（不进频道，不影响它之后的判断）', onclick: () => openDm(seat.id) }),
          el('button', { text: '单独发言', onclick: () => hostAction('saySeat', { seatId: seat.id, channelId: state.activeChannel }) }),
          el('button', { text: '编辑', onclick: () => editSeat(seat) }),
          el('button', { text: seat.alive ? '标记出局' : '复活', onclick: () => toggleAlive(seat) }),
        ])
      );
    }
    list.append(card);
  }
}

async function toggleAlive(seat) {
  try {
    await api('PUT', `/api/seats/${seat.id}`, { alive: !seat.alive });
    await refresh();
    toast(seat.alive ? `${seat.number}号 已标记出局` : `${seat.number}号 已复活`);
  } catch (err) { toast(err.message, true); }
}

function editSeat(seat) {
  showModal({
    title: `编辑 ${seat.number}号`,
    size: 'w-sm',
    bodyHtml: `
      <div class="field"><label>玩家昵称</label><input type="text" id="s-name" value="${escapeHtml(seat.name)}" /></div>
      <div class="field"><label>身份（主持人可强行指定，用于复盘或剧本局）</label>
        <select id="s-role">
          ${Object.values(state.roles).map((r) => `<option value="${r.id}"${r.id === seat.role ? ' selected' : ''}>${r.icon} ${r.name}</option>`).join('')}
        </select>
      </div>`,
    footer: [
      el('button', { class: 'ghost-btn', text: '取消', onclick: () => MODAL_ROOT().hidden = true }),
      el('button', {
        class: 'primary-btn',
        text: '保存',
        onclick: async (e) => {
          try {
            await api('PUT', `/api/seats/${seat.id}`, { name: $('#s-name').value.trim(), role: $('#s-role').value });
            MODAL_ROOT().hidden = true;
            await refresh();
            toast('已保存');
          } catch (err) { toast(err.message, true); }
        },
      }),
    ],
  });
}

/* ============================ 主持人控制栏 ============================ */
function ctrlBtn({ icon, text, variant = '', action, payload = {}, disabled = false, title, alwaysClickable = false }) {
  return el('button', {
    class: `ctrl-btn ${variant}`,
    title,
    // 托管开关要随时能点（哪怕正在生成，也得能暂停），所以多一个逃生口
    disabled: alwaysClickable ? false : (disabled || state.busy || !!state.running),
    onclick: () => hostAction(action, payload),
  }, [icon ? el('span', { text: icon }) : null, el('span', { text })]);
}

function renderControls() {
  const bar = $('#control-bar');
  bar.innerHTML = '';
  const g = state.game || {};
  const phase = g.phase;
  const step = g.dayStep;
  const hasAgents = state.seats.some((s) => s.agentId);
  const label = (t) => el('span', { class: 'group-label', text: t });
  const divider = () => el('div', { class: 'divider' });

  if (state.view === 'audience') {
    bar.append(label('观众视角：仅可观看公共频道'));
    return;
  }

  /* ---------- ① 死后待办优先：遗言 → 警徽 → 开枪 ---------- */
  const lw = (g.pendingLastWords || [])[0];
  const badge = g.pendingBadge;
  const shot = g.pendingShot;
  const hasPending = !!(lw || badge || shot);

  if (lw) {
    bar.append(label('遗言'));
    bar.append(ctrlBtn({ icon: '💬', text: `让 ${lw.seatNumber}号 留遗言`, variant: 'primary', action: 'lastWords', title: `${lw.name} · 死因：${lw.reason}` }));
    bar.append(ctrlBtn({ icon: '⏭', text: '跳过遗言', action: 'skipLastWords' }));
  }
  if (badge) {
    bar.append(label('警徽'));
    bar.append(ctrlBtn({ icon: '🏅', text: `${badge.seatNumber}号 移交警徽`, variant: 'primary', action: 'badge' }));
    bar.append(ctrlBtn({ icon: '🎯', text: '手动指定去向', action: 'pickBadge', title: 'AI 没说清楚时，由主持人直接点一个人接警徽' }));
    bar.append(ctrlBtn({ icon: '✂️', text: '撕掉警徽', action: 'badgeManual', payload: { number: 0 } }));
  }
  if (shot) {
    bar.append(label('开枪'));
    bar.append(ctrlBtn({ icon: '🔫', text: `让 ${shot.seatNumber}号 开枪`, variant: 'danger', action: 'shoot', title: `${shot.name}（${state.roles[shot.role]?.name || shot.role}）· ${shot.reason}` }));
    bar.append(ctrlBtn({ icon: '🎯', text: '手动指定目标', action: 'pickShot', title: 'AI 没说清楚时，由主持人直接点一个人让他带走' }));
    bar.append(ctrlBtn({ icon: '⏭', text: '不开枪', action: 'skipShot' }));
  }
  if (hasPending) bar.append(divider());

  /* ---------- ①.5 AI 托管开关 ---------- */
  bar.append(label('托管'));
  bar.append(ctrlBtn({
    icon: '🤖',
    text: state.auto?.on ? `托管中 · 下一步：${state.auto.note || '…'}` : 'AI 托管',
    variant: state.auto?.on ? 'primary' : '',
    action: 'toggleAuto',
    alwaysClickable: true,
    title: '让 AI 替你点按钮把整局推进下去（需要判断的地方仍然由玩家自己决定）',
  }));
  bar.append(divider());

  /* ---------- ② 开局 / 结束 ---------- */
  if (phase === 'setup' || phase === 'ended') {
    if (phase === 'ended') {
      bar.append(label(g.winner === 'wolf' ? '🐺 狼人胜利' : '🎉 好人胜利'));
      bar.append(ctrlBtn({ icon: '🔄', text: '开新一局', variant: 'primary', action: 'newGameModal' }));
    } else {
      bar.append(label('开局'));
      bar.append(ctrlBtn({ icon: '🧩', text: '分配座位与身份', action: 'newGameModal' }));
      bar.append(ctrlBtn({ icon: '🌙', text: '天黑请闭眼', variant: 'night', action: 'night', disabled: !hasAgents, title: hasAgents ? '' : '先在右侧给座位绑定 AI 模型' }));
    }
  }

  /* ---------- ③ 夜晚 ---------- */
  if (phase === 'night') {
    bar.append(label('夜晚'));
    bar.append(ctrlBtn({ icon: '🛡', text: '守卫守人', variant: 'night', action: 'guard' }));
    bar.append(ctrlBtn({ icon: '🐺', text: '狼人行动', variant: 'night', action: 'wolves' }));
    bar.append(ctrlBtn({ icon: '🔮', text: '预言家验人', variant: 'night', action: 'seer' }));
    bar.append(ctrlBtn({ icon: '👁', text: '告知验人结果', action: 'seerReveal' }));
    bar.append(divider());
    bar.append(ctrlBtn({ icon: '🧪', text: '告知女巫死讯', variant: 'night', action: 'witchAsk' }));
    bar.append(ctrlBtn({ icon: '🧙', text: '女巫回复', variant: 'night', action: 'witch' }));
    bar.append(ctrlBtn({ icon: '✅', text: '执行女巫用药', action: 'witchApply' }));
    bar.append(divider());
    bar.append(ctrlBtn({ icon: '☀️', text: '天亮了', variant: 'dawn', action: 'dawn' }));
  }

  /* ---------- ④ 白天（按 dayStep 走） ---------- */
  if (phase === 'day') {
    if (step === 'campaign') {
      bar.append(label('警长竞选'));
      bar.append(ctrlBtn({ icon: '📣', text: '开始上警发言', variant: 'primary', action: 'campaign', title: '所有存活玩家依次表态是否上警' }));
    } else if (step === 'sheriffVote') {
      bar.append(label('警长竞选'));
      bar.append(ctrlBtn({ icon: '🗳', text: '警长竞选投票', variant: 'vote', action: 'sheriffVote', title: '只有没上警的人可以投票' }));
    } else if (step === 'sheriffPK') {
      bar.append(label('警长竞选平票'));
      bar.append(ctrlBtn({ icon: '⚔️', text: 'PK 发言 + 重投', variant: 'vote', action: 'sheriffPK', title: '平票候选人各说一轮，然后由警下玩家重投' }));
    } else if (step === 'votePK') {
      bar.append(label('放逐平票'));
      bar.append(ctrlBtn({ icon: '⚔️', text: 'PK 申辩 + 重投', variant: 'primary', action: 'votePK', title: '平票玩家依次申辩，然后由其他人重投；再平票则平安日' }));
      bar.append(ctrlBtn({ icon: '💥', text: '狼人自爆', variant: 'danger', action: 'explodeModal' }));
    } else {
      if (step !== 'done') {
        bar.append(label('白天发言'));
        bar.append(ctrlBtn({ icon: '▶', text: '下一位发言', variant: 'primary', action: 'nextSpeaker' }));
        bar.append(ctrlBtn({ icon: '⏩', text: '剩下的全部发言', action: 'dayAll' }));
        if (g.sheriffId && state.seats.find((s) => s.id === g.sheriffId)?.alive) {
          bar.append(ctrlBtn({ icon: '🏅', text: '警长定发言顺序', action: 'askOrder', title: '警长指定今天从谁开始、顺时针还是逆时针' }));
          if (!g.sheriffSummarized) {
            bar.append(ctrlBtn({ icon: '📢', text: '警长归票发言', variant: 'primary', action: 'sheriffSummary', title: '标准流程：所有人发言完、投票前，警长做最后总结' }));
          }
        }
        bar.append(divider());
        bar.append(ctrlBtn({ icon: '🗳', text: '开始投票', variant: 'vote', action: 'voteStart' }));
      }
      bar.append(ctrlBtn({ icon: '🌙', text: '进入下一夜', variant: 'night', action: 'night' }));
      if (state.seats.some((s) => s.alive && WOLF_ROLE_IDS.includes(s.role))) {
        bar.append(ctrlBtn({ icon: '💥', text: '狼人自爆', variant: 'danger', action: 'explodeModal', title: '任意狼人都可以在白天翻牌自爆，白天立即结束' }));
      }
      if (state.seats.some((s) => s.alive && s.role === 'whitewolfking')) {
        bar.append(ctrlBtn({ icon: '🐺', text: '白狼王自爆带人', variant: 'danger', action: 'explode', title: '白狼王自爆并带走一人' }));
      }
    }
  }

  /* ---------- ⑤ 放逐投票 ---------- */
  if (phase === 'vote') {
    bar.append(label('放逐投票'));
    bar.append(ctrlBtn({ icon: '📨', text: '全体投票', variant: 'vote', action: 'voteAll' }));
    bar.append(ctrlBtn({ icon: '⚖️', text: '计票并放逐', variant: 'primary', action: 'voteResolve' }));
    bar.append(ctrlBtn({ icon: '💥', text: '狼人自爆', variant: 'danger', action: 'explodeModal' }));
  }

  bar.append(divider());
  bar.append(ctrlBtn({ icon: '🏁', text: '手动结束', variant: 'danger', action: 'end', title: '按当前局势判定胜负并结束' }));
}

/* ============================ 私信（主持人 ↔ 单个 AI） ============================ */

/**
 * ★ 私信：私下问某个 AI 一句话（"你刚才为什么自刀？"）。
 *   内容只存在私信记录里、不进任何频道，而组装发言 prompt 只读频道 ——
 *   所以这段对话不影响它之后的布局和逻辑。
 */
function openDm(seatId) {
  const seat = state.seats.find((s) => s.id === seatId);
  if (!seat) return;
  if (!seat.agentId) return toast(`${seat.number}号 还没绑定 AI，先在右边给它选个模型`, true);
  let modalBody = null;

  showModal({
    title: `💬 私信 · ${seat.number}号 ${seat.name}`,
    size: 'w-md',
    bodyHtml: `
      <div class="tip">只有你和 ${seat.number}号 ${escapeHtml(seat.name)} 看得到。这段私信<b>不进任何频道</b>，
      也不会出现在它之后的发言里 —— 问完不影响它的布局和逻辑。</div>
      <div class="dm-list" id="dm-list"></div>
      <div class="dm-compose">
        <textarea id="dm-input" rows="2" placeholder="比如：你刚才为什么自刀？ / 这轮你准备怎么打？"></textarea>
        <button class="primary-btn" id="dm-send">发送</button>
      </div>`,
    footer: [
      el('button', {
        class: 'ghost-btn',
        text: '清空这段私信',
        onclick: async () => { await api('POST', '/api/dm/clear', { seatId }); if (modalBody) await loadDm(seatId, modalBody); },
      }),
    ],
    mount: (body) => {
      modalBody = body;
      const send = async () => {
        const input = $('#dm-input', body);
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        pushDmLine($('#dm-list', body), { role: 'host', content: text });
        const pending = pushDmLine($('#dm-list', body), { role: 'ai', content: '（思考中…）', pending: true });
        const btn = $('#dm-send', body);
        btn.disabled = true;
        try {
          await api('POST', '/api/dm', { seatId, question: text });
          await loadDm(seatId, body);
        } catch (err) {
          pending.querySelector('.dm-text').textContent = `（发送失败：${err.message}）`;
        } finally {
          btn.disabled = false;
          $('#dm-input', body)?.focus();
        }
      };
      $('#dm-send', body).onclick = send;
      $('#dm-input', body).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
      loadDm(seatId, body).then(() => $('#dm-input', body)?.focus());
    },
  });
}

function dmLine(d) {
  const mine = d.role === 'host';
  const node = el('div', { class: `dm-line${mine ? ' mine' : ''}${d.pending ? ' pending' : ''}` }, [
    el('div', { class: 'dm-text', text: d.content }),
    mine ? null : el('div', { class: 'dm-meta', text: `${d.model || ''}${d.empty ? ' · 空回复' : ''}` }),
  ]);
  return node;
}

function pushDmLine(list, d) {
  if (!list) return null;
  if (list.querySelector('.dm-empty')) list.innerHTML = '';
  const node = dmLine(d);
  list.append(node);
  list.scrollTop = list.scrollHeight;
  return node;
}

async function loadDm(seatId, body) {
  const list = $('#dm-list', body);
  if (!list) return;
  let msgs = [];
  try {
    msgs = (await api('GET', `/api/dm?seatId=${encodeURIComponent(seatId)}`)).messages || [];
  } catch { /* 拉不到就先空着 */ }
  list.innerHTML = '';
  if (!msgs.length) {
    list.append(el('div', { class: 'dm-empty', text: '还没有私信。问他一句试试，比如「你刚才为什么这么打？」' }));
    return;
  }
  for (const m of msgs) pushDmLine(list, m);
}

/**
 * 手动指定「开枪 / 警徽移交」的目标。
 * 这两个技能后端一直有接口（shootManual / badgeManual），但前端没有入口 ——
 * AI 答非所问时界面只弹一句"请用「手动」按钮指定"，可那个按钮压根不存在，
 * 主持人只能放弃技能（不开枪 / 撕警徽）。这里把它补上。
 */
function openSeatPick({ kind }) {
  const game = state.game || {};
  const pending = kind === 'shot' ? game.pendingShot : game.pendingBadge;
  if (!pending) return toast(kind === 'shot' ? '当前没有待执行的开枪' : '当前没有待处理的警徽', true);
  const title = kind === 'shot'
    ? `${pending.seatNumber}号 ${pending.name} 开枪带走谁？`
    : `${pending.seatNumber}号 ${pending.name} 把警徽移交给谁？`;
  const tip = kind === 'shot'
    ? 'AI 没说清楚目标，主持人可以直接指定；想放弃就点「不开枪」。'
    : 'AI 没说清楚警徽去向，主持人可以直接指定；也可以撕掉警徽。';
  const action = kind === 'shot' ? 'shootManual' : 'badgeManual';
  const alive = state.seats.filter((s) => s.alive && s.id !== pending.seatId);
  if (!alive.length) return toast('场上没有可选的目标', true);

  showModal({
    title,
    size: 'w-md',
    bodyHtml: `<div class="tip" style="margin-bottom:12px">${tip}</div><div class="agent-grid" id="pick-list"></div>`,
    footer: kind === 'badge'
      ? [el('button', { class: 'ghost-btn danger', text: '✂️ 撕掉警徽', onclick: async () => { MODAL_ROOT().hidden = true; await hostAction('badgeManual', { number: 0 }); } })]
      : [el('button', { class: 'ghost-btn', text: '取消', onclick: () => { MODAL_ROOT().hidden = true; } })],
    mount: (body, modalEl, close) => {
      const list = $('#pick-list', body);
      for (const s of alive) {
        list.append(el('div', { class: 'agent-row' }, [
          el('div', { class: 'avatar', text: s.avatar || '🙂', style: s.color ? `background:${softColor(s.color)}` : '' }),
          el('div', { class: 'ar-info' }, [
            el('div', { class: 'ar-name' }, [el('span', { text: `${s.number}号 ${s.name}` })]),
            el('div', { class: 'ar-sub', text: s.agentName ? `AI：${s.agentName}` : '未绑定 AI' }),
          ]),
          el('button', { class: 'primary-btn', text: '就 TA', onclick: async () => { close(); await hostAction(action, { number: s.number }); } }),
        ]));
      }
    },
  });
}

/** 狼人自爆：选一位狼人，可以让 AI 自己决定，也可以主持人强制 */
function openExplode() {
  const wolves = state.seats.filter((s) => s.alive && WOLF_ROLE_IDS.includes(s.role));
  if (!wolves.length) return toast('没有存活的狼人', true);
  const duringCampaign = ['campaign', 'sheriffVote', 'sheriffPK'].includes(state.game.dayStep);
  showModal({
    title: '狼人自爆',
    size: 'w-md',
    bodyHtml: `
      <div class="tip" style="margin-bottom:12px">
        白天任意时刻，狼人都可以翻牌自爆：<b>自己立即出局（没有遗言）</b>，白天立刻结束、直接进入黑夜，
        能帮队友跳过这一轮发言和投票。${duringCampaign ? '<br>⚠️ 现在正处于<b>警长竞选阶段</b>，此时自爆会导致<b>警徽流失</b>（本局没有警长）。' : ''}
      </div>
      <div class="agent-grid" id="exp-list"></div>`,
    footer: [el('button', { class: 'ghost-btn', text: '取消', onclick: () => { MODAL_ROOT().hidden = true; } })],
    mount: (body, modalEl, close) => {
      const list = $('#exp-list', body);
      for (const w of wolves) {
        list.append(el('div', { class: 'agent-row' }, [
          el('div', { class: 'avatar', text: w.avatar || '🤖', style: w.color ? `background:${softColor(w.color)}` : '' }),
          el('div', { class: 'ar-info' }, [
            el('div', { class: 'ar-name' }, [el('span', { text: `${w.number}号 ${w.name}` }), el('span', { class: `role-badge ${ROLE_CLASS(w.role)}`, text: `${w.roleIcon} ${w.roleName}` })]),
            el('div', { class: 'ar-sub', text: w.agentName ? `AI：${w.agentName}` : '未绑定 AI' }),
          ]),
          el('button', { class: 'soft-btn', text: '问它要不要自爆', onclick: async () => { close(); await hostAction('wolfExplode', { number: w.number }); } }),
          el('button', { class: 'ghost-btn danger', text: '强制自爆', onclick: async () => { close(); await hostAction('wolfExplode', { number: w.number, force: true }); } }),
        ]));
      }
    },
  });
}

/** 退水：把某个候选人从警长竞选里撤下来（转为警下，可投票） */
async function withdrawCandidate(c) {
  const ok = await confirmDialog({
    title: '退水',
    message: `让 ${c.number}号 ${c.name} 退出警长竞选？`,
    detail: '退水后不再参与本次竞选，但会成为「警下」，可以参与警长投票。',
    okText: '退水',
  });
  if (!ok) return;
  try {
    const r = await api('POST', '/api/host/withdraw', { number: c.number });
    toast(r.remaining.length ? `已退水，剩余候选人：${r.remaining.join('、')}号` : '所有候选人都退水了，本局没有警长');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

/* 警上候选人条：显示候选人，并允许主持人处理"退水" */
function renderCandidates() {
  const strip = $('#candidate-strip');
  const g = state.game || {};
  const cands = g.candidates || [];
  const show = cands.length > 0 && !g.sheriffId && ['campaign', 'sheriffVote', 'sheriffPK'].includes(g.dayStep);
  if (!show || state.view === 'audience') {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.innerHTML = '';
  strip.append(el('span', { class: 'q-label', text: `警上候选人（${cands.length}）` }));
  for (const c of cands) {
    strip.append(el('span', { class: 'cand-chip' }, [
      el('span', { text: `${c.number}号 ${c.name}` }),
      el('button', { class: 'cand-x', text: '✕', title: '退水：放弃竞选，转为警下（可投票）', onclick: () => withdrawCandidate(c) }),
    ]));
  }
  strip.append(el('span', { class: 'q-label', text: '点 ✕ 让它退水 · 退水后转为警下可投票' }));
}

/* ============================ AI 托管：代替主持人推进流程 ============================ */
/**
 * 新手不会主持、或者主持人临时有事，就把整局的「点按钮」交给它：
 *   夜晚：守卫 → 狼刀 → 验人 → 告知结果 → 女巫 → 天亮
 *   白天：上警表态 → 竞选投票 → 依次发言 → 警长归票 → 投票 → 计票
 *         （遗言 / 警徽移交 / 开枪 这些待办优先处理）
 * 需要"人做判断"的地方仍然由 AI 玩家自己决定（枪打谁、警徽给谁、要不要自爆），
 * 所以托管不会替玩家做违规决定。随时可以点「托管中」暂停并接管。
 */
const AUTOPILOT = { gapMs: 900, stallLimit: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一夜的动作顺序（按本局实际有谁活着动态生成） */
function nightPlan(seats) {
  const plan = [];
  if (seats.some((s) => s.role === 'guard' && s.alive)) plan.push({ action: 'guard', note: '守卫守人' });
  plan.push({ action: 'wolves', note: '狼人行动' });
  if (seats.some((s) => s.role === 'seer' && s.alive)) {
    plan.push({ action: 'seer', note: '预言家验人' }, { action: 'seerReveal', note: '告知验人结果' });
  }
  if (seats.some((s) => s.role === 'witch' && s.alive)) {
    plan.push(
      { action: 'witchAsk', note: '告知女巫死讯' },
      { action: 'witch', note: '女巫回复' },
      { action: 'witchApply', note: '执行女巫用药' },
    );
  }
  plan.push({ action: 'dawn', note: '天亮了' });
  return plan;
}

/** 下一步该点哪个按钮（返回 { action, note } 或 { stop: 原因 }） */
function nextAutopilotAction() {
  const g = state.game || {};
  const seats = state.seats || [];
  if (g.phase === 'ended') return { stop: '本局已结束' };
  if (!seats.some((s) => s.agentId)) return { stop: '还没有给座位绑定 AI 模型' };

  // 死后待办优先级最高：遗言 → 警徽 → 开枪
  const lw = (g.pendingLastWords || [])[0];
  if (lw) return { action: 'lastWords', payload: { seatId: lw.seatId }, note: `让 ${lw.seatNumber}号 留遗言` };
  if (g.pendingBadge) return { action: 'badge', note: `${g.pendingBadge.seatNumber}号 移交警徽` };
  if (g.pendingShot) return { action: 'shoot', note: `让 ${g.pendingShot.seatNumber}号 开枪` };

  if (g.phase === 'setup') return { action: 'night', note: '天黑请闭眼' };

  if (g.phase === 'night') {
    const plan = nightPlan(seats);
    // 服务端的 nightStep 会停在同一值上（守卫那一步之后依然是 guard），所以自己按顺序数
    const done = state.auto.nightPlanKey === `${g.day}` ? state.auto.nightStep : 0;
    const step = plan[Math.min(done, plan.length - 1)];
    return { ...step, __nightIdx: Math.min(done, plan.length - 1) };
  }

  if (g.phase === 'day') {
    if (g.dayStep === 'campaign') return { action: 'campaign', note: '上警表态' };
    if (g.dayStep === 'sheriffVote') return { action: 'sheriffVote', note: '警长竞选投票' };
    if (g.dayStep === 'sheriffPK') return { action: 'sheriffPK', note: '警长 PK + 重投' };
    if (g.dayStep === 'votePK') return { action: 'votePK', note: '放逐 PK + 重投' };
    if (g.dayStep === 'speak') {
      if (state.queue && !state.queue.finished) return { action: 'nextSpeaker', note: '下一位发言' };
      const sheriff = seats.find((s) => s.id === g.sheriffId);
      if (sheriff && sheriff.alive && !g.sheriffSummarized) return { action: 'sheriffSummary', note: '警长归票发言' };
      return { action: 'voteStart', note: '开始投票' };
    }
    return { action: 'night', note: '进入下一夜' };
  }

  if (g.phase === 'vote') {
    if (g.dayStep === 'votePK') return { action: 'votePK', note: '放逐 PK + 重投' };
    if (state.auto.votedDay !== g.day) return { action: 'voteAll', note: '全体投票' };
    return { action: 'voteResolve', note: '计票并放逐' };
  }
  return { stop: `不认识的阶段：${g.phase}` };
}

/**
 * 「有没有推进」的指纹：阶段 + 天数 + 步骤 + 消息总数。
 *   注意必须带消息数 —— 夜晚整段的 dayStep 都是 null，
 *   只看阶段会把"正常推进"误判成卡住（第一版就踩了这个坑）。
 */
function autopilotSignature() {
  const g = state.game || {};
  const msgs = (state.channels || []).reduce((a, c) => a + (c.messages || []).length, 0);
  return `${g.phase}/${g.day}/${g.dayStep || ''}/${g.nightStep || ''}/${msgs}`;
}

async function autopilotLoop() {
  const a = state.auto;
  let lastSig = '';
  let stall = 0;
  while (a.on) {
    if (state.busy || state.running) { await sleep(500); continue; }
    const next = nextAutopilotAction();
    if (next.stop) return stopAutopilot(next.stop);

    if (typeof next.__nightIdx === 'number') {
      a.nightPlanKey = `${state.game.day}`;
      a.nightStep = next.__nightIdx + 1;
    }
    if (next.action === 'voteAll') a.votedDay = state.game.day;

    a.note = next.note;
    renderControls();
    const before = autopilotSignature();
    await sleep(AUTOPILOT.gapMs);
    if (!a.on) return;
    await hostAction(next.action, next.payload || {});
    await sleep(250);
    const after = autopilotSignature();
    // 卡住保护：连着几步状态没变（按钮点了没反应）就停下来，别空转
    if (after === before && after === lastSig) {
      if (++stall >= AUTOPILOT.stallLimit) return stopAutopilot('连续几步没有推进，已暂停托管（可以手动点一下看看卡在哪）');
    } else stall = 0;
    lastSig = after;
  }
}

function toggleAutopilot() {
  if (state.auto.on) return stopAutopilot('已暂停，接下来交回给你');
  if ((state.game || {}).phase === 'ended') return toast('本局已结束，先开新一局', true);
  // ★ 原地改属性，不要换对象 —— 循环里拿着这个引用，换对象会让它在暂停后继续跑
  Object.assign(state.auto, { on: true, note: '准备中…', nightPlanKey: null, nightStep: 0, votedDay: null });
  toast('🤖 托管已开启：接下来由它替你点按钮，随时可以暂停');
  renderControls();
  autopilotLoop().catch((err) => stopAutopilot(`出错：${err.message}`));
}

function stopAutopilot(reason) {
  Object.assign(state.auto, { on: false, note: '' });
  renderControls();
  toast(`🤖 托管已停止：${reason}`);
}

/* ============================ 主持人动作 ============================ */
async function hostAction(action, payload = {}) {
  // 这几个是前端自己的动作，不对应后端接口
  if (action === 'newGameModal') return openNewGame();
  if (action === 'saySeat') return speakSeat(payload.seatId, payload.channelId);
  if (action === 'explodeModal') return openExplode();
  if (action === 'pickShot') return openSeatPick({ kind: 'shot' });
  if (action === 'pickBadge') return openSeatPick({ kind: 'badge' });
  if (action === 'toggleAuto') return toggleAutopilot();

  state.busy = true;
  renderControls();
  renderHeader();
  $('#running-chip').hidden = false;
  $('#running-text').textContent = '正在执行主持人指令…';
  try {
    const r = await api('POST', `/api/host/${action}`, payload);
    if (r?.message && typeof r.message === 'string' && r.done) toast(r.message);
    if (r?.kill) toast(r.kill.noKill
      ? '狼人选择了空刀'
      : `狼人要杀 ${r.kill.number}号${r.kill.parsed ? '' : '（狼人没说清刀口，已自动指定存活好人里座位号最小的一位）'}`);
    if (r?.check) toast(`预言家要验 ${r.check.number}号`);
    if (r?.decision) toast(`女巫：${r.decision.save ? '用解药' : '不用解药'}${r.decision.poison ? `，毒 ${r.decision.poison}号` : ''}`);
    if (r?.report) toast(r.report.peaceful ? '昨晚是平安夜' : `昨晚死亡：${r.report.deaths.map((d) => d.number + '号').join('、')}`);
    if (r?.exiled) toast(`${r.exiled.number}号 ${r.exiled.name} 被放逐`);
    if (r?.winner?.text) toast(r.winner.text);
    if (r?.results) {
      const bad = r.results.filter((x) => x.error);
      if (bad.length) toast(`${bad.length} 位玩家的模型调用失败，详情见频道里的红字`, true);
    }
    if (r?.needManual) toast('AI 没说清楚目标，请用「手动」按钮指定', true);
    if (r?.candidates) toast(r.candidates.length ? `上警：${r.candidates.join('、')}` : '无人上警');
    if (r?.skipped) toast(r.message || '已跳过');
    if (r?.sheriff) toast(`🏅 ${r.sheriff.number}号 ${r.sheriff.name} 当选警长`);
    if (r?.needPK) toast(`警长竞选平票：${(r.pkCandidates || []).join('、')}号 → 需要 PK 发言并重投`, true);
    if (r?.warning) toast(r.warning, true);
    if (r?.exploded === false) toast('它决定不自爆');
    if (r?.exploded === true) toast(`💥 ${r.seat?.number}号 ${r.seat?.name} 自爆！白天立即结束${r.campaignLost ? '，警徽流失' : ''}`, true);
    if (r?.peacefulDay) toast('PK 后依然平票 → 平安日，本轮无人出局');
    if (r?.flipped) toast(`${r.flipped.number}号 翻开身份牌——白痴！不死亡但失去投票权`);
    if (r?.pk) toast(`平票 → 进入 PK：${r.pk.tied.join('、')}号 需要申辩`);
    if (r?.winner?.text) toast(r.winner.text);
    if (r?.applied?.torn) toast('警徽被撕掉');
    if (r?.applied?.target) toast(`警徽移交给 ${r.applied.target.number}号`);
    if (r?.order) toast(`发言顺序改为从 ${r.order[0]}号 开始`);
    if (r?.tally && !r?.sheriff) toast(`警长竞选平票：${r.tally.counts.map((c) => `${c.target}号${c.count}票`).join('、')}`, true);
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
    renderControls();
    renderHeader();
  }
}

/** 让某个座位单独在当前频道说一句（座位面板上的按钮） */
async function speakSeat(seatId, channelId) {
  state.busy = true;
  renderControls();
  try {
    const r = await api('POST', '/api/host/seatSpeak', { seatId, channelId });
    if (r?.error) toast(r.error, true);
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
    renderControls();
  }
}

async function sendHostMessage() {
  const input = $('#input');
  const content = input.value.trim();
  if (!content) return;
  if (state.view === 'audience') return toast('观众视角不能发言', true);
  input.value = '';
  autoGrow();
  try {
    await api('POST', '/api/host/say', { channelId: state.activeChannel, content });
  } catch (err) {
    toast(err.message, true);
  }
}

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

/* ============================ 开新一局 ============================ */
function openNewGame() {
  const plan = { wolf: 4, wolfking: 0, whitewolfking: 0, seer: 1, witch: 1, hunter: 1, guard: 0, idiot: 1, villager: 4 };
  const presets = state.rolePresets || [];
  const roleList = Object.values(state.roles || {});
  const WOLF_IDS = roleList.filter((r) => r.team === 'wolf').map((r) => r.id);
  const GOD_IDS = roleList.filter((r) => r.team === 'good' && r.id !== 'villager').map((r) => r.id);

  const bodyHtml = `
    <div class="field">
      <label>选一个常见板子（可再手动微调）</label>
      <div class="chip-list" id="ng-presets">
        ${presets.map((p) => `<div class="chip" data-preset="${p.id}" title="${escapeHtml(p.desc)}">${escapeHtml(p.name)}</div>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>身份分配方式</label>
      <div class="seg" id="ng-mode">
        <button data-mode="random" class="on">🎲 随机分配（默认）</button>
        <button data-mode="manual">✍️ 手动指定</button>
      </div>
      <div class="tip" id="ng-mode-tip"></div>
    </div>
    <div class="field" id="ng-plan-wrap">
      <label>身份配比（总人数 = 各项之和，标准局 12 人）</label>
      <div class="plan-grid">
        ${roleList.map((r) => `
          <div class="plan-item" title="${escapeHtml(r.skill || '')}">
            <span>${r.icon} ${r.name}</span>
            <input type="number" min="0" max="8" id="plan-${r.id}" value="${plan[r.id] ?? 0}" />
          </div>`).join('')}
      </div>
      <div class="tip" id="ng-plan-tip"></div>
    </div>
    <div class="field" id="ng-manual-wrap" hidden>
      <label>逐个座位指定身份（也可以顺手改昵称）</label>
      <div class="manual-grid" id="ng-manual"></div>
      <div class="tip" id="ng-manual-tip"></div>
    </div>
    <div class="field">
      <label>把哪些 AI 拉进来（按顺序依次坐到 1 号、2 号…座位上）</label>
      <div class="chip-list" id="ng-agents"></div>
      <div class="tip">座位和 AI 的绑定后面随时可以在右侧面板用下拉框换。</div>
    </div>
    <div class="field">
      <label>频道历史</label>
      <div class="checkline">
        <input type="checkbox" id="ng-clear" checked />
        <span>清空所有频道的历史消息（<b>频道本身不会重建</b>，只是把旧记录清掉）</span>
      </div>
    </div>`;

  const startBtn = el('button', { class: 'primary-btn', text: '开始新对局' });
  const modal = showModal({
    title: '开新一局',
    size: 'w-md',
    bodyHtml,
    footer: [startBtn],
    mount: (body, modalEl, close) => {
      let mode = 'random';
      let manual = []; // [{name, role}]

      const readCounts = () => {
        const c = {};
        for (const r of roleList) c[r.id] = Math.max(0, Math.min(8, Number($(`#plan-${r.id}`, body).value) || 0));
        return c;
      };
      const planFromCounts = () => {
        const c = readCounts();
        const list = [];
        for (const r of roleList) for (let i = 0; i < (c[r.id] || 0); i++) list.push(r.id);
        return list;
      };
      const readManual = () =>
        $$('.manual-item', body).map((item) => ({
          name: item.querySelector('.mn-name').value.trim(),
          role: item.querySelector('.mn-role').value,
        }));

      const currentPlan = () => (mode === 'manual' ? readManual().map((x) => x.role) : planFromCounts());

      function updateTally() {
        const list = currentPlan();
        const wolves = list.filter((r) => WOLF_IDS.includes(r)).length;
        const gods = list.filter((r) => GOD_IDS.includes(r)).length;
        const villagers = list.filter((r) => r === 'villager').length;
        const html = `共 <b>${list.length}</b> 人：狼队 ${wolves} · 神职 ${gods} · 平民 ${villagers}` +
          (list.length === 12 ? '　✅ 标准 12 人局' : '　（标准局为 12 人）');
        const a = $('#ng-plan-tip', body);
        const b = $('#ng-manual-tip', body);
        if (a) a.innerHTML = html;
        if (b) b.innerHTML = html;
      }

      function renderManual() {
        const grid = $('#ng-manual', body);
        grid.innerHTML = '';
        manual.forEach((entry, i) => {
          const num = i + 1;
          const nameInput = el('input', { type: 'text', class: 'mn-name', placeholder: `${num}号昵称（可留空）`, value: entry.name || '' });
          const sel = el('select', { class: 'mn-role' });
          for (const r of roleList) {
            sel.append(el('option', { value: r.id, text: `${r.icon} ${r.name}`, selected: entry.role === r.id ? true : null }));
          }
          sel.onchange = () => { manual = readManual(); updateTally(); };
          nameInput.oninput = () => { manual = readManual(); };
          grid.append(el('div', { class: 'manual-item' }, [
            el('span', { class: 'mn-num', text: `${num}号` }),
            nameInput,
            sel,
          ]));
        });
        manual = readManual();
        updateTally();
      }

      function setMode(next) {
        mode = next;
        $$('#ng-mode button', body).forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
        const isManual = mode === 'manual';
        $('#ng-plan-wrap', body).hidden = isManual;
        $('#ng-manual-wrap', body).hidden = !isManual;
        $('#ng-mode-tip', body).textContent = isManual
          ? '手动：身份按你在下面指定的座位落座，程序不会洗牌 —— 适合剧本局、复盘、或指定"让谁来当狼"。'
          : '随机：程序把身份洗牌后随机发给每个座位，AI 玩家事先都不知道（默认，推荐）。';
        if (isManual) {
          // 从当前配比顺序初始化手动列表，尽量保留已填的昵称
          manual = planFromCounts().map((roleId, i) => ({ name: manual[i]?.name || '', role: roleId }));
          renderManual();
        } else {
          updateTally();
        }
      }

      for (const b of $$('#ng-mode button', body)) b.onclick = () => setMode(b.dataset.mode);

      for (const chip of $$('#ng-presets .chip', body)) {
        chip.onclick = () => {
          const p = presets.find((x) => x.id === chip.dataset.preset);
          if (!p) return;
          const count = {};
          for (const r of p.plan) count[r] = (count[r] || 0) + 1;
          for (const r of roleList) {
            const input = $(`#plan-${r.id}`, body);
            if (input) input.value = String(count[r.id] || 0);
          }
          $$('#ng-presets .chip', body).forEach((c) => c.classList.toggle('on', c === chip));
          if (mode === 'manual') setMode('manual');
          else updateTally();
        };
      }
      for (const r of roleList) $(`#plan-${r.id}`, body)?.addEventListener('input', () => { if (mode === 'manual') setMode('manual'); else updateTally(); });

      // AI 选择
      const selected = new Set(state.agents.map((a) => a.id));
      const list = $('#ng-agents', body);
      const paintAgents = () => {
        list.innerHTML = '';
        if (!state.agents.length) {
          list.append(el('span', { class: 'tip', text: '还没有 AI，请先到「AI 成员库」添加' }));
          return;
        }
        for (const a of state.agents) {
          const on = selected.has(a.id);
          list.append(el('div', {
            class: `chip${on ? ' on' : ''}`,
            onclick: () => { on ? selected.delete(a.id) : selected.add(a.id); paintAgents(); },
          }, [el('span', { class: 'avatar', text: a.avatar || '🤖' }), el('span', { text: `${a.name} · ${a.model}` })]));
        }
      };
      paintAgents();
      setMode('random');

      startBtn.onclick = async () => {
        const isManual = mode === 'manual';
        const planList = isManual ? readManual().map((x) => x.role) : planFromCounts();
        const names = isManual ? readManual().map((x) => x.name) : [];
        const wolves = planList.filter((r) => WOLF_IDS.includes(r)).length;
        if (planList.length < 4) return toast('至少 4 名玩家', true);
        if (planList.length > 18) return toast('最多 18 名玩家', true);
        if (wolves === 0) return toast('至少要有一个狼人', true);
        if (wolves >= planList.length / 2) return toast('狼人不能超过一半', true);
        startBtn.disabled = true;
        try {
          if ($('#ng-clear', body).checked) await api('POST', '/api/channels/clear');
          const payload = { assignMode: isManual ? 'manual' : 'random', agentIds: [...selected] };
          if (isManual) {
            payload.roles = planList;
            payload.names = names;
          } else {
            payload.rolePlan = planList;
          }
          await api('POST', '/api/game/new', payload);
          close();
          await refresh();
          toast(`${isManual ? '已按你指定的身份落座' : '身份已随机洗牌'}：${planList.length} 人（${wolves} 狼 / ${planList.length - wolves} 好人）`);
        } catch (err) {
          toast(err.message, true);
          startBtn.disabled = false;
        }
      };
    },
  });
  void modal;
}

/* ============================ 隔离自检 ============================ */
async function runIsolationCheck() {
  try {
    const r = await api('POST', '/api/host/checkIsolation');
    const report = r.report;
    const rows = report.seats.map((s) => el('div', { class: `iso-row${s.ok ? '' : ' bad'}` }, [
      el('div', { class: 'iso-who' }, [
        el('div', { text: `${s.seatNumber}号 ${s.name}` }),
        el('div', { class: `role-badge ${ROLE_CLASS(s.role)}`, text: `${state.roles[s.role]?.icon || ''} ${s.roleName}` }),
      ]),
      el('div', { class: 'iso-detail' }, [
        el('div', { html: `<b>有权：</b>${s.allowed.map((id) => state.channels.find((c) => c.id === id)?.name || id).join('、')}` }),
        el('div', { html: `<b>无权：</b>${s.denied.length ? s.denied.map((id) => state.channels.find((c) => c.id === id)?.name || id).join('、') : '（无）'}` }),
        el('div', { html: `<b>本次提示词实际带入：</b>${s.includedChannels.length ? s.includedChannels.map((id) => state.channels.find((c) => c.id === id)?.name || id).join('、') : '（暂无历史）'}` }),
        s.problems.length ? el('div', { style: 'color:#b32b28', text: `⚠ ${s.problems.join('；')}` }) : null,
      ]),
    ]));
    showModal({
      title: '频道隔离自检',
      size: 'w-lg',
      bodyHtml: '<div id="iso-body"></div>',
      footer: [el('button', { class: 'primary-btn', text: '知道了', onclick: () => { MODAL_ROOT().hidden = true; } })],
      mount: (body) => {
        const box = $('#iso-body', body);
        box.append(el('div', { class: `iso-summary ${report.ok ? 'ok' : 'bad'}` }, [
          el('span', { text: report.ok ? '✅' : '⛔' }),
          el('span', { text: report.ok ? '全部座位通过：每个 AI 的提示词里都只包含自己有权查看的频道' : '发现隔离问题，请查看下面的红色条目' }),
        ]));
        box.append(el('div', { class: 'tip', style: 'margin-bottom:10px', text: `检查时间：${new Date(report.checkedAt).toLocaleString()}　·　自检方式：为该座位组装真实提示词 → 逐条比对无权频道正文 → 反向扫描成品 prompt` }));
        rows.forEach((r) => box.append(r));
      },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

/* ============================ AI 成员库 ============================ */
const modelCache = new Map();

/** 服务商下拉：用服务端下发的预设，按"国内直连 / 聚合 / 海外需代理 / 本地"分组 */
function providerOptions(selected) {
  const presets = state.presets || [];
  const groups = state.presetGroups || [{ id: 'cn', label: '国内直连' }, { id: 'aggregator', label: '聚合平台' }, { id: 'global', label: '海外（需代理）' }, { id: 'local', label: '本地部署' }, { id: 'custom', label: '其它' }];
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const p of presets) {
    const g = byGroup.has(p.group) ? p.group : 'custom';
    (byGroup.get(g) || byGroup.get('custom')).push(p);
  }
  return groups
    .map((g) => {
      const list = byGroup.get(g.id) || [];
      if (!list.length) return '';
      return `<optgroup label="${escapeHtml(g.label)}">${list
        .map((p) => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
        .join('')}</optgroup>`;
    })
    .join('');
}

const presetOf = (id) => (state.presets || []).find((p) => p.id === id) || null;

/** 一键把常见本地代理填进设置（Clash 7890 / v2rayN 10809） */
async function quickSetProxy(url) {
  try {
    await api('PUT', '/api/settings', { proxy: url });
    await refresh();
    toast(`已把代理设为 ${url}，可以在「⚙ 设置」里改`);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 自动检测本机代理端口（各家默认端口都不一样：Clash Verge 7897 / Clash for Windows 7890 / v2rayN 10809…）
 * 检测到可用代理会直接启用。
 */
async function autoDetectProxy() {
  toast('正在扫描本机代理端口，请稍等…');
  try {
    const r = await api('GET', '/api/proxy/detect');
    if (!r.ok) return toast(r.error, true);
    const working = (r.candidates || []).filter((c) => c.ok);
    if (!working.length) {
      const detail = r.open?.length ? `端口 ${r.open.join('、')} 开着，但都不像可用的 HTTP 代理` : '常见代理端口都没有在监听';
      toast(`没检测到可用代理：${detail}。请确认代理软件已开启，并且允许本机连接`, true);
      return null;
    }
    const best = working[0];
    await api('POST', '/api/proxy/apply', { url: best.url });
    await refresh();
    const others = working.slice(1).map((c) => c.url).join('、');
    toast(`✅ 已自动启用代理 ${best.url} —— ${best.detail}${others ? `（其他可用：${others}）` : ''}`);
    return best;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

function openAgentForm(agentId) {
  const agent = agentId ? state.agentMap.get(agentId) : null;
  const a = agent || {
    name: '', avatar: '', preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', systemPrompt: '', temperature: 0.85, maxTokens: 400, enabled: true, hasKey: false, apiKeyMask: '',
  };
  const html = `
    <div class="row2">
      <div class="field"><label>昵称</label><input type="text" id="f-name" value="${escapeHtml(a.name)}" placeholder="比如：小深" /></div>
      <div class="field" style="max-width:110px"><label>头像</label><input type="text" class="emoji-input" id="f-avatar" value="${escapeHtml(a.avatar || '')}" maxlength="4" placeholder="🐳" /></div>
    </div>
    <div class="field"><label>服务商</label><select id="f-preset">${providerOptions(a.preset)}</select>
      <div id="f-preset-info"></div>
    </div>
    <div class="field"><label>Base URL</label><input type="text" id="f-baseurl" value="${escapeHtml(a.baseUrl)}" /></div>
    <div class="field">
      <label>模型名</label>
      <div class="model-row">
        <input type="text" id="f-model" value="${escapeHtml(a.model)}" list="model-list" autocomplete="off" placeholder="直接用键盘输入任意模型名也可以" />
        <button type="button" class="soft-btn" id="f-fetch">获取模型列表</button>
      </div>
      <datalist id="model-list"></datalist>
      <div class="tip">服务商的「模型列表」接口经常滞后（新模型、带日期的版本号常常不在里面）—— <b>这个框可以直接手输，填什么就用什么</b>，用「测试连接」验证即可。</div>
      <div class="model-picker" id="f-picker" hidden></div>
    </div>
    <div class="field"><label>API Key ${a.hasKey ? `（已保存 ${escapeHtml(a.apiKeyMask)}，留空不改）` : ''}</label>
      <input type="password" id="f-apikey" value="" placeholder="${a.hasKey ? '留空 = 沿用已保存的 Key' : 'sk-...'}" autocomplete="off" /></div>
    <div class="row2">
      <div class="field"><label>温度</label><input type="number" id="f-temp" value="${a.temperature}" min="0" max="2" step="0.05" /></div>
      <div class="field"><label>单次最多输出 tokens</label><input type="number" id="f-maxtokens" value="${a.maxTokens}" min="16" max="32000" step="16" /></div>
    </div>
    <div class="checkline"><input type="checkbox" id="f-follow" ${a.followLevel !== false ? 'checked' : ''} /><label for="f-follow">跟随「AI 智力总控」（推荐：普通 / 聪明 / 智能在「对局设置」里选）</label></div>
    <div class="tip">取消勾选后，上面这两个数才对这个成员生效。带思考的模型（deepseek-v4-pro / kimi-k3 / glm-4.7 这类）建议 <b>≥ 2000</b>：填 400 会把预算全花在思考上、正文返回空。</div>
    <div class="field"><label>人设（可选）</label><textarea id="f-prompt" placeholder="比如：你是个老练的狼人，擅长假装好人。">${escapeHtml(a.systemPrompt)}</textarea></div>
    <div class="checkline"><input type="checkbox" id="f-enabled" ${a.enabled ? 'checked' : ''} /><label for="f-enabled">启用</label></div>
    <div id="test-result"></div>`;

  const testBtn = el('button', { class: 'ghost-btn', text: '🔌 测试连接' });
  const saveBtn = el('button', { class: 'primary-btn', text: agent ? '保存' : '添加' });
  const deleteBtn = agent
    ? el('button', { class: 'ghost-btn danger push-left', text: '🗑 删除', onclick: async () => {
        const ok = await confirmDialog({ title: '删除 AI', message: `确定删除「${agent.name}」？`, detail: '绑定它的座位会变成未绑定状态，频道和历史不受影响。', okText: '删除', danger: true });
        if (!ok) return;
        await api('DELETE', `/api/agents/${agent.id}`);
        toast('已删除');
        close();
        await refresh();
      } })
    : null;

  const modal = showModal({
    title: agent ? `编辑 AI：${agent.name}` : '添加 AI 玩家',
    size: 'w-lg',
    bodyHtml: html,
    footer: [deleteBtn, testBtn, saveBtn].filter(Boolean),
    mount: (body, modalEl, close) => {
      const presetSel = $('#f-preset', body);
      const baseInput = $('#f-baseurl', body);
      const modelInput = $('#f-model', body);
      const picker = $('#f-picker', body);
      const fetchBtn = $('#f-fetch', body);
      const closePicker = () => { picker.hidden = true; picker.innerHTML = ''; };

      /** 记住的模型名（按接口地址分组）：用户自己加过的 + 预设里带的 */
      const knownFor = () => {
        const url = baseInput.value.trim();
        const mine = (state.settings?.knownModels || {})[url] || [];
        return { mine, all: [...new Set([...mine, ...(presetOf(presetSel.value)?.models || [])])] };
      };

      const addKnownModel = async (name) => {
        const url = baseInput.value.trim();
        const m = String(name || '').trim();
        if (!url) return toast('请先填 Base URL', true);
        if (!m) return toast('请填模型名', true);
        modelInput.value = m;
        try {
          await api('POST', '/api/models/known', { baseUrl: url, model: m });
          await refresh();
          toast(`已记住「${m}」，下次会出现在常用列表里`);
          renderPicker([...modelCache.get(url) || []]);
        } catch (err) { toast(err.message, true); }
      };

      const removeKnownModel = async (name) => {
        const url = baseInput.value.trim();
        try {
          await api('POST', '/api/models/known', { baseUrl: url, model: name, remove: true });
          await refresh();
          renderPicker([...modelCache.get(url) || []]);
        } catch (err) { toast(err.message, true); }
      };

      const renderPicker = (models) => {
        picker.innerHTML = '';
        const filter = el('input', { class: 'model-filter', type: 'text', placeholder: `接口返回 ${models.length} 个，输入关键字筛选…` });
        const refreshBtn = el('button', { class: 'soft-btn', type: 'button', text: '↻ 重新获取', title: '接口列表可能是旧的，点这里强制刷新', onclick: () => loadModels(true) });
        filter.addEventListener('input', () => paint(filter.value));
        filter.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closePicker(); });

        // 手动添加：接口里没有的新模型就填这里
        const addInput = el('input', { class: 'model-filter', type: 'text', placeholder: '接口里没有？输入模型名（例如 deepseek-v4.1-flash）后回车' });
        addInput.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); addKnownModel(addInput.value); }
          if (e.key === 'Escape') closePicker();
        });
        const addRow = el('div', { class: 'model-add' }, [
          addInput,
          el('button', { class: 'soft-btn', type: 'button', text: '＋ 添加', onclick: () => addKnownModel(addInput.value) }),
        ]);

        // 常用 / 记住的模型
        const knownWrap = el('div', { class: 'model-known' });
        const { mine, all } = knownFor();
        if (all.length) {
          knownWrap.append(el('div', { class: 'tip', text: '常用模型（点一下填入，不用管接口给不给）：' }));
          const chips = el('div', { class: 'chip-list preset-models' });
          for (const m of all) {
            const isMine = mine.includes(m);
            const chip = el('div', { class: `chip${m === modelInput.value.trim() ? ' on' : ''}`, text: m, title: '点一下填入模型名', onclick: () => { modelInput.value = m; paint(modelInput.value); } });
            if (isMine) chip.append(el('span', { class: 'chip-x', text: '✕', title: '从我记住的列表里移除', onclick: (e) => { e.stopPropagation(); removeKnownModel(m); } }));
            chips.append(chip);
          }
          knownWrap.append(chips);
        }

        const list = el('div', { class: 'model-items' });
        function paint(q) {
          const kw = String(q || '').trim().toLowerCase();
          const hits = models.filter((m) => !kw || m.id.toLowerCase().includes(kw)).slice(0, 400);
          list.innerHTML = '';
          if (!hits.length) return list.append(el('div', { class: 'model-empty', text: models.length ? '没有匹配的模型' : '接口没有返回任何模型 —— 直接用上面的输入框手填模型名即可' }));
          for (const m of hits) {
            list.append(el('div', { class: `model-item${m.id === modelInput.value.trim() ? ' on' : ''}`, onclick: () => { modelInput.value = m.id; closePicker(); } }, [
              el('span', { class: 'mi-id', text: m.id }), m.ownedBy ? el('span', { class: 'mi-own', text: m.ownedBy }) : null,
            ]));
          }
        }

        picker.append(
          el('div', { class: 'model-head' }, [filter, refreshBtn]),
          addRow,
          knownWrap,
          el('div', { class: 'tip', text: `接口返回 ${models.length} 个模型（服务商的 /models 经常滞后，新模型可能不在里面，直接手填即可）：` }),
          list
        );
        picker.hidden = false;
        paint('');
        filter.focus();
      };

      const loadModels = async (force = false) => {
        const url = baseInput.value.trim();
        if (!url) return toast('请先填 Base URL', true);
        if (!force && modelCache.has(url)) return renderPicker(modelCache.get(url));
        fetchBtn.disabled = true;
        const old = fetchBtn.textContent;
        fetchBtn.textContent = '获取中…';
        try {
          const data = await api('POST', '/api/models', { id: agent?.id, baseUrl: url, apiKey: $('#f-apikey', body).value.trim() });
          if (!data.ok) return toast(data.error, true);
          modelCache.set(url, data.models);
          renderPicker(data.models);
        } catch (err) { toast(err.message, true); }
        finally { fetchBtn.disabled = false; fetchBtn.textContent = old; }
      };
      fetchBtn.onclick = () => { if (!picker.hidden) return closePicker(); return loadModels(false); };

      const fillPreset = (auto) => {
        const p = presetOf(presetSel.value);
        if (!p) return;
        if (auto && p.baseUrl) baseInput.value = p.baseUrl;
        if (auto && p.models?.length) modelInput.value = p.models[0];
        refreshDatalist();
        renderPresetInfo(p);
      };

      /** 输入框的下拉建议 = 预设模型 + 用户手填记住的模型 */
      function refreshDatalist() {
        const mine = (state.settings?.knownModels || {})[baseInput.value.trim()] || [];
        const all = [...new Set([...mine, ...(presetOf(presetSel.value)?.models || [])])];
        $('#model-list', body).innerHTML = all.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
      }

      /** 服务商附加信息：代理提醒 / 常用模型 / 申请 Key 链接 */
      function renderPresetInfo(p) {
        const box = $('#f-preset-info', body);
        box.innerHTML = '';
        if (!p) return;
        if (p.needsProxy) {
          const line = el('div', { class: 'warn-line' });
          if (state.proxy) {
            line.append(el('span', { text: `⚠️ ${p.label} 需要代理；当前已启用 ${state.proxy}` }));
          } else {
            line.append(el('span', { text: `⚠️ ${p.label} 在国内需要代理 —— Node 不会自动使用系统代理，所以这里很可能报"连接超时"。` }));
            line.append(el('button', { class: 'link-btn', type: 'button', text: '🔍 自动检测并启用代理', onclick: () => autoDetectProxy() }));
            line.append(el('span', { class: 'tip', text: '（也可以在「⚙ 设置」里手填端口，或把代理客户端切成 TUN 模式）' }));
          }
          box.append(line);
        }
        if (p.models?.length) {
          const chips = el('div', { class: 'chip-list preset-models' });
          for (const m of p.models) {
            chips.append(el('div', {
              class: `chip${m === modelInput.value.trim() ? ' on' : ''}`,
              text: m,
              title: '点一下填入模型名',
              onclick: () => { modelInput.value = m; renderPresetInfo(p); },
            }));
          }
          box.append(el('div', { class: 'tip', text: '常用模型（点一下直接填，不用等"获取模型列表"）：' }), chips);
        }
        if (p.keyUrl) {
          box.append(el('div', { class: 'tip' }, [
            el('a', { class: 'link-btn', href: p.keyUrl, target: '_blank', rel: 'noreferrer', text: '🔑 去申请 API Key' }),
            el('span', { text: ` ${p.keyUrl}` }),
          ]));
        }
        if (p.note) box.append(el('div', { class: 'tip', text: `说明：${p.note}` }));
      }

      presetSel.addEventListener('change', () => { closePicker(); fillPreset(true); });
      renderPresetInfo(presetOf(presetSel.value));
      baseInput.addEventListener('change', refreshDatalist);

      // 勾了「跟随智力总控」就禁用这两个输入框（值仍会保存，方便随时切回来）
      const followBox = $('#f-follow', body);
      const syncFollow = () => {
        $('#f-temp', body).disabled = followBox.checked;
        $('#f-maxtokens', body).disabled = followBox.checked;
      };
      followBox.addEventListener('change', syncFollow);
      syncFollow();

      fetchBtn.onclick = async () => {
        const url = baseInput.value.trim();
        if (!url) return toast('请先填 Base URL', true);
        if (!picker.hidden) return closePicker();
        if (modelCache.has(url)) return renderPicker(modelCache.get(url));
        fetchBtn.disabled = true;
        const old = fetchBtn.textContent;
        fetchBtn.textContent = '获取中…';
        try {
          const data = await api('POST', '/api/models', { id: agent?.id, baseUrl: url, apiKey: $('#f-apikey', body).value.trim() });
          if (!data.ok) return toast(data.error, true);
          modelCache.set(url, data.models);
          renderPicker(data.models);
        } catch (err) { toast(err.message, true); }
        finally { fetchBtn.disabled = false; fetchBtn.textContent = old; }
      };

      const collect = () => ({
        id: agent?.id,
        name: $('#f-name', body).value.trim(),
        avatar: $('#f-avatar', body).value.trim(),
        preset: presetSel.value,
        baseUrl: baseInput.value.trim(),
        model: modelInput.value.trim(),
        followLevel: $('#f-follow', body).checked,
        apiKey: $('#f-apikey', body).value.trim(),
        systemPrompt: $('#f-prompt', body).value,
        temperature: Number($('#f-temp', body).value),
        maxTokens: Number($('#f-maxtokens', body).value),
        enabled: $('#f-enabled', body).checked,
      });

      testBtn.onclick = async () => {
        const box = $('#test-result', body);
        testBtn.disabled = true;
        testBtn.textContent = '测试中…';
        try {
          const data = await api('POST', '/api/agents/test', collect());
          box.className = `test-result ${data.ok ? 'ok' : 'bad'}`;
          box.innerHTML = '';
          box.append(el('div', { text: data.ok ? `✅ 连接成功（${data.elapsedMs}ms）：${data.reply || '（空）'}` : `❌ ${data.error}` }));
          if (data.ok && data.paramFix && Object.keys(data.paramFix).length) {
            const fix = data.paramFix;
            box.append(el('div', {
              class: 'tip',
              text: `ℹ️ 这个模型对参数有硬性要求${fix.temperature === 'omit' ? '（不接受 temperature）' : `（只允许 temperature=${fix.temperature}）`}，程序已自动适配，不用改设置。`,
            }));
          }
        } catch (err) {
          box.className = 'test-result bad';
          box.textContent = `❌ ${err.message}`;
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = '🔌 测试连接';
        }
      };

      saveBtn.onclick = async () => {
        const payload = collect();
        if (!payload.name) return toast('请填昵称', true);
        saveBtn.disabled = true;
        try {
          if (agent) await api('PUT', `/api/agents/${agent.id}`, payload);
          else await api('POST', '/api/agents', payload);
          close();
          await refresh();
          toast(agent ? '已保存' : '已添加 AI');
        } catch (err) { toast(err.message, true); saveBtn.disabled = false; }
      };
    },
  });
  void modal;
}

/* ============================ 成员库的导出 / 导入 / 备份 ============================ */

function openExportAgents() {
  let text = '';
  showModal({
    title: '导出成员',
    size: 'w-lg',
    bodyHtml: '<div class="tip" id="ex-tip">正在生成…</div><textarea id="ex-text" class="json-box" readonly></textarea>',
    footer: [el('button', { class: 'primary-btn', text: '关闭', onclick: () => { MODAL_ROOT().hidden = true; } })],
    mount: async (body) => {
      try {
        const r = await api('GET', '/api/agents/export');
        text = r.json;
        const ta = $('#ex-text', body);
        ta.value = text;
        $('#ex-tip', body).innerHTML = `共 <b>${r.count}</b> 个成员（含 API Key）。全选复制下面的内容，存成 <code>members.json</code> 放好；重装或换电脑时用「导入成员」粘回来即可。`;
        ta.focus();
        ta.select();
      } catch (err) {
        $('#ex-tip', body).textContent = `导出失败：${err.message}`;
      }
    },
  });
}

function openImportAgents() {
  showModal({
    title: '导入成员',
    size: 'w-lg',
    bodyHtml: `<div class="tip">把之前导出的 JSON 粘进来（支持单个成员对象、成员数组、或导出文件的完整内容）。<br>
      同名 + 同接口地址的成员会被覆盖更新，其余新增；座位绑定和频道历史都不受影响。</div>
      <textarea id="im-text" class="json-box" placeholder='{"agents":[{"name":"小深","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-..."}]}'></textarea>`,
    footer: [
      el('button', { class: 'ghost-btn', text: '取消', onclick: () => { MODAL_ROOT().hidden = true; } }),
      el('button', {
        class: 'primary-btn', text: '开始导入', onclick: async (e) => {
          const btn = e.target;
          const json = $('#im-text', MODAL_ROOT()).value.trim();
          if (!json) return toast('先粘贴内容', true);
          btn.disabled = true;
          try {
            const r = await api('POST', '/api/agents/import', { json });
            MODAL_ROOT().hidden = true;
            await refresh();
            toast(`导入完成：新增 ${r.added} 个，更新 ${r.updated} 个，现在共 ${r.total} 个成员`);
            openAgentLibrary();
          } catch (err) {
            toast(err.message, true);
            btn.disabled = false;
          }
        },
      }),
    ],
  });
}

function openBackups() {
  showModal({
    title: '历史备份',
    size: 'w-lg',
    bodyHtml: '<div class="tip" id="bk-tip">正在读取…</div><div class="agent-grid" id="bk-list"></div>',
    footer: [el('button', { class: 'primary-btn', text: '关闭', onclick: () => { MODAL_ROOT().hidden = true; } })],
    mount: async (body) => {
      const list = $('#bk-list', body);
      try {
        const r = await api('GET', '/api/backups');
        $('#bk-tip', body).innerHTML = `数据文件：<code>${escapeHtml(r.dataFile)}</code>　程序每次保存都会更新「上一次保存前」，并按天保留最近 7 份。恢复只会补回成员，不会动当前对局。`;
        if (!r.backups.length) {
          list.append(el('div', { class: 'empty', text: '还没有备份' }));
          return;
        }
        for (const b of r.backups) {
          list.append(el('div', { class: 'agent-row' }, [
            el('div', { class: 'ar-info' }, [
              el('div', { class: 'ar-name' }, [el('span', { text: b.label }), el('span', { class: 'tag blue', text: `${b.agents} 个成员` })]),
              el('div', { class: 'ar-sub', text: `${b.agentNames?.join('、') || '（无成员）'}　·　${new Date(b.mtime).toLocaleString('zh-CN')}　·　${(b.size / 1024).toFixed(1)} KB` }),
            ]),
            el('button', {
              class: 'soft-btn', text: '恢复成员库', onclick: async (e) => {
                const ok = await confirmDialog({
                  title: '恢复成员库',
                  message: `从「${b.label}」恢复 ${b.agents} 个成员？`,
                  detail: '同名同地址的成员会被覆盖，其余新增；当前对局和频道历史不受影响。',
                  okText: '恢复',
                });
                if (!ok) return;
                e.target.disabled = true;
                try {
                  const res = await api('POST', '/api/backups/restore', { name: b.name });
                  await refresh();
                  toast(`已恢复：新增 ${res.added} 个，更新 ${res.updated} 个，现在共 ${res.total} 个成员`);
                } catch (err) {
                  toast(err.message, true);
                  e.target.disabled = false;
                }
              },
            }),
          ]));
        }
      } catch (err) {
        $('#bk-tip', body).textContent = `读取失败：${err.message}`;
      }
    },
  });
}

function openAgentLibrary() {
  const exportBtn = el('button', { class: 'ghost-btn', text: '📤 导出成员', onclick: openExportAgents });
  const importBtn = el('button', { class: 'ghost-btn', text: '📥 导入成员', onclick: openImportAgents });
  const backupBtn = el('button', { class: 'ghost-btn', text: '🕘 历史备份', onclick: openBackups });
  showModal({
    title: 'AI 成员库',
    size: 'w-lg',
    bodyHtml: `<div class="agent-grid" id="ag-list"></div>
      <div class="tip" style="margin-top:12px">
        成员（含 API Key）只保存在本机数据文件里：<code>${escapeHtml(state.dataFile || '')}</code><br>
        程序每次保存都会留一份上一版备份，并按天备份最近 7 天；换版本重装都不会动这个文件。
        <b>建议加完成员就点一次「导出成员」存一份</b>，以后换电脑/重装直接导入。
      </div>`,
    footer: [exportBtn, importBtn, backupBtn, el('button', { class: 'primary-btn', text: '＋ 添加 AI 玩家', onclick: () => openAgentForm(null) })],
    mount: (body) => {
      const list = $('#ag-list', body);
      if (!state.agents.length) {
        list.append(el('div', { class: 'empty', html: '<span class="big">🧩</span>还没有 AI，先添加一个' }));
        return;
      }
      for (const a of state.agents) {
        list.append(el('div', { class: 'agent-row' }, [
          el('div', { class: 'avatar', text: a.avatar || '🤖', style: a.color ? `background:${softColor(a.color)}` : '' }),
          el('div', { class: 'ar-info' }, [
            el('div', { class: 'ar-name' }, [
              el('span', { text: a.name }),
              a.enabled ? el('span', { class: 'tag ok', text: '启用' }) : el('span', { class: 'tag', text: '停用' }),
              a.hasKey ? el('span', { class: 'tag blue', text: 'Key ✓' }) : el('span', { class: 'tag warn', text: '缺 Key' }),
            ]),
            el('div', { class: 'ar-sub', text: `${a.model} · ${a.baseUrl}` }),
          ]),
          el('button', { class: 'soft-btn', text: '编辑', onclick: () => openAgentForm(a.id) }),
        ]));
      }
    },
  });
}

/* ============================ 设置 ============================ */
function openSettings() {
  const s = state.settings;
  const html = `
    <div class="field"><label>主持人称呼</label><input type="text" id="set-host" value="${escapeHtml(s.hostName || '主持人')}" /></div>
    <div class="field">
      <label>网络代理（可选）</label>
      <div class="model-row">
        <input type="text" id="set-proxy" placeholder="http://127.0.0.1:7897" value="${escapeHtml(s.proxy || '')}" />
        <button type="button" class="soft-btn" id="set-proxy-detect" title="扫描本机常见代理端口并验证是否可用">🔍 自动检测</button>
      </div>
      <div class="tip">
        <b>Node.js 不会自动使用 Windows 的"系统代理"</b>，所以如果你用 Clash / v2rayN 这类客户端（系统代理模式），
        访问 Gemini、OpenAI 等站点会直接超时。<b>不确定端口就点「🔍 自动检测」</b>，程序会扫一遍并自动填好。<br>
        常见端口：<code>Clash Verge → 7897</code>、<code>Clash for Windows → 7890</code>、<code>v2rayN → 10809</code>。
        不支持 socks5；也可以把客户端切成 <b>TUN / 虚拟网卡（全局）</b> 模式，那样就不用填这里。
      </div>
    </div>
    <div class="field">
      <label>AI 智力总控</label>
      <div class="level-row" id="set-level">
        ${(state.aiLevels || []).map((lv) => `<button type="button" data-level="${lv.id}" title="${escapeHtml(lv.desc || '')}">${lv.label}</button>`).join('')}
        <button type="button" data-level="custom" title="自己填下面三个数">自定义</button>
      </div>
      <div class="tip" id="set-level-tip"></div>
    </div>
    <div class="row2">
      <div class="field"><label>上下文条数（每个频道带入多少条历史）</label><input type="number" id="set-ctx" value="${s.contextLimit ?? 60}" min="10" max="400" /></div>
      <div class="field"><label>单次发言最多 tokens</label><input type="number" id="set-max" value="${s.maxTokens ?? 1600}" min="64" max="32000" /></div>
    </div>
    <div class="row2">
      <div class="field"><label>温度（越高越随性）</label><input type="number" id="set-temp" value="${s.temperature ?? 0.85}" min="0" max="2" step="0.05" /></div>
      <div class="field"><label>胜负规则</label>
        <select id="set-winrule">
          <option value="side"${s.winRule !== 'all' ? ' selected' : ''}>屠边（杀光神职 或 平民，标准）</option>
          <option value="all"${s.winRule === 'all' ? ' selected' : ''}>屠城（杀光所有好人）</option>
        </select>
      </div>
    </div>
    <div class="field"><label>女巫自救规则</label>
      <select id="set-selfsave">
        <option value="first-night"${s.witchSelfSave === 'first-night' ? ' selected' : ''}>仅首夜可自救（标准）</option>
        <option value="never"${s.witchSelfSave === 'never' ? ' selected' : ''}>永远不能自救</option>
        <option value="always"${s.witchSelfSave === 'always' ? ' selected' : ''}>随时可以自救</option>
      </select>
    </div>
    <div class="field"><label>遗言与开枪的先后</label>
      <select id="set-lworder">
        <option value="beforeShot"${s.lastWordsOrder !== 'afterShot' ? ' selected' : ''}>先留遗言，再开枪（默认）</option>
        <option value="afterShot"${s.lastWordsOrder === 'afterShot' ? ' selected' : ''}>先开枪，再留遗言</option>
      </select>
    </div>
    <div class="field">
      <label>谁出局后可以留遗言</label>
      ${[
        ['firstNight', '首夜被狼刀'],
        ['laterNights', '第二夜及以后被狼刀'],
        ['votedOut', '白天被投票放逐'],
        ['poisoned', '被女巫毒杀'],
        ['shot', '被猎人/狼王开枪带走'],
        ['exploded', '被白狼王自爆带走'],
      ].map(([key, text]) => `
        <div class="checkline" style="margin-bottom:6px">
          <input type="checkbox" id="lw-${key}" ${(s.lastWords || {})[key] ? 'checked' : ''} />
          <label for="lw-${key}">${text}</label>
        </div>`).join('')}
      <div class="tip">标准规则：首夜死亡有遗言、之后的夜晚死亡无遗言、白天被放逐有遗言、被开枪带走无遗言。</div>
    </div>
    <div class="checkline" style="margin-bottom:10px"><input type="checkbox" id="set-sheriff" ${s.sheriffEnabled !== false ? 'checked' : ''} /><label for="set-sheriff">启用警长（上警竞选 · 1.5 票 · 决定发言顺序 · 出局移交警徽）</label></div>
    <div class="checkline" style="margin-bottom:10px"><input type="checkbox" id="set-tie" ${s.tieRevote ? 'checked' : ''} /><label for="set-tie">投票平票时重投（不勾选则本轮无人出局）</label></div>
    <div class="checkline" style="margin-bottom:10px"><input type="checkbox" id="set-onepotion" ${s.onePotionPerNight !== false ? 'checked' : ''} /><label for="set-onepotion">女巫同一晚只能用一瓶药（标准）</label></div>
    <div class="checkline" style="margin-bottom:10px"><input type="checkbox" id="set-sameguard" ${s.sameGuardAndSaveDies !== false ? 'checked' : ''} /><label for="set-sameguard">同守同救必死（守卫和女巫同时保一个人时该玩家死亡）</label></div>
    <div class="checkline"><input type="checkbox" id="set-nokill" ${s.allowWolfNoKill ? 'checked' : ''} /><label for="set-nokill">允许狼人空刀</label></div>`;
  const saveBtn = el('button', { class: 'primary-btn', text: '保存' });
  showModal({
    title: '对局设置',
    size: 'w-md',
    bodyHtml: html,
    footer: [saveBtn],
    mount: (body, modalEl, close) => {
      // ---------- 智力总控：选档位 → 自动填下面三个数；手动改任一个 → 变「自定义」 ----------
      let level = state.aiLevel || 'smart';
      const levels = state.aiLevels || [];
      const levelBtns = [...body.querySelectorAll('#set-level button')];
      const paintLevel = () => {
        for (const b of levelBtns) b.classList.toggle('on', b.dataset.level === level);
        const lv = levels.find((x) => x.id === level);
        $('#set-level-tip', body).innerHTML = lv
          ? `${escapeHtml(lv.desc || '')} —— 上下文 <b>${lv.contextLimit}</b> 条 · 单次输出 <b>${lv.maxTokens}</b> tokens · 温度 <b>${lv.temperature}</b>${(lv.extraRules || []).length ? '<br>会额外要求 AI 先盘点局面、再开口' : ''}`
          : '自定义：下面三个数直接生效。单个成员若取消「跟随总控」，则用成员自己的值。';
      };
      const applyLevel = (id) => {
        level = id;
        const lv = levels.find((x) => x.id === id);
        if (lv) {
          $('#set-ctx', body).value = lv.contextLimit;
          $('#set-max', body).value = lv.maxTokens;
          $('#set-temp', body).value = lv.temperature;
        }
        paintLevel();
      };
      for (const b of levelBtns) b.onclick = () => applyLevel(b.dataset.level);
      // 打开时：档位是预设，就把三个输入框对齐成这一档实际用的数字（所见即所用）
      if (level !== 'custom') applyLevel(level);
      else paintLevel();
      for (const id of ['set-ctx', 'set-max', 'set-temp']) {
        $(`#${id}`, body).addEventListener('input', () => { if (level !== 'custom') { level = 'custom'; paintLevel(); } });
      }
      $('#set-proxy-detect', body).onclick = async () => {
        const best = await autoDetectProxy();
        if (best) $('#set-proxy', body).value = best.url;
      };
      saveBtn.onclick = async () => {
        await api('PUT', '/api/settings', {
          hostName: $('#set-host', body).value.trim() || '主持人',
          aiLevel: level,
          contextLimit: Number($('#set-ctx', body).value),
          maxTokens: Number($('#set-max', body).value),
          temperature: Number($('#set-temp', body).value),
          winRule: $('#set-winrule', body).value,
          witchSelfSave: $('#set-selfsave', body).value,
          lastWordsOrder: $('#set-lworder', body).value,
          sheriffEnabled: $('#set-sheriff', body).checked,
          lastWords: {
            firstNight: $('#lw-firstNight', body).checked,
            laterNights: $('#lw-laterNights', body).checked,
            votedOut: $('#lw-votedOut', body).checked,
            poisoned: $('#lw-poisoned', body).checked,
            shot: $('#lw-shot', body).checked,
            exploded: $('#lw-exploded', body).checked,
          },
          tieRevote: $('#set-tie', body).checked,
          onePotionPerNight: $('#set-onepotion', body).checked,
          sameGuardAndSaveDies: $('#set-sameguard', body).checked,
          allowWolfNoKill: $('#set-nokill', body).checked,
          proxy: $('#set-proxy', body).value.trim(),
        });
        close();
        await refresh();
        toast('已保存');
      };
    },
  });
}

/* 发言队列条：把"现在轮到谁"显示出来 */
function renderQueue() {
  const strip = $('#queue-strip');
  const q = state.queue;
  const phase = state.game?.phase;
  if (!q || !q.list?.length || (phase !== 'day' && phase !== 'vote') || state.view === 'audience') {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.innerHTML = '';
  strip.append(el('span', { class: 'q-label', text: '发言顺序' }));
  for (const item of q.list) {
    strip.append(el('span', {
      class: `queue-chip ${item.state}`,
      title: item.state === 'current' ? '现在轮到这位发言' : item.state === 'spoken' ? '已经发过言' : item.alive ? '等待发言' : '已出局',
      text: `${item.number}号 ${item.name}`,
    }));
  }
  strip.append(el('span', {
    class: 'q-label',
    text: q.finished ? '本轮发言已结束 → 可以开始投票' : `已发言 ${q.spokenCount} / ${q.aliveTotal}`,
  }));
}

/* ============================ 渲染总入口 ============================ */
function renderAll({ keepScroll } = {}) {
  renderChannels();
  renderHeader();
  renderControls();
  renderQueue();
  renderCandidates();
  renderSeats();
  renderMessages();
}

/* ============================ SSE ============================ */
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message.created':
      appendMessageLive(ev.channelId, ev.message);
      break;
    case 'message.delta': {
      if (ev.channelId !== state.activeChannel) break;
      const entry = state.liveEls.get(ev.messageId);
      if (!entry) break;
      if (ev.channel === 'reasoning') entry.msg.reasoning = (entry.msg.reasoning || '') + ev.text;
      else entry.msg.content = (entry.msg.content || '') + ev.text;
      paintMessage(entry.refs, entry.msg);
      scrollBottom();
      break;
    }
    case 'message.updated':
      updateMessageLive(ev.channelId, ev.message);
      break;
    case 'seat.typing': {
      if (ev.typing) state.typingSeatIds.add(ev.seatId);
      else state.typingSeatIds.delete(ev.seatId);
      renderSeats();
      renderHeader();
      break;
    }
    case 'game.changed':
      state.game = ev.game;
      renderChannels();
      renderControls();
      renderHeader();
      // 队列随阶段推进变化，重新拉一次状态里的 queue
      refresh().catch(() => {});
      break;    case 'seats.changed':
      if (state.view !== 'audience') state.seats = ev.seats;
      renderSeats();
      break;
    case 'channels.changed':
    case 'agents.changed':
    case 'settings.changed':
      refresh().catch(() => {});
      break;
    case 'prompt.built':
      break;
    default:
      break;
  }
}

/* ============================ 启动 ============================ */
function bindUi() {
  $('#btn-agents').onclick = openAgentLibrary;
  $('#btn-settings').onclick = openSettings;
  $('#btn-isolation').onclick = runIsolationCheck;
  $('#btn-newgame').onclick = openNewGame;
  $('#btn-stop').onclick = () => hostAction('stop');
  $('#btn-send').onclick = sendHostMessage;
  $('#btn-view').onclick = async () => {
    state.view = state.view === 'host' ? 'audience' : 'host';
    await refresh();
    toast(state.view === 'audience' ? '已切到观众视角：只能看到公共频道' : '已切回主持人视角');
  };
  const input = $('#input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendHostMessage();
    }
  });
}

async function boot() {
  bindUi();
  connectEvents();
  try {
    await refresh();
  } catch (err) {
    toast(`加载失败：${err.message}`, true);
  }
  if (!state.agents.length) {
    setTimeout(() => toast('先到左下角「AI 成员库」添加几个大模型，再给座位绑定'), 700);
  }
}

boot();
