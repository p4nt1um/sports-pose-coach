/**
 * test-guide.mjs —— 「语音指导」文案与播报调度的回归（不需要浏览器）
 *
 * 为什么值得单独测：
 *   语音是最容易**假绿**的一块 —— 它没有视觉输出，跑一遍什么都看不出来。
 *   而它恰好有三类静默故障：
 *     ① 该出声时不出声（开关判断写反、触发条件用 count 导致被拒绝的动作全漏掉）
 *     ② 不该出声时一直出声（去重/冷却失效，学生连续做错就被念到崩溃）
 *     ③ 两个功能互相掐（各自 cancel，两句话都只剩半截）
 *   这三类都只能在纯逻辑层精确断言，所以文案与调度被单独拆成 tpc-guide.js。
 *
 * 用法： node sports-pose-coach/tools/test-guide.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  speakTextOf, pickGuardFlag, guideTextOf, guideForHold, GuideSpeaker, REJECT_SPEAK,
} from '../shared/tpc-guide.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(HERE, '..', 'data', 'exercises.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   — ' + detail : ''));
}

const CFG_ALL = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const EX = CFG_ALL.exercises;

/* ============================ 1. 文案翻译 ============================ */

console.log('\n[1] 给眼睛看的 label → 给耳朵听的短句');
{
  check('去掉中文括号里的补充说明',
    speakTextOf('手臂未举过头顶（开合跳要求双手上举）') === '手臂未举过头顶',
    speakTextOf('手臂未举过头顶（开合跳要求双手上举）'));
  check('去掉半角括号', speakTextOf('下降幅度不足(未做全程)') === '下降幅度不足',
    speakTextOf('下降幅度不足(未做全程)'));
  check('没有括号时原样返回', speakTextOf('上身前倾过大') === '上身前倾过大',
    speakTextOf('上身前倾过大'));
  check('整句都是括号说明时保留原文（避免念出空字符串）',
    speakTextOf('（是否坐着完成的？）') === '（是否坐着完成的？）',
    speakTextOf('（是否坐着完成的？）'));
  check('空值安全', speakTextOf(null) === '' && speakTextOf(undefined) === '');
}

console.log('\n[1b] 全部真实 guard 的 label 都能翻成可朗读的短句');
{
  const bad = [];
  for (const ex of Object.values(EX)) {
    for (const g of ((ex.fsm && ex.fsm.guards) || [])) {
      const t = speakTextOf(g.label);
      if (!t || t.length > 16) bad.push(ex.id + '：' + g.label + ' → ' + t);
    }
  }
  check('每条 guard 去掉括号后都非空且 ≤16 字（TTS 约 4 秒内念完）',
    bad.length === 0, bad.length ? bad.join(' | ') : '共 ' + Object.values(EX)
      .reduce((n, ex) => n + ((ex.fsm && ex.fsm.guards) || []).length, 0) + ' 条');
}

/* ============================ 2. 挑主要原因 ============================ */

console.log('\n[2] 一次动作踩了好几条，只报最主要的一条');
{
  const flags = [
    { label: '蹲得过深（膝角过小）', signal: 'kneeAngle', severity: 'info', samples: 30 },
    { label: '下蹲时躯干前倾过大', signal: 'torsoLean', severity: 'warn', samples: 3 },
  ];
  const f = pickGuardFlag(flags);
  check('warn 优先于 info（哪怕 info 持续更久）', f && f.signal === 'torsoLean',
    f ? f.label + '（samples=' + f.samples + '）' : 'null');

  const same = [
    { label: 'A 原因', signal: 'a', severity: 'warn', samples: 2 },
    { label: 'B 原因', signal: 'b', severity: 'warn', samples: 9 },
  ];
  check('同级时取持续更久的（samples 大）', pickGuardFlag(same).signal === 'b');
  check('severity 缺省按 warn 处理（不会因为没写就被排到最后）',
    pickGuardFlag([{ label: 'X', signal: 'x' }, { label: 'Y', signal: 'y', severity: 'info' }]).signal === 'x');
  check('speak:false 的条目被跳过（老师可逐条静音）',
    pickGuardFlag([{ label: '静音项', signal: 'q', speak: false }, { label: '要说的', signal: 'w', severity: 'info' }]).signal === 'w');
  check('全部都被静音 / 没有标记 → null', pickGuardFlag([]) === null && pickGuardFlag(null) === null);
}

