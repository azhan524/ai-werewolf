/**
 * 端到端测试（AI 狼人杀 · 标准 12 人局）
 *
 * 覆盖：
 *   ① 消息隔离 —— 每个 AI 只能读到有权频道（频道名 + 唯一标记串双重断言 + 模型自报）
 *   ② 死后流程 —— 遗言（首夜有 / 之后夜无）、猎人开枪、警徽移交、已出局者不能再发言
 *   ③ 警长 —— 上警表态、竞选投票、1.5 票、决定发言顺序
 *   ④ 12 人局规则 —— 守卫、同守同救、白痴翻牌、白狼王自爆、屠边胜负
 *   ⑤ 发言秩序 —— 不会抢麦、不会漏麦
 *   ⑥ 频道持久 —— 换模型 / 开新一局都不重建频道
 *
 * 用法：先启动 test/mock-llm.js 和 PORT=8791 的应用，再 node test/e2e.mjs
 */
const BASE = process.env.APP_URL || 'http://127.0.0.1:8791';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8801/v1';

const CH = { lobby: '公共频道', wolf: '狼人频道', seer: '预言家频道', witch: '女巫频道', guard: '守卫频道' };
const MARKER = 'WOLF_ONLY_SECRET_7f3a9c';

const ALLOWED = {
  wolf: ['lobby', 'wolf'], wolfking: ['lobby', 'wolf'], whitewolfking: ['lobby', 'wolf'],
  seer: ['lobby', 'seer'], witch: ['lobby', 'witch'], guard: ['lobby', 'guard'],
  hunter: ['lobby'], idiot: ['lobby'], villager: ['lobby'],
};
const WOLF_ROLES = ['wolf', 'wolfking', 'whitewolfking'];

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}
const section = (t) => console.log(`\n──── ${t} ────`);

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
const state = (view = 'host') => api('GET', `/api/state?view=${view}`);
const host = (action, body = {}) => api('POST', `/api/host/${action}`, body);
const lobbyMsgs = (st) => st.channels.find((c) => c.id === 'lobby').messages;

function historySection(messages) {
  const user = messages.find((m) => m.role === 'user')?.content || '';
  const start = user.indexOf('【你可视频道的历史记录');
  const end = user.indexOf('【当前任务】');
  return user.slice(start >= 0 ? start : 0, end >= 0 ? end : user.length);
}
function channelsInPrompt(messages) {
  const hist = historySection(messages);
  return Object.entries(CH).filter(([, name]) => hist.includes(`[${name}]`)).map(([id]) => id);
}

