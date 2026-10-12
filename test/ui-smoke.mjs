// 界面冒烟测试：真的在浏览器里点一遍主要弹窗，验证事件绑定是通的
// （后端 e2e 覆盖不到 DOM —— 曾经因为一个 ReferenceError 导致"加 AI"表单所有按钮失效，
//   而 API 测试全绿，所以这里专门补上）
//
// 用法：先起 Chrome --remote-debugging-port=9333，再 node test/ui-smoke.mjs [应用地址]
import fs from 'node:fs';

const BASE = process.argv[2] || process.env.APP_URL || 'http://127.0.0.1:8789';
const PORT = Number(process.env.CDP_PORT || 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* Chrome 还没起来 */ }
    await sleep(300);
  }
  throw new Error('找不到可调试的页面，Chrome 起了吗？（--remote-debugging-port=9333）');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    const pageErrors = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        // ★ 把页面里的未捕获异常记下来（事件绑定失败往往就是这样被吞掉的）
        if (msg.method === 'Runtime.exceptionThrown') {
          pageErrors.push(String(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
        }
        for (const l of [...listeners]) l(msg);
      }
    };
    ws.onerror = (err) => reject(err);
    ws.onopen = () => resolve({
      pageErrors,
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      once(method) {
        return new Promise((res) => {
          const l = (msg) => { if (msg.method === method) { listeners.splice(listeners.indexOf(l), 1); res(msg.params); } };
          listeners.push(l);
        });
      },
      close: () => ws.close(),
    });
  });
}

const target = await findTarget();
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
// ★ 必须自己导航过去再等应用启动（否则连到的是上一次留下的页面/错误页）
const loaded = cdp.once('Page.loadEventFired');
await cdp.send('Page.navigate', { url: BASE });
await Promise.race([loaded, sleep(15000)]);
for (let i = 0; i < 40; i++) {
  const r = await cdp.send('Runtime.evaluate', { expression: `!!document.querySelector('#btn-agents')`, returnByValue: true });
  if (r.result?.value) break;
  await sleep(300);
}
await sleep(1200);

