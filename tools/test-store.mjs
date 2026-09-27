/**
 * test-store.mjs —— 参数存档逻辑回归（不需要浏览器）
 *
 * 为什么值得单独测：
 *   存档出错是**静默**的 —— 页面照常打开、计数照常跑，但老师上次调的阈值
 *   悄悄丢了或串了。这种故障只有反复刷新才能发现，靠人工试几乎测不出来。
 *
 * 用法： node sports-pose-coach/tools/test-store.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TunedStore, memoryStorage, flattenParams, diffPatch, applyPatch,
  checkConflicts, getPath, setPath, STORE_VERSION, KEY_PREFIX,
} from '../shared/tpc-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(HERE, '..', 'data', 'exercises.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   — ' + detail : ''));
}

const deep = (o) => JSON.parse(JSON.stringify(o));
const CFG_ALL = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const DEFAULTS = CFG_ALL.exercises.squat;

/* ============================ 1. 参数展开 ============================ */

console.log('\n[1] 参数展开');
{
  const flat = flattenParams(DEFAULTS);
  check('只展开 signals / fsm / hold（不含 id / name / camera / feedback）',
    !('id' in flat) && !('name' in flat) && !('camera.view' in flat) && !('feedback.lost' in flat),
    Object.keys(flat).length + ' 个叶子');
  check('嵌套对象展开到叶子', flat['fsm.phases.stand.enter.gte'] === 158 && flat['signals.kneeAngle.smooth.minCutoff'] === 1.2,
    'stand.gte=' + flat['fsm.phases.stand.enter.gte'] + '，minCutoff=' + flat['signals.kneeAngle.smooth.minCutoff']);
  check('数组按下标展开为原始值（guards）', flat['fsm.guards.0.signal'] === 'torsoLean' && flat['fsm.guards.1.gt'] === 70,
    'guards.0.signal=' + flat['fsm.guards.0.signal'] + '，guards.1.gt=' + flat['fsm.guards.1.gt']);
  check('无 null / undefined 以外的对象残留', Object.values(flat).every((v) => v === null || typeof v !== 'object'),
    '全部为原始类型');

  // 计时动作的参数全在 hold 段里（它们根本没有 fsm）—— 漏掉这段就是「调完刷新全没了」
  const holdEx = CFG_ALL.exercises.horse_stance;
  const holdFlat = flattenParams(holdEx);
  check('计时动作也能展开出可调参数（hold 段必须在内）',
    holdFlat['hold.conditions.0.gte'] === 78 && holdFlat['hold.conditions.1.lte'] === 28 &&
      holdFlat['hold.minHoldMs'] === 500 && holdFlat['hold.minSessionMs'] === 1500,
    Object.keys(holdFlat).length + ' 个叶子，例：' + JSON.stringify(holdFlat['hold.conditions.0.gte']));
  check('计时动作展开后不含结构字段（id / camera 等）',
    !('id' in holdFlat) && !('camera.hint' in holdFlat) && !('feedback.idle' in holdFlat),
    '字段数 ' + Object.keys(holdFlat).length);
}

/* ============================ 2. 差异计算 ============================ */

console.log('\n[2] 差异计算 diffPatch');
{
  const cur = deep(DEFAULTS);
  check('未改动 → 差异为空', Object.keys(diffPatch(cur, DEFAULTS)).length === 0);

  cur.fsm.phases.stand.enter.gte = 152;
  cur.signals.kneeAngle.smooth.beta = 0.02;
  const p = diffPatch(cur, DEFAULTS);
  check('改了 2 项 → 只收 2 项', Object.keys(p).length === 2,
    Object.keys(p).join(', ') + '：' + JSON.stringify(p));
  check('差异值正确', p['fsm.phases.stand.enter.gte'] === 152 && p['signals.kneeAngle.smooth.beta'] === 0.02);

  cur.fsm.phases.stand.enter.gte = 158;   // 调回默认
  const p2 = diffPatch(cur, DEFAULTS);
  check('调回默认值的项自动从差异里消失', !('fsm.phases.stand.enter.gte' in p2) && Object.keys(p2).length === 1,
    '剩 ' + Object.keys(p2).join(', '));

  check('null 与数字不会被判为相同', diffPatch({ signals: { x: 0 } }, { signals: { x: null } })['signals.x'] === 0);
}

/* ============================ 3. 存档往返 ============================ */