console.log('\n[2b] speak 字段可覆盖说法（JSON 驱动，老师不用碰代码）');
{
  const f = pickGuardFlag([{ label: '很长很长的一段解释（括号补充）', signal: 'z', speak: '手抬高' }]);
  const g = guideTextOf({ reject: null, flags: [f] });
  check('写了 speak 就用 speak', g && g.text === '手抬高', g && g.text);
}

/* ============================ 3. 计数类：该不该出声 ============================ */

console.log('\n[3] 计数类：什么算「不合格」');
{
  const gFast = guideTextOf({ reject: 'too_fast', flags: [] });
  check('被拒（太快）→ 报原因，文案不含数字',
    !!gFast && gFast.text === REJECT_SPEAK.too_fast && !/\d/.test(gFast.text), gFast && gFast.text);
  check('被拒（停太久）', (guideTextOf({ reject: 'too_slow' }) || {}).text === REJECT_SPEAK.too_slow);
  check('被拒（半程）', (guideTextOf({ reject: 'partial' }) || {}).text === REJECT_SPEAK.partial);
  check('被拒优先于规范标记（都没算呢，先说为什么没算）',
    (guideTextOf({ reject: 'too_fast', flags: [{ label: '前倾过大', signal: 't' }] }) || {}).kind === 'reject');

  const gFlag = guideTextOf({ reject: null, flags: [{ label: '下蹲时躯干前倾过大', signal: 'torsoLean', value: 61, samples: 5 }] });
  check('计数通过但有规范标记 → 报标记（这就是「算了但不标准」）',
    !!gFlag && gFlag.kind === 'flag' && gFlag.text === '下蹲时躯干前倾过大', gFlag && gFlag.text);

  check('完全合格 → 不出声（null）',
    guideTextOf({ reject: null, flags: [], accepted: true }) === null);
  check('没有记录 → 不出声', guideTextOf(null) === null);
}

console.log('\n[3b] 用真实配置跑一遍：深蹲前倾 + 开合跳手臂');
{
  const squat = EX.squat;
  const flag = { ...squat.fsm.guards[0], value: 60, samples: 4 };
  const g = guideTextOf({ reject: null, flags: [flag] });
  check('深蹲 warn 标记能念出来', g && g.text === '下蹲时躯干前倾过大', g && g.text);

  const jj = EX.jumping_jack;
  const jf = { ...jj.fsm.guards[0], value: -0.2, samples: 6 };
  const gj = guideTextOf({ reject: null, flags: [jf] });
  check('开合跳的 info 标记也念（打标记就是被判定有不合格之处），且已去括号',
    gj && gj.text === '手臂未举过头顶', gj && gj.text);
}

/* ============================ 4. 计时类 ============================ */

console.log('\n[4] 计时类：只报「确实能分辨」的不合格');
{
  const checks = [
    { signal: 'kneeAngle', label: '膝角在 78°–132°（大腿接近水平）', ok: false },
    { signal: 'torsoLean', label: '躯干保持直立', ok: true },
  ];
  const gShort = guideForHold({ valid: false, reason: 'break', breaks: 1, ms: 700 }, checks);
  check('段太短（没进总时长）→ 报「时间太短」',
    !!gShort && gShort.text === '时间太短，不算' && gShort.kind === 'hold_short', gShort && gShort.text);

  const gNormal = guideForHold({ valid: true, reason: 'break', breaks: 1, ms: 12000 }, checks);
  check('正常结束（只断 1 次）→ 不出声，把判断留给老师',
    gNormal === null);

  const gBroken = guideForHold({ valid: true, reason: 'break', breaks: 3, ms: 9000 }, checks);
  check('中途散过（断 ≥2 次）→ 报是哪条没成立',
    !!gBroken && gBroken.kind === 'hold_break' &&
    gBroken.text === '没保持住，膝角在 78°–132°', gBroken && gBroken.text);

  const gFin = guideForHold({ valid: true, reason: 'finalize', breaks: 5, ms: 9000 }, checks);
  check('手动停止/清零触发的结账不是不合格 → 不出声', gFin === null);
}

/* ============================ 5. 播报调度 ============================ */