const script = String.raw`
(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const results = [];
  const add = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 120) });
  const clickText = (sel, text) => {
    const btn = $$(sel).find((b) => b.textContent.includes(text));
    if (!btn) return false;
    btn.click();
    return true;
  };

  // ---------- 1. 页面基本加载 ----------
  await s(600);
  add('页面加载出频道列表', $$('#channel-list .channel-item, #channel-list > *').length === 5, $$('#channel-list > *').length + ' 个频道');
  add('控制栏渲染出来了', $$('#control-bar .ctrl-btn').length > 0, $$('#control-bar .ctrl-btn').length + ' 个按钮');

  // ---------- 2. AI 成员库 → 添加 AI（曾经整体失效的地方） ----------
  $('#btn-agents').click();
  await s(500);
  add('成员库弹窗打开', !!$('.modal'));
  add('成员库底部有导出/导入/备份', $$('.modal-foot button').map((b) => b.textContent.trim()).join(',').includes('导出成员'), $$('.modal-foot button').map((b) => b.textContent.trim()).join(' / '));

  clickText('.modal-foot button', '添加 AI');
  await s(600);
  const sel = $('#f-preset');
  add('服务商下拉有选项', !!sel && sel.options.length > 20, sel ? sel.options.length + ' 个' : '没有下拉');
  const before = $('#f-baseurl')?.value;
  sel.value = 'moonshot';
  sel.dispatchEvent(new Event('change'));
  await s(400);
  const after = $('#f-baseurl')?.value;
  add('切换服务商会自动改 Base URL', after === 'https://api.moonshot.cn/v1', before + ' → ' + after);
  add('切换服务商会自动改模型名', ($('#f-model')?.value || '').startsWith('kimi'), $('#f-model')?.value);
  add('服务商信息区渲染（常用模型/Key 链接）', !!$('#f-preset-info') && $('#f-preset-info').textContent.length > 5, ($('#f-preset-info')?.textContent || '').slice(0, 40));

  // 模型名输入框 + 获取按钮可用
  add('模型名输入框可直接输入', !!$('#f-model') && !$('#f-model').disabled && !$('#f-model').readOnly);
  add('成员表单有「跟随智力总控」开关（默认勾选）', !!$('#f-follow') && $('#f-follow').checked);
  add('勾选后温度/tokens 被禁用（由总控决定）', $('#f-temp')?.disabled === true && $('#f-maxtokens')?.disabled === true);

  // 弹窗右上角 ✕：用功能验证（el() 内部用的是 addEventListener，不能用 .onclick 判断）
  const headClose = $('.modal-head button');
  headClose.click();
  await s(400);
  add('弹窗右上角 ✕ 能关掉弹窗', !$('.modal'));

  // ---------- 添加一个成员（并验证真的建出来了） ----------
  $('#btn-agents').click();
  await s(500);
  clickText('.modal-foot button', '添加 AI');
  await s(600);
  $('#f-name').value = '__ui_smoke_临时';
  $('#f-apikey').value = 'sk-ui-smoke';
  $('#f-baseurl').value = 'http://127.0.0.1:9/v1';   // 不联网，只是存配置
  $('#f-model').value = 'smoke-model';
  const saveBtn = $$('.modal-foot button').find((b) => b.textContent.trim() === '添加');
  add('「添加」按钮存在', !!saveBtn);
  saveBtn.click();
  await s(1800);
  add('点「添加」后弹窗自动关闭（说明保存流程跑通了）', !$('.modal'));
  $('#btn-agents').click();
  await s(700);
  const rows = $$('#ag-list .agent-row').length;
  add('新成员真的出现在成员库列表里', $$('#ag-list .agent-row').some((r) => r.textContent.includes('__ui_smoke_临时')), '列表现在 ' + rows + ' 行');

  // 清理：走界面把刚才的临时成员删掉（失败也没关系，Node 侧兜底会再删一次）
  const row = $$('#ag-list .agent-row').find((r) => r.textContent.includes('__ui_smoke_临时'));
  if (row) {
    const editBtn = $$('button', row).find((b) => /编辑|改名/.test(b.textContent));
    editBtn?.click();
    await s(700);
    const delBtn = $$('.modal-foot button').find((b) => b.textContent.includes('删除'));
    delBtn?.click();
    await s(600);
    const okBtn = $$('.confirm-root .modal-foot button').find((b) => b.textContent.trim() === '删除');
    add('删除成员时会弹确认框', !!okBtn);
    okBtn?.click();
    await s(1500);
    $('#btn-agents').click();
    await s(600);
    add('走界面删除后成员库里没有它了', !$$('#ag-list .agent-row').some((r) => r.textContent.includes('__ui_smoke_临时')));
  }
  $('.modal-head button')?.click();
  await s(400);
  // ---------- 3. 对局设置 ----------
  $('#btn-settings')?.click();
  await s(500);
  add('设置弹窗有网络代理输入框', !!$('#set-proxy'), $('#set-proxy')?.placeholder);
  add('设置弹窗有遗言规则', !!$('#lw-firstNight') && !!$('#set-sheriff'));
  {
    const lvBtns = $$('#set-level button');
    add('设置弹窗有「AI 智力总控」档位', lvBtns.length === 4, lvBtns.map((b) => b.textContent.trim()).join(' / '));
    const before = $('#set-max')?.value;
    lvBtns.find((b) => b.dataset.level === 'genius')?.click();
    await s(300);
    add('点「智能」会把参数带进下面的输入框', $('#set-max')?.value === '2600' && $('#set-max')?.value !== before, before + ' → ' + $('#set-max')?.value);
    const maxInput = $('#set-max');
    maxInput.value = '900';
    maxInput.dispatchEvent(new Event('input'));
    await s(200);
    add('手改参数会自动切到「自定义」', !!lvBtns.find((b) => b.dataset.level === 'custom')?.classList.contains('on'));
  }
  $('.modal-head button')?.click();
  await s(300);

  // ---------- 4. 开新一局（随机/手动两种模式） ----------
  $('#btn-newgame')?.click();
  await s(600);
  const modeBtns = $$('#ng-mode button');
  add('开新一局有随机/手动两种模式', modeBtns.length === 2, modeBtns.map((b) => b.textContent.trim()).join(' / '));
  add('默认选中随机分配', modeBtns[0]?.classList.contains('on'));
  const manualBtn = modeBtns.find((b) => b.dataset.mode === 'manual');
  manualBtn?.click();
  await s(500);
  add('手动模式渲染出逐座位网格', $$('.manual-item').length === 12, $$('.manual-item').length + ' 行');
  add('手动模式每个座位都有身份下拉', $$('.manual-item select').length === 12);
  modeBtns[0]?.click();
  await s(300);
  add('切回随机模式会隐藏手动网格', $('#ng-manual-wrap')?.hidden === true);
  $('.modal-head button')?.click();
  await s(300);

  // ---------- 5. 思考过程折叠块 ----------
  // 让假模型回一次"只有思考、正文为空"，验证：自动重试拿到正文 + 思考过程能折叠查看。
  // （假模型没起的话这里拿不到 reasoning，直接跳过，不算失败）
  try {
    const st0 = await (await fetch('/api/state')).json();
    const seat0 = (st0.seats || []).find((x) => x.alive);
    if (seat0) {
      await fetch('/api/host/seatSpeak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatId: seat0.id, channelId: 'lobby', task: '请说一句。测试标记：EMPTY_ONCE_ui_' + Date.now() }),
      });
      await s(5000);
    }
  } catch { /* 假模型没起 / 接口不通，跳过 */ }
  const boxes = $$('#messages .reason-box').filter((d) => !d.hidden);
  if (boxes.length) {
    add('消息里渲染出「思考过程」折叠块', true, boxes.length + ' 个');
    add('思考过程默认折叠（不打扰阅读）', boxes.every((d) => !d.open));
    add('折叠块标题带字数', /思考过程（\d+ 字）/.test(boxes[0].querySelector('summary')?.textContent || ''),
      boxes[0].querySelector('summary')?.textContent || '');
    add('折叠块里的思考有内容', (boxes[0].querySelector('.reason-text')?.textContent || '').length > 0);
  } else {
    add('（这一局没有带思考的消息，跳过折叠块检查）', true);
  }
  add('顶部有「代理告警」横幅元素（代理挂掉时会亮起来）', !!$('#warn-banner'));

  // ---------- 6. 私信 / AI 托管 ----------
  add('控制栏有「AI 托管」开关', $$('#control-bar .ctrl-btn').some((b) => b.textContent.includes('托管')));
  {
    // 私信要座位绑了 AI 才能开；没绑就顺手绑一个已有成员（不影响用户的成员库）
    const st = await (await fetch('/api/state')).json();
    let seat = (st.seats || []).find((x) => x.agentId);
    const known = (st.agents || [])[0];
    let tempAgentId = null;
    if (!seat && known) {
      const tmp = await (await fetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '__ui_smoke_dm', preset: 'custom', baseUrl: known.baseUrl, model: known.model, apiKey: 'sk-ui-smoke', enabled: true }),
      })).json();
      tempAgentId = tmp.id;
      await fetch('/api/seats/' + st.seats[0].id + '/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: tmp.id }),
      });
      seat = { id: st.seats[0].id };
    }
    if (seat) {
      // 重新渲染座位面板，让「💬 私信」按钮出现
      await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostName: (st.settings || {}).hostName || '主持人' }) });
      await s(900);
      const dmBtn = $$('#seat-list button').find((b) => b.textContent.includes('私信'));
      add('座位卡片有「💬 私信」按钮', !!dmBtn);
      if (dmBtn) {
        dmBtn.click();
        await s(800);
        add('私信弹窗打开（有输入框和发送按钮）', !!$('#dm-input') && !!$('#dm-send'));
        if ($('#dm-input')) {
          $('#dm-input').value = 'UI_SMOKE_DM 你刚才为什么这么打？';
          $('#dm-send').click();
          await s(5000);
          const texts = $$('.dm-line .dm-text').map((x) => x.textContent);
          add('发送后弹窗里有「我」和 AI 两条私信', $$('.dm-line').length >= 2, $$('.dm-line').length + ' 条');
          add('私信内容显示正常（不是错误提示）', !texts.join('|').includes('发送失败') && texts.some((t) => t.includes('UI_SMOKE_DM')), texts.join(' | ').slice(0, 60));
        }
        $('.modal-head button')?.click();
        await s(300);
      }
    } else {
      add('（成员库里没有可用的 AI，跳过私信检查）', true);
    }
    if (tempAgentId) await fetch('/api/agents/' + tempAgentId, { method: 'DELETE' });
  }

  return results;
})()
`;