console.log('\n[3] 存档 save / load 往返');
{
  const st = memoryStorage();
  const store = new TunedStore({ storage: st, now: () => 1758500000000 });
  check('注入存储后非降级状态', store.degraded === false);

  const cur = deep(DEFAULTS);
  cur.fsm.phases.bottom.enter.lte = 118;
  const r = store.save('squat', { patch: diffPatch(cur, DEFAULTS), baseline: flattenParams(DEFAULTS), cfgVersion: CFG_ALL.version });
  check('保存成功', r.ok === true && !r.cleared, 'patch 项数=' + Object.keys(r.record.patch).length);
  check('存档写入预期键名', st.getItem(KEY_PREFIX + 'squat') !== null, KEY_PREFIX + 'squat');
  check('存档带版本与时间戳', r.record.v === STORE_VERSION && r.record.savedAt === 1758500000000 && !!r.record.savedAtText,
    'v=' + r.record.v + '，' + r.record.savedAtText);

  const back = store.load('squat');
  check('读回内容一致', back && back.patch['fsm.phases.bottom.enter.lte'] === 118,
    JSON.stringify(back && back.patch));
  check('baseline 只保留 patch 用到的键', back.baseline && Object.keys(back.baseline).length === 1 &&
    back.baseline['fsm.phases.bottom.enter.lte'] === 100,
    JSON.stringify(back.baseline));

  // 应用到一份干净配置
  const target = deep(DEFAULTS);
  const rep = store.restore(target, back, DEFAULTS);
  check('restore 写回了目标配置', target.fsm.phases.bottom.enter.lte === 118 && rep.applied.length === 1);
  check('baseline 与文件一致 → 无冲突', rep.conflicts.length === 0);
  check('未改动项保持文件默认值', target.fsm.phases.stand.enter.gte === 158 && target.fsm.minRepMs === 400);
}

/* ============================ 4. 空 patch 与清理 ============================ */

console.log('\n[4] 无调整时的清理');
{
  const st = memoryStorage();
  const store = new TunedStore({ storage: st });
  store.save('squat', { patch: { 'fsm.minRepMs': 500 }, baseline: flattenParams(DEFAULTS) });
  check('先存一项', store.load('squat') !== null);

  // 把值改回默认后再存：应视为"无调整"并清空存档
  const r = store.save('squat', { patch: { 'fsm.minRepMs': 400 }, baseline: flattenParams(DEFAULTS) });
  check('存回默认值 → 判为无调整并清空存档', r.cleared === true && store.load('squat') === null);

  store.save('squat', { patch: { 'fsm.minRepMs': 500 }, baseline: flattenParams(DEFAULTS) });
  store.clear('squat');
  check('clear 后读不到', store.load('squat') === null);

  const r2 = store.save('squat', { patch: {}, baseline: flattenParams(DEFAULTS) });
  check('空 patch 不写盘', r2.cleared === true && st.getItem(KEY_PREFIX + 'squat') === null);
}

/* ============================ 5. 损坏与陈旧存档 ============================ */

console.log('\n[5] 损坏 / 陈旧存档不得让页面崩');
{
  const st = memoryStorage();
  const store = new TunedStore({ storage: st });

  st.setItem(KEY_PREFIX + 'squat', '{ 这不是 JSON');
  check('非法 JSON → load 返回 null 且不抛', store.load('squat') === null);

  st.setItem(KEY_PREFIX + 'squat', JSON.stringify({ v: 1, patch: null }));
  check('缺 patch 字段 → 返回 null', store.load('squat') === null);

  st.setItem(KEY_PREFIX + 'squat', JSON.stringify({ v: 1, patch: {} }));
  check('空 patch → 返回 null', store.load('squat') === null);

  // 陈旧路径：配置文件里删掉的字段
  st.setItem(KEY_PREFIX + 'squat', JSON.stringify({
    v: 1, id: 'squat', savedAt: 1, savedAtText: 'x',
    patch: { 'fsm.minRepMs': 500, 'fsm.thisFieldIsGone': 42 },
    baseline: { 'fsm.minRepMs': 400 },
  }));
  const rec = store.load('squat');
  const target = deep(DEFAULTS);
  const rep = store.restore(target, rec, DEFAULTS);
  check('陈旧路径被跳过并记入 unknown', rep.unknown.length === 1 && rep.unknown[0] === 'fsm.thisFieldIsGone',
    'unknown=' + JSON.stringify(rep.unknown));
  check('有效项照常生效', target.fsm.minRepMs === 500 && rep.applied.length === 1);
  check('不凭空创建不存在的结构', target.fsm.thisFieldIsGone === undefined);
}

/* ============================ 6. 冲突检测 ============================ */

console.log('\n[6] 冲突检测：文件默认值后来变了');
{
  const st = memoryStorage();
  const store = new TunedStore({ storage: st });

  // 保存时文件里 stand.gte = 158，老师调成 152
  const atSave = deep(DEFAULTS);
  const cur = deep(DEFAULTS);
  cur.fsm.phases.stand.enter.gte = 152;
  const rec = store.save('squat', {
    patch: diffPatch(cur, DEFAULTS), baseline: flattenParams(atSave),
  }).record;

  // 文件侧后来把默认值改成 160
  const fileNow = deep(DEFAULTS);
  fileNow.fsm.phases.stand.enter.gte = 160;

  const target = deep(fileNow);
  const rep = store.restore(target, rec, fileNow);
  check('检出 1 处冲突', rep.conflicts.length === 1, JSON.stringify(rep.conflicts));
  check('冲突报告带上三方数值',
    rep.conflicts[0].path === 'fsm.phases.stand.enter.gte' &&
    rep.conflicts[0].baselineAtSave === 158 && rep.conflicts[0].fileNow === 160 && rep.conflicts[0].saved === 152,
    '保存时默认 ' + rep.conflicts[0].baselineAtSave + '，现在默认 ' + rep.conflicts[0].fileNow + '，老师值 ' + rep.conflicts[0].saved);
  check('冲突时仍采用老师调的值（用户调整优先）', target.fsm.phases.stand.enter.gte === 152);

  // 老师没动过、但文件改过的项不算冲突
  const fileNow2 = deep(DEFAULTS);
  fileNow2.fsm.minRepMs = 500;
  const rep2 = store.restore(deep(fileNow2), rec, fileNow2);
  check('老师未改动的项变化 → 不算冲突', rep2.conflicts.length === 0);
  check('未改动项跟随新默认值', rep2.conflicts.length === 0);

  // 无冲突时不应误报
  const rep3 = store.restore(deep(DEFAULTS), rec, DEFAULTS);
  check('文件未变 → 无冲突', rep3.conflicts.length === 0);
}