async function main() {
  console.log(`\n== AI 狼人杀（12 人局）端到端测试 ==\n应用：${BASE}\n假模型：${MOCK}\n`);

  // 先把设置归到基准值，避免上一次运行残留的配置影响断言
  await api('PUT', '/api/settings', {
    sheriffEnabled: true,
    tieRevote: true,
    lastWordsOrder: 'beforeShot',
    winRule: 'side',
    witchSelfSave: 'first-night',
    onePotionPerNight: true,
    sameGuardAndSaveDies: true,
    allowWolfNoKill: false,
    lastWords: { firstNight: true, laterNights: false, votedOut: true, poisoned: false, shot: false, exploded: false },
  });

  /* ================= 0. 频道 ================= */
  section('频道系统');
  let st = await state();
  check('启动即创建全部固定频道', st.channels.length === 5, st.channels.map((c) => c.name).join(' / '));
  const channelIds = st.channels.map((c) => c.id).sort().join(',');

  /* ================= 1. 开局 ================= */
  section('开局：12 人标准局（预女猎白）');
  // 顺手验证"余额不足"这类错误能被翻成中文
  const noBalance = await api('POST', '/api/agents/test', { name: '余额测试', baseUrl: MOCK, model: 'mock-no-balance', apiKey: 'sk-x' });
  check('余额不足时给出中文提示', noBalance.ok === false && /余额|额度/.test(noBalance.error || ''), noBalance.error);
  // 有些模型只允许 temperature=1（Kimi K2 / OpenAI o 系列），程序要能自动适配
  const strictTemp = await api('POST', '/api/agents/test', { name: '温度测试', baseUrl: MOCK, model: 'mock-strict-temp', apiKey: 'sk-x', temperature: 0.85 });
  check('模型只允许 temperature=1 时自动适配并连接成功', strictTemp.ok === true && strictTemp.paramFix?.temperature === 1,
    strictTemp.ok ? `已适配为 temperature=${strictTemp.paramFix?.temperature}` : strictTemp.error);
  const strictTemp2 = await api('POST', '/api/agents/test', { name: '温度测试', baseUrl: MOCK, model: 'mock-strict-temp', apiKey: 'sk-x', temperature: 0.85 });
  check('同一个模型第二次直接走适配后的参数（有缓存）', strictTemp2.ok === true, strictTemp2.reply || strictTemp2.error);

  const agents = [];
  for (let i = 1; i <= 6; i++) {
    agents.push(await api('POST', '/api/agents', {
      name: `模型${i}`, avatar: '🤖', baseUrl: MOCK, model: 'werewolf-mock',
      apiKey: 'sk-test', temperature: 0.8, maxTokens: 300, enabled: true,
    }));
  }
  await api('POST', '/api/game/new', {
    rolePlan: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'],
    agentIds: agents.map((a) => a.id),
  });
  st = await state();
  check('座位数为 12 且身份配比正确',
    st.seats.length === 12 && st.seats.filter((s) => s.role === 'wolf').length === 4 &&
    st.seats.filter((s) => ['seer', 'witch', 'hunter', 'idiot'].includes(s.role)).length === 4 &&
    st.seats.filter((s) => s.role === 'villager').length === 4,
    `狼${st.seats.filter((s) => s.role === 'wolf').length} 神${st.seats.filter((s) => ['seer', 'witch', 'hunter', 'idiot'].includes(s.role)).length} 民${st.seats.filter((s) => s.role === 'villager').length}`);

  const FORCED = { 1: 'hunter', 2: 'wolf', 3: 'wolf', 4: 'wolfking', 5: 'wolf', 6: 'seer', 7: 'witch', 8: 'guard', 9: 'idiot', 10: 'villager', 11: 'villager', 12: 'villager' };
  for (const [num, role] of Object.entries(FORCED)) {
    await api('PUT', `/api/seats/${st.seats.find((s) => s.number === Number(num)).id}`, { role });
  }
  st = await state();
  check('主持人可指定座位身份（剧本局）', st.seats.every((s) => s.role === FORCED[s.number]));
  const seatOf = (role) => st.seats.find((s) => s.role === role);
  const seatByNumber = (n) => st.seats.find((s) => s.number === n);
  const hunterSeat = seatOf('hunter'), wolfSeat = seatOf('wolf'), seerSeat = seatOf('seer');
  const witchSeat = seatOf('witch'), guardSeat = seatOf('guard'), idiotSeat = seatOf('idiot');
  const villagerSeat = seatOf('villager');

  /* ================= 2. 消息隔离 ================= */
  section('消息隔离（9 类身份权限）');
  await host('say', { channelId: 'wolf', content: `今晚的计划代号 ${MARKER}，只有狼人能看到。` });
  const promptFor = (seatId, channelId) => api('POST', '/api/debug/prompt', { seatId, channelId });
  const cases = [
    ['平民', villagerSeat, 'lobby'], ['猎人', hunterSeat, 'lobby'], ['白痴', idiotSeat, 'lobby'],
    ['预言家', seerSeat, 'seer'], ['女巫', witchSeat, 'witch'], ['守卫', guardSeat, 'guard'], ['狼人', wolfSeat, 'wolf'],
  ];
  for (const [label, seat, channel] of cases) {
    const p = await promptFor(seat.id, channel);
    const got = channelsInPrompt(p.messages).sort();
    const expected = ALLOWED[seat.role].slice().sort();
    const leaked = p.messages.some((m) => m.content.includes(MARKER)) && !expected.includes('wolf');
    check(`${label}（${seat.number}号）的 prompt = ${expected.map((id) => CH[id]).join('+')}`,
      got.join(',') === expected.join(',') && !leaked,
      `实际：${got.map((id) => CH[id]).join('、')}${leaked ? ' ⛔ 泄漏' : ''}`);
  }
  check('隔离自检全部通过（12 个座位）', (await host('checkIsolation')).report.ok === true);
  await host('seatSpeak', { seatId: villagerSeat.id, channelId: 'lobby' });
  await host('seatSpeak', { seatId: wolfSeat.id, channelId: 'lobby' });
  st = await state();
  const vMsg = [...lobbyMsgs(st)].reverse().find((m) => m.seatId === villagerSeat.id);
  const wMsg = [...lobbyMsgs(st)].reverse().find((m) => m.seatId === wolfSeat.id);
  check('平民真实调用后自报只看得到公共频道', vMsg.content.includes('可见频道：公共频道') && !vMsg.content.includes(CH.wolf), vMsg.content.slice(-26));
  check('狼人真实调用后自报看得到狼人频道', wMsg.content.includes(CH.wolf), wMsg.content.slice(-30));

  /* ================= 3. 第一夜 ================= */
  section('第一夜：守卫 / 狼刀 / 验人 / 女巫（同守同救）');
  await host('night');
  const guardRun = await host('guard');
  const wolfRun = await host('wolves');
  const seerRun = await host('seer');
  await host('seerReveal', { number: seerRun.check.number });
  await host('witchAsk');
  const witchRun = await host('witch');
  await host('witchApply');
  const dawn = await host('dawn');
  check('守卫守人 / 狼刀 / 验人 / 女巫决定都成功',
    !!guardRun.guard?.number && !!wolfRun.kill?.number && !!seerRun.check?.number && witchRun.decision?.save === true,
    `守${guardRun.guard?.number} 刀${wolfRun.kill?.number} 验${seerRun.check?.number} 救=${witchRun.decision?.save}`);
  check('触发同守同救 → 该玩家死亡', dawn.report.sameGuardAndSave === true && dawn.report.deaths.length === 1, dawn.report.killNote);

  /* ================= 4. ★ 死后流程 ================= */
  section('死后流程：遗言 → 警徽 → 开枪');
  st = await state();
  const deadNumber = dawn.report.deaths[0].number;
  check('首夜死亡者进入遗言队列', (st.game.pendingLastWords || []).some((x) => x.seatNumber === deadNumber), `待遗言：${(st.game.pendingLastWords || []).map((x) => x.seatNumber + '号').join('、')}`);
  check('白天第一步就是遗言（而不是直接发言）', st.game.dayStep === 'lastwords', `dayStep=${st.game.dayStep}`);

  const lwMsgsBefore = lobbyMsgs(st).filter((m) => m.meta?.reason === 'last-words').length;
  const lwRun = await host('lastWords');
  st = await state();
  const lwMsgs = lobbyMsgs(st).filter((m) => m.meta?.reason === 'last-words');
  check('已出局的玩家可以发表遗言（这是唯一合法的死后发言）', lwMsgs.length === lwMsgsBefore + 1 && lwMsgs.at(-1).seatNumber === deadNumber,
    `「${lwMsgs.at(-1)?.content?.slice(0, 24)}…」`);
  check('遗言说完了就出队', !(st.game.pendingLastWords || []).some((x) => x.seatNumber === deadNumber));

  // 死后不能随便发言
  const deadSpeak = await fetch(`${BASE}/api/host/seatSpeak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatId: seatByNumber(deadNumber).id, channelId: 'lobby' }),
  });
  check('已出局玩家不能"随便发言"（只能通过遗言/开枪通道）', deadSpeak.status === 400, `HTTP ${deadSpeak.status}`);

  check('遗言结束后进入开枪步骤', st.game.dayStep === 'shot', `dayStep=${st.game.dayStep}`);
  const shot = await host('shoot');
  st = await state();
  check('猎人开枪带走目标', shot.ok === true && !shot.needManual && st.seats.find((s) => s.number === shot.target).alive === false, `带走 ${shot.target}号`);
  check('开枪结束后进入警长竞选', st.game.dayStep === 'campaign', `dayStep=${st.game.dayStep}`);

  /* ================= 5. ★ 警长 ================= */
  section('警长：上警 → 竞选投票 → 特权 → 移交警徽');
  const campaign = await host('campaign');
  check('所有存活玩家都做了上警表态', campaign.results.length === st.seats.filter((s) => s.alive).length, `${campaign.results.length} 人表态`);
  check('解析出上警候选人', campaign.candidates.length > 0, `候选人：${campaign.candidates.join('、')}`);
  st = await state();
  check('表态结束后进入警长投票（而不是重复上警）', st.game.dayStep === 'sheriffVote', `dayStep=${st.game.dayStep}`);

  const sv = await host('sheriffVote');
  check('警长竞选投票完成（候选人不参与投票）', sv.tally.detail.length > 0, `${sv.tally.detail.length} 人投了票，明细 ${sv.tally.counts.map((c) => c.target + '号' + c.count + '票').join('、')}`);
  st = await state();
  if (sv.needPK) {
    check('平票 → 进入 PK 发言 + 重投（标准规则）', st.game.dayStep === 'sheriffPK', `平票：${sv.pkCandidates.join('、')}号`);
    const pk = await host('sheriffPK');
    check('PK 之后重投选出警长', !!pk.sheriff, pk.sheriff ? `${pk.sheriff.number}号 ${pk.sheriff.name}（${pk.tally.max} 票）` : '依然平票 → 警徽流失');
    st = await state();
  } else {
    check('警长竞选产生了警长', !!sv.sheriff, sv.sheriff ? `${sv.sheriff.number}号 ${sv.sheriff.name}（${sv.tally.max} 票）` : '平票/无警长');
  }
  check('状态里带出警长信息', !!st.sheriff, `警长：${st.sheriff?.number}号 ${st.sheriff?.name}`);
  check('座位面板标出了警长', st.seats.find((s) => s.id === st.sheriff.seatId)?.sheriff === true);
  check('警长产生后进入发言环节', st.game.dayStep === 'speak', `dayStep=${st.game.dayStep}`);

  // 警长决定发言顺序
  const sheriffSeat = st.seats.find((s) => s.id === st.sheriff.seatId);
  const orderRun = await host('askOrder');
  st = await state();
  check('警长可以指定今天的发言顺序', orderRun.ok === true && Array.isArray(orderRun.order), `顺序：${(orderRun.order || []).join(' → ')}`);
  check('发言队列已按警长指定的顺序重排', st.queue.list[0].number === orderRun.order[0], `队列首位 ${st.queue.list[0].number}号`);

  /* ================= 6. 白天发言 + 投票 ================= */
  section('白天发言 → 放逐投票（警长 1.5 票 + 出局遗言 + 警徽移交）');
  await host('dayAll');
  st = await state();
  const dayMsgs = lobbyMsgs(st).filter((m) => ['day-speak-auto', 'day-speak'].includes(m.meta?.reason));
  const roleOf = (id) => st.seats.find((x) => x.id === id)?.role;
  check('每位存活玩家都发言一次（不重不漏）', new Set(dayMsgs.map((m) => m.seatId)).size === st.queue.aliveTotal, `${new Set(dayMsgs.map((m) => m.seatId)).size} 人 / 存活 ${st.queue.aliveTotal} 人`);
  check('发言带入的频道都在本人权限内', dayMsgs.every((m) => (m.meta.includedChannels || []).every((id) => ALLOWED[roleOf(m.seatId)]?.includes(id))));
  check('非狼人发言绝不带狼人频道', dayMsgs.filter((m) => !WOLF_ROLES.includes(roleOf(m.seatId))).every((m) => !(m.meta.includedChannels || []).includes('wolf')));

  // 警长归票（标准流程：所有人发言完、投票前，警长最后总结发言）
  const stNow = await state();
  const sheriffSeatNow = stNow.seats.find((s) => s.id === stNow.game.sheriffId);
  if (sheriffSeatNow && sheriffSeatNow.alive) {
    const summary = await host('sheriffSummary');
    st = await state();
    const summaryMsg = lobbyMsgs(st).filter((m) => m.meta?.reason === 'sheriff-summary');
    check('警长可以做出最后的归票发言', summary.ok && summaryMsg.length === 1, `「${summaryMsg.at(-1)?.content?.slice(0, 26)}…」`);
    check('归票后状态被记录下来', st.game.sheriffSummarized === true);
    const vs = await host('voteStart');
    check('归票之后开始投票不再提示', !vs.warning, vs.warning || '无提示');
  } else {
    await host('voteStart');
    check('警长已出局时跳过归票（不阻塞流程）', true);
  }
  for (const s of st.seats.filter((x) => x.alive)) {
    await host('seatSpeak', { seatId: s.id, channelId: 'lobby', task: `现在是放逐投票。请投票给 ${sheriffSeat.number}号，格式：投票：${sheriffSeat.number}号` });
  }
  const voteResult = await host('voteResolve');
  const sheriffVoteDetail = voteResult.result.detail.find((d) => d.sheriff);
  check('警长的票按 1.5 计', !!sheriffVoteDetail && sheriffVoteDetail.weight === 1.5, sheriffVoteDetail ? `${sheriffVoteDetail.voterNumber}号 权重 ${sheriffVoteDetail.weight}` : '没找到警长的票');
  check('警长被票出局', voteResult.exiled?.number === sheriffSeat.number, voteResult.exiled ? `${voteResult.exiled.number}号 出局` : '无人出局');

  st = await state();
  check('被票出局者进入遗言队列', (st.game.pendingLastWords || []).some((x) => x.seatNumber === sheriffSeat.number), `dayStep=${st.game.dayStep}`);
  await host('lastWords');
  st = await state();
  check('遗言之后处理警徽（警长出局必须移交或撕掉）', st.game.dayStep === 'badge' && !!st.game.pendingBadge, `dayStep=${st.game.dayStep}`);

  const badgeRun = await host('badge');
  st = await state();
  check('警徽成功移交 / 撕掉', badgeRun.ok === true && (badgeRun.applied?.target || badgeRun.applied?.torn), badgeRun.applied?.target ? `给了 ${badgeRun.applied.target.number}号` : '撕掉了');
  if (badgeRun.applied?.target) {
    check('警长身份已转移', st.sheriff?.seatId === badgeRun.applied.target.id, `新警长 ${st.sheriff?.number}号`);
  }
  // 出局的若是狼王/猎人，遗言和警徽之后还要开枪
  if (st.game.dayStep === 'shot') {
    check('出局者带枪 → 处理完遗言与警徽后先开枪', true, `待开枪：${st.game.pendingShot?.seatNumber}号`);
    await host('shoot');
    st = await state();
  }
  check('遗言+警徽（+开枪）处理完，白天流程结束', st.game.dayStep === 'done', `dayStep=${st.game.dayStep}`);

  /* ================= 7. 第二轮夜晚：无遗言 ================= */
  section('第二夜：之后的夜间死亡没有遗言（标准规则）');
  await host('night');
  for (const act of ['guard', 'wolves', 'seer', 'seerReveal', 'witchAsk', 'witch', 'witchApply']) {
    try { await host(act); } catch { /* 该角色可能已出局 */ }
  }
  await host('dawn');
  st = await state();
  const night2Deaths = st.game.lastNightReport?.deaths || [];
  check('第二夜确实有人死亡', night2Deaths.length >= 1, night2Deaths.map((d) => `${d.number}号(${d.reason})`).join('、') || '平安夜');
  check('之后的夜间死亡不再有遗言（被毒死也没有）', (st.game.pendingLastWords || []).length === 0,
    `待遗言 ${(st.game.pendingLastWords || []).length} 人 · 死因：${night2Deaths.map((d) => d.reason).join('、')} · dayStep=${st.game.dayStep}`);

  /* ================= 8. 屠边胜负 ================= */
  section('屠边胜负判定');
  for (const s of (await state()).seats.filter((x) => ['seer', 'witch', 'guard', 'idiot', 'hunter'].includes(x.role) && x.alive)) {
    await api('PUT', `/api/seats/${s.id}`, { alive: false });
  }
  const ended = await host('end');
  check('神职全部出局 → 狼人屠边获胜', ended.winner === 'wolf', ended.text);

  /* ================= 9. 发言秩序 ================= */
  section('发言秩序（不会抢麦 / 漏麦）');
  await api('POST', '/api/game/new', {
    rolePlan: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'],
    agentIds: agents.map((a) => a.id),
  });
  await api('PUT', '/api/settings', { sheriffEnabled: false });
  await host('night');
  await host('dawn');
  st = await state();
  check('关掉警长后不再有上警环节', st.game.dayStep !== 'campaign' && st.game.dayStep !== 'sheriffVote', `dayStep=${st.game.dayStep}`);
  check('队列能区分「已发言 / 当前 / 等待 / 已出局」', st.queue.list.every((x) => ['spoken', 'current', 'waiting', 'dead'].includes(x.state)));
  check('当前发言人只有一个', st.queue.list.filter((x) => x.state === 'current').length === 1);

  const spokenBefore = st.queue.list.filter((x) => x.state === 'spoken').length;
  const race = await Promise.allSettled([host('nextSpeaker'), host('nextSpeaker')]);
  check('同时点两次「下一位发言」只有一个人能说话', race.filter((r) => r.status === 'fulfilled').length === 1);
  st = await state();
  check('被拒绝的那次没有让人多说话/被跳过', st.queue.list.filter((x) => x.state === 'spoken').length - spokenBefore === 1);
  const inflight = host('dayAll');
  // 等到确实有人在生成，再试"切阶段"
  let sawRunning = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if ((await state()).running) { sawRunning = true; break; }
  }
  check('自动发言确实处于"有人在说"的状态', sawRunning);
  const blocked = await fetch(`${BASE}/api/host/voteStart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('有人发言时不能切阶段（开始投票被挡住）', blocked.status === 409, `HTTP ${blocked.status}`);
  await inflight;
  await api('PUT', '/api/settings', { sheriffEnabled: true });

  /* ================= 10. 换模型 / 白狼王 / 观众视角 ================= */
  section('频道持久性 / 白狼王自爆 / 观众视角');
  st = await state();
  const before = {
    ids: st.channels.map((c) => c.id).join(','),
    counts: st.channels.map((c) => `${c.id}:${c.messages.length}`).join(','),
    firstMsg: lobbyMsgs(st)[0].id,
  };
  const targetSeat = st.seats.find((s) => s.agentId === agents[0].id);
  await api('POST', `/api/seats/${targetSeat.id}/agent`, { agentId: agents[5].id });
  const after = await state();
  check('换模型后频道数量与 id 不变', after.channels.map((c) => c.id).join(',') === before.ids);
  check('换模型后每个频道历史条数不变', after.channels.map((c) => `${c.id}:${c.messages.length}`).join(',') === before.counts);
  check('换模型后老消息还在', lobbyMsgs(after)[0].id === before.firstMsg);

  await api('POST', '/api/game/new', {
    rolePlan: ['whitewolfking', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'],
    agentIds: agents.map((a) => a.id),
  });
  st = await state();
  for (const [num, role] of Object.entries({ 1: 'whitewolfking', 2: 'wolf', 3: 'wolf', 4: 'wolf', 5: 'seer', 6: 'witch', 7: 'hunter', 8: 'guard', 9: 'villager', 10: 'villager', 11: 'villager', 12: 'villager' })) {
    await api('PUT', `/api/seats/${st.seats.find((s) => s.number === Number(num)).id}`, { role });
  }
  await host('night');
  await host('dawn');
  const explode = await host('explode');
  st = await state();
  check('白狼王自爆成功并直接入夜', explode.ok && !explode.needManual && st.game.phase === 'night', `带走 ${explode.applied?.target?.number}号`);

  const audience = await state('audience');
  check('观众视角只返回公共频道', audience.channels.length === 1 && audience.channels[0].id === 'lobby');
  check('观众视角不返回身份信息', audience.seats.every((s) => s.role === undefined));
  check('观众视角不泄漏可反推身份的字段', audience.channels[0].messages.every((m) => m.meta?.includedChannels === undefined));
  // ★ 思考过程里经常直接写着"我是狼人/我验了谁"，观众视角必须剥掉（主持人视角才给）
  check('观众视角不返回思考过程', audience.channels[0].messages.every((m) => m.reasoning === undefined),
    `带 reasoning 的消息 ${audience.channels[0].messages.filter((m) => m.reasoning !== undefined).length} 条`);
  check('主持人视角可以看到思考过程', (await state()).channels[0].messages.every((m) => 'reasoning' in m));

  await api('POST', '/api/game/new', { rolePlan: ['wolf', 'seer', 'villager', 'villager'], agentIds: agents.map((a) => a.id) });
  const afterNew = await state();
  check('开新一局后频道 id 不变（房子没拆）', afterNew.channels.map((c) => c.id).join(',') === before.ids);
  check('开新一局后座位重新分配', afterNew.seats.length === 4 && afterNew.game.phase === 'setup');

  /* ================= 11. 规则补测：自爆 / 退水 / 放逐平票PK ================= */
  section('规则补测：任意狼人自爆（含竞选期）');
  const PLAN12B = ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'];
  // 用"手动指定"开局，保证 1号=狼(奇)、2号=狼(偶) 等断言前提稳定可复现
  const startMiniGame = async () => {
    await api('POST', '/api/game/new', { assignMode: 'manual', roles: PLAN12B, agentIds: agents.map((a) => a.id) });
    await host('night');
    await host('dawn'); // 平安夜（不跑夜间动作）
    return state();
  };

  await startMiniGame();
  st = await state();
  const evenWolf = st.seats.find((s) => s.role === 'wolf' && s.number % 2 === 0);
  const oddWolf = st.seats.find((s) => s.role === 'wolf' && s.number % 2 === 1);
  check('自爆前处于警长竞选阶段', st.game.dayStep === 'campaign', `dayStep=${st.game.dayStep}`);

  const asked = await host('wolfExplode', { number: oddWolf.number });
  st = await state();
  check('问它要不要自爆：AI 可以选择不自爆', asked.exploded === false && st.seats.find((s) => s.number === oddWolf.number).alive === true, `文本：${(asked.text || '').slice(0, 20)}…`);

  const boom = await host('wolfExplode', { number: evenWolf.number });
  st = await state();
  check('狼人可以自爆（AI 自己决定）', boom.exploded === true, `${evenWolf.number}号 自爆`);
  check('自爆的狼人立即出局', st.seats.find((s) => s.number === evenWolf.number).alive === false, st.seats.find((s) => s.number === evenWolf.number).deathReason);
  check('自爆没有任何遗言', !(st.game.pendingLastWords || []).some((x) => x.seatNumber === evenWolf.number));
  check('自爆后白天立即结束、直接进入黑夜', st.game.phase === 'night', `phase=${st.game.phase}`);
  check('竞选阶段自爆 → 警徽流失（本局没有警长）', boom.campaignLost === true && st.game.campaignDone === true && !st.game.sheriffId);

  section('规则补测：退水（放弃竞选 → 转为警下）');
  await startMiniGame();
  const camp = await host('campaign');
  st = await state();
  const candBefore = camp.candidates.length;
  check('上警产生了候选人', candBefore >= 2, `${candBefore} 位候选人：${camp.candidates.join('、')}`);
  const withdrawTarget = (await state()).game.candidates[0];
  const wd = await host('withdraw', { number: withdrawTarget.number });
  st = await state();
  check('候选人可以退水', wd.ok === true && st.game.candidates.length === candBefore - 1, `剩余候选人 ${wd.remaining.join('、')}号`);
  const withdrawnSeat = st.seats.find((s) => s.number === withdrawTarget.number);
  check('退水者不再算候选人，但仍是存活玩家（可以投票）', withdrawnSeat.alive === true && !st.game.candidates.some((c) => c.number === withdrawTarget.number));

  section('规则补测：放逐投票平票 → PK → 重投 → 平安日');
  await api('PUT', '/api/settings', { sheriffEnabled: false, tieRevote: true });
  await startMiniGame();
  st = await state();
  check('12 人平安夜，所有人都存活', st.seats.filter((s) => s.alive).length === 12, `${st.seats.filter((s) => s.alive).length} 人`);
  // 造一个 6:6 的平票
  const aliveAll = st.seats.filter((s) => s.alive);
  const targetA = aliveAll[0];
  const targetB = aliveAll[1];
  await host('voteStart');
  for (let i = 0; i < aliveAll.length; i++) {
    const target = i % 2 === 0 ? targetA.number : targetB.number;
    await host('seatSpeak', { seatId: aliveAll[i].id, channelId: 'lobby', task: `现在是放逐投票。请投票给 ${target}号，格式：投票：${target}号` });
  }
  const tieVote = await host('voteResolve');
  st = await state();
  check('平票时进入 PK 而不是直接结束', tieVote.tie === true && !!tieVote.pk, `平票：${(tieVote.pk?.tied || []).join('、')}号`);
  check('平票后白天步骤停在 PK', st.game.dayStep === 'votePK', `dayStep=${st.game.dayStep}`);
  // ★ 界面的「PK 申辩 + 重投」按钮只画在 phase==='day' 的分支里：
  //   只改 dayStep 不改 phase 的话，主持人看到的还是"计票并放逐"，再点还是平票 → 卡死。
  check('放逐平票后阶段切回白天（界面才会出现 PK 按钮）', st.game.phase === 'day', `phase=${st.game.phase}`);

  const pkRes = await host('votePK');
  st = await state();
  check('PK 结束后产生结果（放逐或平安日）', !!(pkRes.exiled || pkRes.peacefulDay), pkRes.exiled ? `${pkRes.exiled.number}号 被放逐` : '再次平票 → 平安日');
  if (pkRes.peacefulDay) {
    check('再次平票则无人出局（平安日）', st.seats.filter((s) => s.alive).length === 12, `存活 ${st.seats.filter((s) => s.alive).length} 人`);
  }
  await api('PUT', '/api/settings', { sheriffEnabled: true });

  /* ================= 12. 网络代理 ================= */
  section('网络代理（Node 不会自动用系统代理，必须显式配置）');
  // ★ 记下用户原本的代理设置，测完原样恢复（不能把人家配好的代理清掉）
  const originalProxy = (await state()).settings.proxy || '';
  let probeOk = false;
  try {
    probeOk = (await fetch('http://127.0.0.1:8888/__stats')).ok;
  } catch { /* 探针没启动 */ }
  if (!probeOk) {
    check('代理探针未启动 → 跳过代理链路测试', true, '先跑 node test/proxy-probe.mjs 可覆盖这一段');
  } else {
    const stats = async () => (await fetch('http://127.0.0.1:8888/__stats')).json();
    const s0 = await stats();

    const badSocks = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy: 'socks5://127.0.0.1:7891' }),
    });
    check('socks5 代理被明确拒绝并提示改用 HTTP 端口', badSocks.status === 400, `HTTP ${badSocks.status}`);
    const badBare = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy: '127.0.0.1:7890' }),
    });
    check('缺 http:// 前缀的代理地址被拒绝', badBare.status === 400, `HTTP ${badBare.status}`);

    await api('PUT', '/api/settings', { proxy: 'http://127.0.0.1:8888' });
    st = await state();
    check('代理配置已保存并在状态里可见', st.settings.proxy === 'http://127.0.0.1:8888' && st.proxyActive === true, `proxy=${st.proxy}`);

    const viaProxy = await api('POST', '/api/agents/test', { name: '代理测试', baseUrl: MOCK, model: 'werewolf-mock', apiKey: 'sk-test' });
    const s1 = await stats();
    check('模型请求确实走了代理', viaProxy.ok === true && s1.connects > s0.connects, `代理连接数 ${s0.connects} → ${s1.connects}（${s1.seen.at(-1) || ''}）`);

    await api('PUT', '/api/settings', { proxy: '' });
    await api('POST', '/api/agents/test', { name: '直连测试', baseUrl: MOCK, model: 'werewolf-mock', apiKey: 'sk-test' });
    const s2 = await stats();
    check('清空代理后恢复直连（不再经过代理）', s2.connects === s1.connects, `代理连接数停在 ${s2.connects}`);
  }

  // ★ 恢复用户原本的代理设置
  if (originalProxy) {
    const restored = await api('POST', '/api/proxy/apply', { url: originalProxy });
    check('测试结束后恢复原来的代理设置', restored.ok && (await state()).proxy === originalProxy, `已恢复 ${originalProxy}`);
  } else {
    await api('PUT', '/api/settings', { proxy: '' });
    check('原本没配代理 → 测试后也没留代理', (await state()).proxy === '');
  }

  /* ---------- 代理连不上时，状态里要带一句人话（界面顶部横幅用它） ---------- */
  {
    const seatForProxy = (await state()).seats.find((s) => s.alive);
    await api('PUT', '/api/settings', { proxy: 'http://127.0.0.1:7899' }); // 故意指向没人监听的端口
    await host('seatSpeak', { seatId: seatForProxy.id, channelId: 'lobby', task: '测试代理失败时的提示' });
    st = await state();
    check('代理连不上时状态里带出 proxyWarning（界面据此挂顶部横幅）', !!st.proxyWarning && String(st.proxyWarning).includes('7899'),
      String(st.proxyWarning || '(空)'));
    await api('PUT', '/api/settings', { proxy: '' });
    await host('seatSpeak', { seatId: seatForProxy.id, channelId: 'lobby', task: '代理修好后再试一次' });
    st = await state();
    check('代理修好后 proxyWarning 自动消失', !st.proxyWarning, String(st.proxyWarning || '(空)'));
  }

  /* ---------- 代理端口自动检测 ---------- */
  const detected = await api('GET', '/api/proxy/detect');
  check('可以自动检测本机代理端口', detected.ok === true && Array.isArray(detected.candidates), `扫了 ${detected.scanned} 个端口，开着 ${detected.open.length} 个`);
  if (detected.open.length) {
    check('检测到的端口会真的验证能不能用', detected.candidates.some((c) => 'ok' in c && 'google' in c), JSON.stringify(detected.candidates[0]).slice(0, 100));
  } else {
    check('本机没有代理端口在监听（跳过验证）', true);
  }

  /* ================= 14. 成员库不丢：导出 / 导入 / 备份 ================= */
  section('成员库：导出 / 导入 / 历史备份（防丢数据）');
  // ★ 全程只用自己创建的临时成员，绝不碰用户已有的成员
  const tmpAgent = await api('POST', '/api/agents', {
    name: '__e2e_临时成员', avatar: '🧪', preset: 'custom', baseUrl: MOCK,
    model: 'werewolf-mock', apiKey: 'sk-e2e-tmp-key-9876', temperature: 0.5, maxTokens: 128, enabled: true,
  });
  const othersCount = (await state()).agents.length - 1;
  check('创建临时成员用于测试（不影响已有成员）', !!tmpAgent.id && othersCount >= 0, `已有成员 ${othersCount} 个，临时成员 1 个`);

  const exp = await api('GET', '/api/agents/export');
  check('可以导出成员库（含 Key）', exp.ok && exp.json.includes(tmpAgent.id), `导出 ${exp.count} 个`);
  check('导出内容里带着 API Key', exp.json.includes('sk-e2e-tmp-key-9876'));

  await api('DELETE', `/api/agents/${tmpAgent.id}`);
  check('删除临时成员后它确实没了', !(await state()).agents.some((a) => a.id === tmpAgent.id));
  const imp = await api('POST', '/api/agents/import', { json: exp.json });
  const backTmp = (await state()).agents.find((a) => a.name === tmpAgent.name && a.baseUrl === MOCK);
  check('用导出的 JSON 可以原样导入回来', imp.ok && !!backTmp, `新增 ${imp.added} / 更新 ${imp.updated}`);
  check('导入回来的成员保留了 API Key', backTmp?.hasKey === true, backTmp?.apiKeyMask || '(无)');
  const reimport = await api('POST', '/api/agents/import', { json: exp.json });
  check('重复导入不会产生重复成员（同名同地址覆盖）', reimport.added === 0, `新增 ${reimport.added} / 更新 ${reimport.updated}`);

  const backups = await api('GET', '/api/backups');
  check('程序自动留下了备份（上一版 + 每日）', backups.backups.length >= 1, backups.backups.map((b) => `${b.label}(${b.agents}人)`).join('、') || '无');
  const withAgents = backups.backups.find((b) => b.agents > 0);
  if (withAgents) {
    await api('DELETE', `/api/agents/${backTmp.id}`);
    const res = await api('POST', '/api/backups/restore', { name: withAgents.name });
    const afterRestore = (await state()).agents;
    check('可以从历史备份恢复成员库', res.ok && res.total >= 1, `新增 ${res.added} / 更新 ${res.updated} / 共 ${res.total}`);
    check('恢复后原有成员数量没变少', afterRestore.length >= othersCount, `${afterRestore.length} 个`);
  } else {
    check('备份里还没有成员（首次运行正常）', true);
    check('（跳过恢复测试）', true);
  }
  // 收尾：把临时成员删干净
  const leftovers = (await state()).agents.filter((a) => a.name.startsWith('__e2e'));
  for (const a of leftovers) await api('DELETE', `/api/agents/${a.id}`).catch(() => {});
  check('临时成员已清理干净（用户成员数不变）', (await state()).agents.length === othersCount, `现在 ${(await state()).agents.length} 个`);

  /* ================= 16. 手动登记模型名（接口列表滞后时的兜底） ================= */
  section('模型名手动登记（服务商 /models 滞后时用）');
  const fakeBase = 'https://api.example-fake.com/v1';
  let known = await api('POST', '/api/models/known', { baseUrl: fakeBase, model: 'some-new-model-v9' });
  check('可以手动登记一个接口没返回的模型名', known.ok && known.models.includes('some-new-model-v9'), known.models.join('、'));
  known = await api('POST', '/api/models/known', { baseUrl: fakeBase, model: 'another-new-model' });
  check('可以登记多个', known.models.length === 2, known.models.join('、'));
  st = await state();
  check('登记结果写进了设置（重启也在）', (st.settings.knownModels || {})[fakeBase]?.length === 2);
  known = await api('POST', '/api/models/known', { baseUrl: fakeBase, model: 'another-new-model', remove: true });
  check('可以移除某个登记', known.models.length === 1 && !known.models.includes('another-new-model'));
  await api('POST', '/api/models/known', { baseUrl: fakeBase, model: 'some-new-model-v9', remove: true });
  known = await api('POST', '/api/models/known', { baseUrl: fakeBase, model: 'some-new-model-v9' });
  await api('POST', '/api/models/known', { baseUrl: fakeBase, model: 'some-new-model-v9', remove: true });
  st = await state();
  check('移除干净后不残留空数组', !(st.settings.knownModels || {})[fakeBase], JSON.stringify(st.settings.knownModels?.[fakeBase]));

  /* ================= 17. 身份分配：默认随机 / 可选手动 ================= */
  section('身份分配：默认随机 · 可选手动');
  const PLAN12 = ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'];
  const sameSet = (a, b) => a.slice().sort().join(',') === b.slice().sort().join(',');

  // 默认（不传 assignMode）
  await api('POST', '/api/game/new', { rolePlan: PLAN12, agentIds: agents.map((a) => a.id) });
  st = await state();
  check('不指定分配方式时默认是随机分配', st.game.assignMode === 'random', `assignMode=${st.game.assignMode}`);
  check('随机分配后身份构成与所选板子一致（只是顺序被打乱）', sameSet(st.seats.map((s) => s.role), PLAN12),
    st.seats.map((s) => `${s.number}:${s.roleName}`).join(' '));

  // 手动：roles 按座位顺序原样落座
  const MANUAL = ['wolf', 'seer', 'villager', 'witch', 'wolf', 'hunter', 'villager', 'wolf', 'idiot', 'villager', 'wolf', 'villager'];
  const NAMES = Array.from({ length: 12 }, (_, i) => `手动${i + 1}号`);
  await api('POST', '/api/game/new', { assignMode: 'manual', roles: MANUAL, names: NAMES, agentIds: agents.map((a) => a.id) });
  st = await state();
  check('手动分配：身份严格按座位顺序落座（不洗牌）', st.seats.every((s) => s.role === MANUAL[s.number - 1]),
    st.seats.map((s) => `${s.number}:${s.roleName}`).join(' '));
  check('手动分配时会记录分配方式', st.game.assignMode === 'manual');
  check('手动分配可以同时给座位起名', st.seats[0].name === '手动1号' && st.seats[11].name === '手动12号', st.seats[0].name);

  // 非法手动分配必须被拒绝
  const badManual = await fetch(`${BASE}/api/game/new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignMode: 'manual', roles: ['wolf', 'wolf', 'wolf', 'wolf', 'wolf', 'wolf', 'villager', 'villager', 'villager', 'villager', 'villager', 'villager'] }),
  });
  check('手动分配狼人过半会被拒绝', badManual.status === 400, `HTTP ${badManual.status}`);
  const badManual2 = await fetch(`${BASE}/api/game/new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignMode: 'manual', roles: ['seer', 'witch', 'hunter', 'villager'] }),
  });
  check('手动分配没有狼人会被拒绝', badManual2.status === 400, `HTTP ${badManual2.status}`);

  // 事后仍可单独改某个座位的身份
  const beforeRole = (await state()).seats[0].role;
  await api('PUT', `/api/seats/seat_1`, { role: beforeRole === 'wolf' ? 'villager' : 'wolf' });
  st = await state();
  check('开完局之后仍可单独修改某个座位的身份', st.seats[0].role !== beforeRole, `${beforeRole} → ${st.seats[0].role}`);

  /* ================= 18. 智力总控（普通 / 聪明 / 智能） ================= */
  section('智力总控：档位真的影响送进模型的参数');
  {
    const calm = await api('GET', '/api/state');
    check('状态里带出三档与当前档位', Array.isArray(calm.aiLevels) && calm.aiLevels.length === 3, `当前=${calm.aiLevel}`);

    const seatCalc = (await state()).seats.find((s) => s.alive && s.agentId);
    const promptParams = async () => (await api('POST', '/api/debug/prompt', { seatId: seatCalc.id, channelId: 'lobby' })).params;

    await api('PUT', '/api/settings', { aiLevel: 'plain' });
    const plain = await promptParams();
    await api('PUT', '/api/settings', { aiLevel: 'genius' });
    const genius = await promptParams();
    check('切到「智能」后上下文条数与输出预算都变大',
      genius.contextLimit > plain.contextLimit && genius.maxTokens > plain.maxTokens,
      `普通 ${plain.contextLimit}条/${plain.maxTokens}t → 智能 ${genius.contextLimit}条/${genius.maxTokens}t`);

    // 真实调用时用的就是档位里的数字（记录在 orchestrator 的 params 里）
    await api('PUT', '/api/settings', { aiLevel: 'genius' });
    await host('seatSpeak', { seatId: seatCalc.id, channelId: 'lobby', task: '智力总控测试' });
    const rec = (await api('GET', `/api/debug/prompts?seatId=${seatCalc.id}`)).prompts.at(-1);
    check('真实调用用的就是「智能」档的参数', rec?.params?.maxTokens === genius.maxTokens && rec?.params?.level === 'genius',
      `实际 maxTokens=${rec?.params?.maxTokens} level=${rec?.params?.level}`);

    // 成员取消「跟随总控」后，用自己的值
    const ownAgent = await api('POST', '/api/agents', {
      name: '__e2e_自有参数', preset: 'custom', baseUrl: MOCK, model: 'werewolf-mock',
      apiKey: 'sk-e2e-own', temperature: 0.3, maxTokens: 512, followLevel: false, enabled: true,
    });
    await api('POST', `/api/seats/${seatCalc.id}/agent`, { agentId: ownAgent.id });
    await host('seatSpeak', { seatId: seatCalc.id, channelId: 'lobby', task: '自有参数测试' });
    const rec2 = (await api('GET', `/api/debug/prompts?seatId=${seatCalc.id}`)).prompts.at(-1);
    check('取消「跟随总控」的成员用自己的 tokens / 温度',
      rec2?.params?.maxTokens === 512 && rec2?.params?.temperature === 0.3,
      `maxTokens=${rec2?.params?.maxTokens} temperature=${rec2?.params?.temperature}`);
    await api('DELETE', `/api/agents/${ownAgent.id}`);

    // 上下文条数真的生效：塞 80 条带标记的消息，普通档带得少、智能档带得多
    await api('POST', '/api/game/new', { assignMode: 'manual', roles: PLAN12B, agentIds: agents.map((a) => a.id) });
    for (let i = 0; i < 80; i++) await host('say', { channelId: 'lobby', content: `BULK_${i} 这是一条用于测试上下文条数的消息` });
    const countBulk = async (level) => {
      await api('PUT', '/api/settings', { aiLevel: level });
      const r = await api('POST', '/api/debug/prompt', { seatId: seatCalc.id, channelId: 'lobby' });
      const text = (r.messages || []).map((m) => m.content).join('\n');
      return (text.match(/BULK_/g) || []).length;
    };
    const nPlain = await countBulk('plain');
    const nGenius = await countBulk('genius');
    check('上下文条数真的生效（普通档少带、智能档多带）', nPlain < nGenius && nPlain <= 60,
      `普通带 ${nPlain} 条，智能带 ${nGenius} 条（共 80 条）`);

    await api('PUT', '/api/settings', { aiLevel: 'smart' });
    // 收尾：把座位恢复成测试用的模型，免得影响后面的断言
    await api('POST', `/api/seats/${seatCalc.id}/agent`, { agentId: agents[0].id });
  }

  /* ================= 19. 私信（不影响游戏） ================= */
  section('私信：只在主持人和这个 AI 之间，不影响游戏');
  {
    const seatDm = (await state()).seats.find((s) => s.alive && s.agentId);
    const secret = 'DM_SECRET_9f2c 你刚才为什么这么打？';
    const before = (await state()).channels.map((c) => (c.messages || []).length).join(',');

    const r1 = await api('POST', '/api/dm', { seatId: seatDm.id, question: secret });
    check('私信能拿到回答', !!String(r1.answer?.content || '').trim(), String(r1.answer?.content || '').slice(0, 30));

    const after = (await state()).channels.map((c) => (c.messages || []).length).join(',');
    check('私信不写进任何频道（5 个频道消息数不变）', before === after, `${before} → ${after}`);

    const hist = await api('GET', `/api/dm?seatId=${seatDm.id}`);
    check('私信有独立的历史记录（问题 + 回答）', hist.messages?.length >= 2 && hist.messages[0].role === 'host', `${hist.messages?.length} 条`);
    check('私信历史里留有暗号（证明存下来了）', JSON.stringify(hist.messages).includes('DM_SECRET_9f2c'));

    // 让它正常发一次言：这次的 prompt 里不能出现私信内容
    await host('seatSpeak', { seatId: seatDm.id, channelId: 'lobby', task: '正常发言测试' });
    const rec = (await api('GET', `/api/debug/prompts?seatId=${seatDm.id}`)).prompts.at(-1);
    const promptText = (rec?.messages || []).map((m) => m.content).join('\n');
    check('私信内容不会进入它之后的发言 prompt（不影响布局和逻辑）', !promptText.includes('DM_SECRET_9f2c'));
    check('私信也不会出现在任何频道里', !JSON.stringify((await state()).channels).includes('DM_SECRET_9f2c'));

    await api('POST', '/api/game/new', { assignMode: 'manual', roles: PLAN12B, agentIds: agents.map((a) => a.id) });
    const afterNew = await api('GET', `/api/dm?seatId=${seatDm.id}`);
    check('开新一局会清空私信（每局独立，不带上一局记忆）', (afterNew.messages || []).length === 0, `剩 ${afterNew.messages?.length} 条`);
  }

  /* ================= 20. 空回复自动重试 ================= */
  section('空回复自动重试（推理模型把预算全用在思考上、正文为空）');
  {
    const magic = `EMPTY_ONCE_e2e_${Date.now()}`;
    const seat = (await state()).seats.find((s) => s.alive);
    await host('seatSpeak', { seatId: seat.id, channelId: 'lobby', task: `请说一句测试发言。测试标记：${magic}` });
    const mine = lobbyMsgs(await state()).filter((m) => m.meta?.reason === 'manual' && m.seatId === seat.id);
    const last = mine[mine.length - 1];
    check('第一次正文为空时自动重试，最终拿到正文', !!last && String(last.content).length > 0, String(last?.content || '').slice(0, 40));
    check('重试被记录下来（meta.attempts / emptyRetried）', last?.meta?.attempts === 2 && last?.meta?.emptyRetried === true,
      `attempts=${last?.meta?.attempts} emptyRetried=${last?.meta?.emptyRetried}`);
    check('思考过程被保留（reasoning 有内容，界面可折叠查看）', String(last?.reasoning || '').includes('第一次只输出思考'));
    check('重试用的是同一条消息，不会多留一条空发言', mine.filter((m) => !String(m.content || '').trim()).length === 0,
      `这次发言共 ${mine.length} 条`);
  }

  /* ================= 21. 狼刀只看本夜 ================= */
  section('狼刀只统计本夜（前几夜的旧投票不能串味）');
  {
    await api('PUT', '/api/settings', { allowWolfNoKill: false });
    const PLAN = ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'];
    await api('POST', '/api/game/new', { assignMode: 'manual', roles: PLAN, agentIds: agents.map((a) => a.id) });
    await host('night');
    await host('wolves');
    st = await state();
    const kill1 = st.game.pendingKill;
    check('狼人行动后写下 wolfFrom 游标（结算只看本夜发言）',
      typeof st.game.markers?.wolfFrom === 'number' && st.game.markers.wolfFrom > 0, `wolfFrom=${st.game.markers?.wolfFrom}`);
    check('第 1 夜刀口是存活玩家', st.seats.find((s) => s.number === kill1)?.alive === true, `刀 ${kill1} 号`);

    await host('dawn'); // 结算第 1 夜，第 1 夜的目标出局
    st = await state();
    check('第 1 夜刀口生效（该玩家出局）', st.seats.find((s) => s.number === kill1)?.alive === false);

    await host('night');
    await host('wolves');
    st = await state();
    // 假模型的刀口 = 存活好人里座位号最小的那位（每次都是按当前局势重新挑的）
    const expected = st.seats.filter((s) => s.alive && !WOLF_ROLES.includes(s.role)).map((s) => s.number).sort((a, b) => a - b)[0];
    check('第 2 夜刀口 = 本夜狼人的多数决', st.game.pendingKill === expected,
      `第 1 夜刀 ${kill1} 号；第 2 夜 expected=${expected}，实际=${st.game.pendingKill}`);
    check('不会因为旧刀口已出局就把刀口改到随机的人身上', st.game.pendingKill === expected && st.game.wolfKillFallback !== true,
      `fallback=${st.game.wolfKillFallback}`);
  }

  for (const a of agents) await api('DELETE', `/api/agents/${a.id}`).catch(() => {});
  const clean = await state();
  check('删除 AI 后座位保留（只解绑）', clean.seats.every((s) => s.agentId === null) && clean.channels.length === 5);

  console.log(`\n${failures === 0 ? '🎉 全部通过' : `⚠️  ${failures} 项未通过`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(2);
});