console.log('\n[5] 播报调度：抢话 / 念白过长 / 碎碎念');
{
  /** 假发声：记录下来，由测试手动决定什么时候"播完" */
  const made = [];
  let finish = null;
  const sp = new GuideSpeaker({
    say: (text, done) => { made.push(text); finish = done; },
    cancel: () => { made.push('<CANCEL>'); },
    cooldownMs: 5000,
  });

  check('第一次播：立刻出声', sp.speak('太快了，不算', { priority: 2, atMs: 1000 }) === true &&
    sp.speaking === '太快了，不算', 'speaking=' + sp.speaking);

  check('同一句在冷却期内 → 不再出声，并记账',
    sp.speak('太快了，不算', { priority: 2, atMs: 2000 }) === false && sp.blocked === 1,
    'blocked=' + sp.blocked);

  check('冷却期内换一句不同原因 → 照常出声（各句各有额度，不互相遮挡）',
    sp.speak('停太久了，不算', { priority: 2, atMs: 2200 }) === true && sp.pending &&
    sp.pending.text === '停太久了，不算', 'pending=' + (sp.pending && sp.pending.text));

  check('待播槽只有一条：又来第三句就替换掉第二句（纠正只讲"此刻"）',
    sp.speak('只做了一半', { priority: 2, atMs: 2300 }) === true && sp.pending.text === '只做了一半',
    'pending=' + sp.pending.text);

  check('已排过序的内容不会进 history（history 只记真正播过的）',
    sp.history.length === 1 && sp.history[0].text === '太快了，不算', 'history=' + sp.history.length);

  // 手动结账：模拟"这句话播完了"
  finish();
  check('播完 → 待播的那句自动接上',
    sp.history.length === 2 && sp.history[1].text === '只做了一半',
    sp.history.map((h) => h.text).join(' → '));
}

console.log('\n[5b] 撞车：指导抢占计数播报');
{
  const made = [];
  const sp = new GuideSpeaker({
    say: (text) => made.push({ text, done: () => {} }),
    cancel: () => made.push({ text: '<CANCEL>' }),
    cooldownMs: 5000,
  });
  sp.speak('5', { priority: 1, atMs: 1000, kind: 'count' });          // 正在报数字
  const ok = sp.speak('不合格：下蹲时躯干前倾过大', { priority: 2, atMs: 1000, kind: 'flag' });
  check('指导会打断计数播报（否则学生先听到数字、原因已经过期）',
    ok === true && made.some((m) => m.text === '<CANCEL>'), JSON.stringify(made.map((m) => m.text)));
  check('打断后队列没有卡死：指导立刻在播',
    sp.speaking === '不合格：下蹲时躯干前倾过大', 'speaking=' + sp.speaking);

  const made2 = [];
  const sp2 = new GuideSpeaker({
    say: (text) => made2.push(text),
    cancel: () => made2.push('<CANCEL>'),
    cooldownMs: 5000,
  });
  sp2.speak('快', { priority: 2, atMs: 1 });
  sp2.speak('慢', { priority: 2, atMs: 2 });
  check('同级不互相打断（两条纠正掐来掐去，最后哪条都听不清）',
    !made2.includes('<CANCEL>'), JSON.stringify(made2));
  check('同级进待播槽，排队等着', sp2.pending && sp2.pending.text === '慢');
}

console.log('\n[5c] reset：换动作 / 清零时不留上一组的话');
{
  const made = [];
  const sp = new GuideSpeaker({
    say: (text) => made.push(text),
    cancel: () => made.push('<CANCEL>'),
    cooldownMs: 5000,
  });
  sp.speak('太快了，不算', { priority: 2, atMs: 1000 });
  sp.speak('停太久了，不算', { priority: 2, atMs: 1100 });
  sp.reset();
  check('reset 后队列与去重状态清空',
    sp.speaking === null && sp.pending === null && sp.history.length === 0 && sp.blocked === 0);
  check('reset 后同一句可以立刻重新播（换了个动作，上次的冷却不该继承）',
    sp.speak('太快了，不算', { priority: 2, atMs: 1600 }) === true && sp.speaking === '太快了，不算');
}

console.log('\n[5d] 计时类没有 reject，也不该走检查');
{
  const made = [];
  const sp = new GuideSpeaker({ say: (t) => made.push(t), cancel: () => {}, cooldownMs: 5000 });
  check('空文本不入队', sp.speak('', { priority: 2, atMs: 1 }) === false &&
    sp.speak(null, { priority: 2, atMs: 1 }) === false && made.length === 0);
}

/* ============================ 汇总 ============================ */

const bad = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('语音指导回归：' + (results.length - bad.length) + ' / ' + results.length + ' 通过');
if (bad.length) {
  console.log('\n失败项：');
  for (const b of bad) console.log('  · ' + b.name + (b.detail ? '   — ' + b.detail : ''));
  process.exit(1);
}
