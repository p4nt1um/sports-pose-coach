/**
 * tpc-counter.js — 计数 / 计时的统一门面
 *
 * 存在的理由有两个：
 *
 *  1) 页面与调试台不该各写一套「读配置 → 建对象 → 取读数」的胶水。
 *     计数页、调试台、node 回归测试用同一套调用方式驱动任何动作，
 *     M3「新增动作只写 JSON」才成立。
 *
 *  2) **多通道**这一层是必需的，不是可选优化。
 *     原地高抬腿是左右腿交替：若把两腿膝高合成一个「取大值」信号，
 *     一条腿落地时另一条已经抬起，合成值始终停在阈值之上、永不回落，
 *     一整轮下来只穿越一次 —— 计数必然严重偏少（见 PLAN 与调试台说明）。
 *     所以左右腿各自一条信号、各跑一个独立状态机，最后合计。
 *     每个通道的阈值/时长约束仍来自同一份 JSON，只是 fsm 模板按通道展开。
 *
 * 这个门面把「单通道 / 多通道 / 计数 / 计时」收敛成同一组方法：
 *   update(frame) → snapshot() → reset()
 * snapshot 的形状对每种形态都稳定，界面不必分支判断。
 */

import { PhaseFsm } from './tpc-fsm.js';
import { HoldTracker } from './tpc-hold.js';

/** 配置的形态：'reps' 计数 / 'hold' 保持计时 */
export function modeOf(cfg) {
  return cfg && cfg.category === 'hold' ? 'hold' : 'reps';
}

/**
 * 把配置摊平成通道数组。
 * - 单通道动作（深蹲等）：一个 id='main' 的默认通道，直接取 cfg.fsm
 * - 多通道动作：cfg.channels[].signal 指定各通道信号，
 *   cfg.fsm 作为模板，通道可用自己的 fsm 字段覆盖个别项
 */
export function channelsOf(cfg) {
  const tpl = (cfg && cfg.fsm) || {};
  if (Array.isArray(cfg && cfg.channels) && cfg.channels.length) {
    return cfg.channels.map((c, i) => {
      const sig = c.signal || tpl.signal;
      return {
        id: c.id || 'ch' + i,
        label: c.label || c.id || '通道 ' + (i + 1),
        signal: sig,
        fsm: { ...tpl, ...(c.fsm || {}), signal: sig },
      };
    });
  }
  return [{ id: 'main', label: '', signal: tpl.signal, fsm: tpl }];
}

/* ============================ 计数（reps） ============================ */

export class RepsTracker {
  constructor(cfg = {}) {
    this.cfg = cfg;
    const chs = channelsOf(cfg);
    for (const c of chs) {
      if (!c.signal) throw new Error('RepsTracker: 通道 ' + c.id + ' 没有 signal');
    }
    /** @type {{id:string,label:string,signal:string,fsm:PhaseFsm}[]} */
    this.channels = chs.map((c) => ({
      id: c.id,
      label: c.label,
      signal: c.signal,
      fsm: new PhaseFsm(c.fsm),
    }));
  }

  get multiChannel() { return this.channels.length > 1; }

  /** 合计计数（多通道求和）。与 HoldTracker 的 count 同名，门面接口才统一 */
  get count() {
    let n = 0;
    for (const c of this.channels) n += c.fsm.count;
    return n;
  }

  /** 主通道的相位（界面/调试台读它） */
  get phase() { return this.channels[0].fsm.phase; }

  /**
   * 全部通道的事件按时间排好 —— 调试台据此画「这里算了一次」的竖线。
   * 多通道时事件带 channel 标记，可以按通道用不同颜色区分是哪条腿。
   */
  allEvents() {
    const out = [];
    for (const c of this.channels) {
      for (const ev of c.fsm.events) out.push({ ...ev, channel: c.id });
    }
    return out.sort((a, b) => a.tMs - b.tMs);
  }

  /**
   * 推进一帧，返回本帧各通道产生的事件（带 channel 标记）。
   * 多通道时界面要知道「这一次是哪条腿算的」，调试台也要按通道画标记。
   */
  update(frame) {
    const events = [];
    for (const c of this.channels) {
      const s = c.fsm.update(frame);
      for (const ev of s.events) events.push({ ...ev, channel: c.id });
    }
    return { events };
  }

  reset() {
    for (const c of this.channels) c.fsm.reset();
  }

  /**
   * 主通道：多通道时取「最近完成一次动作」的那个，让界面能显示
   * 「刚刚这条腿计数了」。都没有记录时退回第一个通道。
   */
  _primary(chs) {
    let best = chs[0];
    for (const c of chs) {
      if (!c.lastRep) continue;
      if (!best.lastRep || c.lastRep.completedAt > best.lastRep.completedAt) best = c;
    }
    return best;
  }

  snapshot() {
    const chs = this.channels.map((c) => {
      const st = c.fsm.state();
      return { id: c.id, label: c.label, signal: c.signal, ...st };
    });

    const count = chs.reduce((a, c) => a + c.count, 0);
    const rejections = { too_fast: 0, too_slow: 0, partial: 0, low_conf: 0 };
    for (const c of chs) {
      for (const k of Object.keys(rejections)) rejections[k] += c.rejections[k] || 0;
    }

    const primary = this._primary(chs);

    return {
      mode: 'reps',
      count,
      channels: chs,
      multiChannel: chs.length > 1,
      phase: primary.phase,
      armed: chs.some((c) => c.armed),
      frozen: chs.every((c) => c.frozen),
      lost: chs.every((c) => c.lost),
      value: primary.value,
      rejections,
      lastRep: primary.lastRep,
      lastRepChannel: primary.id,
      guardFlags: primary.guardFlags,
    };
  }
}

/* ============================ 工厂 ============================ */

/**
 * 按配置建追踪器。返回对象都满足 update/snapshot/reset。
 * 计时动作的读数在 snapshot 里是 {state, holding, currentMs, totalMs, bestMs, checks}；
 * 计数动作是 {count, phase, rejections, lastRep, channels}。
 */
export function createTracker(cfg) {
  if (!cfg) throw new Error('createTracker: 缺少动作配置');
  if (modeOf(cfg) === 'hold') return new HoldTracker(cfg.hold || {});
  return new RepsTracker(cfg);
}

/**
 * 该动作需要哪些信号名 —— 建 SignalSet 与调试台生成滑块都靠它。
 * 直接从 cfg.signals 取键，这样即使某个信号暂时没被任何相位用到也仍然计算，
 * 调试时能看见它。
 */
export function signalNamesOf(cfg) {
  return Object.keys((cfg && cfg.signals) || {});
}

/**
 * 该动作在界面上要显示的主要读数（给动作卡片用，不需要实例化追踪器）
 */
export function readoutOf(cfg) {
  const mode = modeOf(cfg);
  return {
    mode,
    unit: cfg && cfg.unit ? cfg.unit : (mode === 'hold' ? '秒' : '次'),
    primary: cfg && cfg.primary ? cfg.primary : '',
  };
}

export default createTracker;