const res = await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
if (res.exceptionDetails) {
  console.error('❌ 页面脚本抛异常：', res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails));
  process.exit(1);
}
const results = res.result.value || [];
let fail = 0;
console.log(`\n== 界面冒烟测试（${BASE}）==\n`);
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.ok) fail++;
}
if (cdp.pageErrors.length) {
  console.log('\n页面里捕获到的异常：');
  for (const e of [...new Set(cdp.pageErrors)]) console.log('  ❗ ' + e);
  fail += cdp.pageErrors.length;
}

// ★ 兜底清理：界面上没删干净的临时成员，这里从接口删掉，绝不留垃圾数据
try {
  const st = await (await fetch(`${BASE}/api/state`)).json();
  const leftovers = (st.agents || []).filter((a) => a.name.startsWith('__ui_smoke'));
  for (const a of leftovers) await fetch(`${BASE}/api/agents/${a.id}`, { method: 'DELETE' });
  const after = await (await fetch(`${BASE}/api/state`)).json();
  const still = (after.agents || []).filter((a) => a.name.startsWith('__ui_smoke')).length;
  console.log(`${still === 0 ? '✅' : '❌'} 临时成员已清理干净（本次清了 ${leftovers.length} 个，剩余 ${still} 个）`);
  if (still > 0) fail++;
} catch (err) {
  console.log('❌ 清理临时成员失败：' + err.message);
  fail++;
}
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('screenshots/ui-smoke.png', Buffer.from(shot.data, 'base64'));
console.log(`\n${fail === 0 ? '🎉 界面全部正常' : `⚠️  ${fail} 项界面问题`}（截图 screenshots/ui-smoke.png）\n`);
cdp.close();
process.exit(fail === 0 ? 0 : 1);