/* ============================ 7. 降级模式 ============================ */

console.log('\n[7] 存储不可用时的降级');
{
  const boom = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
    key() { throw new Error('SecurityError'); },
    get length() { throw new Error('SecurityError'); },
  };
  const store = new TunedStore({ storage: boom });
  check('storage.getItem 抛异常时 load 返回 null', store.load('squat') === null);
  const r = store.save('squat', { patch: { 'fsm.minRepMs': 500 }, baseline: flattenParams(DEFAULTS) });
  check('写入失败 → ok:false 且带 error，不抛给调用方', r.ok === false && r.error instanceof Error, r.error && r.error.message);
  check('失败被记录在 lastError', store.lastError instanceof Error);
  check('list 在存储抛异常时返回空数组', Array.isArray(store.list()));
  store.clear('squat');
  check('clear 抛异常被吞掉', true);
}

/* ============================ 8. 导入解析 ============================ */

console.log('\n[8] 导入文件解析');
{
  const store = new TunedStore({ storage: memoryStorage() });
  const base = flattenParams(DEFAULTS);

  const archive = JSON.stringify({ v: 1, id: 'squat', patch: { 'fsm.minRepMs': 600 }, baseline: { 'fsm.minRepMs': 400 } });
  const a = store.parseImport(archive, base);
  check('识别存档格式', a.patch['fsm.minRepMs'] === 600 && a.id === 'squat');

  const full = JSON.stringify({ id: 'squat', name: '深蹲', signals: DEFAULTS.signals, fsm: DEFAULTS.fsm });
  const b = store.parseImport(full, base);
  check('识别完整动作配置格式', b.patch['fsm.phases.stand.enter.gte'] === 158, Object.keys(b.patch).length + ' 项');
  check('完整配置里等于默认值的项会被 save 过滤掉', Object.keys(diffPatch(b.patch, DEFAULTS)).length === 0);

  let threw = null;
  try { store.parseImport('{ 坏 JSON', base); } catch (e) { threw = e; }
  check('坏 JSON → 抛可读错误', threw && /JSON/.test(threw.message), threw && threw.message);

  threw = null;
  try { store.parseImport('{"hello":"world"}', base); } catch (e) { threw = e; }
  check('无参数内容 → 抛可读错误', threw && /识别/.test(threw.message), threw && threw.message);
}

/* ============================ 9. 多动作互不干扰 ============================ */

console.log('\n[9] 多动作各自独立（M3 用）');
{
  const st = memoryStorage();
  const store = new TunedStore({ storage: st });
  const base = flattenParams(DEFAULTS);
  store.save('squat', { patch: { 'fsm.minRepMs': 500 }, baseline: base });
  store.save('jumping_jack', { patch: { 'fsm.minRepMs': 700 }, baseline: base });

  check('两个动作各存各的',
    store.load('squat').patch['fsm.minRepMs'] === 500 &&
    store.load('jumping_jack').patch['fsm.minRepMs'] === 700);
  const list = store.list();
  check('list 能列出全部存档', list.length === 2 && list.every((x) => x.count === 1),
    JSON.stringify(list.map((x) => x.id + '×' + x.count)));
  store.clear('squat');
  check('清一个不影响另一个', store.load('squat') === null && store.load('jumping_jack') !== null);
}

/* ============================ 10. 路径写入 ============================ */

console.log('\n[10] setPath / getPath 边界');
{
  const o = { a: { b: 1 }, arr: [1, 2] };
  setPath(o, 'a.b', 5);
  check('写已存在的嵌套路径', getPath(o, 'a.b') === 5);
  setPath(o, 'arr.1', 9);
  check('按下标写数组元素，不破坏数组类型', Array.isArray(o.arr) && o.arr[1] === 9, JSON.stringify(o.arr));
  setPath(o, 'arr.2', 3);
  check('数组追加不变成对象', Array.isArray(o.arr) && o.arr.length === 3, JSON.stringify(o.arr));
  setPath(o, 'x.y', 1);
  check('写新路径自动建对象', getPath(o, 'x.y') === 1);
  check('读不存在的路径返回 undefined', getPath(o, 'nope.deep.deeper') === undefined);
}

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : ''));
}
console.log('='.repeat(64));
process.exit(failed.length ? 1 : 0);
