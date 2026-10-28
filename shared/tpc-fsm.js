/**
 * tpc-fsm.js — 通用「计数状态机」
 *
 * 核心主张：**计数不准的根源是"越过阈值就 +1"，不是阈值没调对。**
 * 朴素阈值法会把走路、挥手、半蹲、坐下、抖动全算进去，而且没法解释为什么多算。
 * 这里用四个机制替换它，每个机制都为了解决一类真实误判：
 *
 *  1) 迟滞（hysteresis）
 *     cycle 里相邻相位的信号区间**故意留空档**。例如站立相要求膝角 ≥158，
 *     下蹲相要求 ≤100 —— 中间 100~158 是死区。人在死区里来回时状态不变，
 *     腿抖、呼吸起伏、小幅摆动都不会产生计数。
 *     转移条件只看"下一个相位的 enter 是否满足"，空档本身就是迟滞带。
 *
 *  2) 相位序列（cycle）
 *     必须按 cycle 顺序走完一圈才算一次。站起来但没蹲下 → 不计数；
 *     蹲下去但没站起来 → 不计数。半蹲只到 130° 永远进不了下蹲相 → 不计数。
 *     跳相（抖动直接跨过）不算，因此"一次动作被识别成两次"也很难发生。
 *
 *  3) 时间约束（minRepMs / maxRepMs）
 *     时长口径要留意：状态机只观测得到阈值穿越，所以能测的最长区间是
 *     「进入末相位 → 回到起始相位」（对深蹲约等于半周期）。
 *     短于 minRepMs 的判为抖动丢弃；长于 maxRepMs 的判为"停住不动"丢弃
 *     （这个方向顺手把"坐椅子站起来"抓出来了）。两者都记入 rejections，
 *     所以界面上能回答"为什么没计数"。调试台会显示实测值，照着实调即可。
 *
 *  4) 稳定帧数与冻结/复位（minHoldFrames / confidence / lossResetMs）
 *     进入新相位需要连续 K 帧满足条件，单帧尖峰不算；
 *     关键点不可信（visibility 低）时冻结推进；丢失超过 lossResetMs 后
 *     回到 unknown 重新认相位，避免"人走开又回来"时把两段动作接成一次。
 *
 *  5) 半程闸门（armed / PARTIAL）
 *     只有先观测到"离开起始相位"，回到起始相位才计一次。否则一开局就蹲着、
 *     随后站起来会被白送一次计数 —— 这类脏数据在真实课堂里一定会出现。
 *
 * 这个类不认识深蹲，也不认识关键点索引。它只吃一维数值。
 * 于是它同时能被 data/exercises.json 驱动、被 node 合成信号单元测试。
 */

/** 尚未认出相位。人在画面外、刚启动、丢失超时后都回到这里 */
export const PHASE_UNKNOWN = 'unknown';

/**
 * 从一段信号轨迹里量「真正在动」的时长。
 *
 * 为什么要这么绕：状态机只知道阈值穿越，"进入末相位 → 回到起始相位"的原始时长
 * 里混着**底部停顿**。举重/深蹲/俯卧撑里在最低点歇 2 秒是常事，
 * 而教学语言要的是「下放 1.2 秒、起身 0.8 秒」——停顿不能算进任何一半。
 *
 * 做法（借自 vision-demos 的 chin_ups / push_ups）：取速度最快的那一点，
 * 往两边走到速度落到最快值 10% 以下的位置，这一段就是"真正在动"的窗口。
 *
 * @param {{t:number, v:number}[]} samples 时间严格递增
 * @param {number} ratio 视为"还没停下来"的速度比例，默认 0.1
 * @returns {{activeMs:number|null, rawMs:number, peakRate:number|null, samples:number}}
 */
export function activeWindowMs(samples, ratio = 0.1) {
  const raw = { activeMs: null, rawMs: 0, peakRate: null, samples: samples ? samples.length : 0 };
  if (!samples || samples.length < 4) {
    if (samples && samples.length >= 2) {
      raw.rawMs = Math.round(samples[samples.length - 1].t - samples[0].t);
    }
    return raw;
  }
  raw.rawMs = Math.round(samples[samples.length - 1].t - samples[0].t);

  const speeds = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (dt <= 1e-4) continue;
    speeds.push({ t0: samples[i - 1].t, t1: samples[i].t, v: Math.abs((samples[i].v - samples[i - 1].v) / dt) });
  }
  if (!speeds.length) return raw;

  let peakIdx = 0;
  for (let i = 1; i < speeds.length; i++) if (speeds[i].v > speeds[peakIdx].v) peakIdx = i;
  const peak = speeds[peakIdx].v;
  raw.peakRate = peak;
  // 整段都几乎不动（站住/撑住）→ 没有"在动的窗口"，返回 null 而不是 0，别假装测到了
  if (!(peak > 1e-6)) return raw;

  const th = peak * ratio;
  let i = peakIdx;
  while (i > 0 && speeds[i - 1].v >= th) i--;
  let j = peakIdx;
  while (j < speeds.length - 1 && speeds[j + 1].v >= th) j++;
  raw.activeMs = Math.round(speeds[j].t1 - speeds[i].t0);
  return raw;
}

/** 拒绝原因：用于回答"动作做了但没计数" */
export const REJECT = {
  TOO_FAST: 'too_fast',         // 周期短于 minRepMs → 判定为抖动
  TOO_SLOW: 'too_slow',         // 周期长于 maxRepMs → 判定为"停住不动"
  PARTIAL: 'partial',           // 没观测到"离开起始相位"，只有半个动作
  LOW_CONFIDENCE: 'low_conf',   // 关键点不可信，本帧不推进
};

export class PhaseFsm {
  /**
   * @param {object} cfg 来自 data/exercises.json 的 fsm 段
   * @param {string}   cfg.signal       主信号名（SignalSet 里的键）
   * @param {string[]} cfg.cycle        相位环，相邻元素不同；回到第 0 项即完成一次
   * @param {object}   cfg.phases       { 相位id: { enter: {gte?,lte?,gt?,lt?} } }
   * @param {number}   cfg.minRepMs     周期下限（默认 300）
   * @param {number}   cfg.maxRepMs     周期上限（默认 12000，0/省略表示不限）
   * @param {number}   cfg.minHoldFrames 进入新相位需连续满足帧数（默认 2）
   * @param {number}   cfg.lossResetMs  丢失多久后复位相位（默认 500）
   * @param {number}   cfg.minConfidence 低于此值冻结推进（默认 0.5）
   * @param {object[]} cfg.guards       规范性检查（只记录，不阻断计数）
   */
  constructor(cfg = {}) {
    if (!cfg.signal) throw new Error('PhaseFsm: 缺少 signal');
    if (!Array.isArray(cfg.cycle) || cfg.cycle.length < 2) {
      throw new Error('PhaseFsm: cycle 至少需要 2 个相位');
    }
    for (let i = 0; i < cfg.cycle.length; i++) {
      const a = cfg.cycle[i];
      const b = cfg.cycle[(i + 1) % cfg.cycle.length];
      if (a === b) throw new Error('PhaseFsm: cycle 相邻相位不能相同（' + a + '）');
      if (!cfg.phases[a]) throw new Error('PhaseFsm: cycle 里的相位 ' + a + ' 没有定义');
    }

    this.cfg = {
      minRepMs: 300,
      maxRepMs: 12000,
      minHoldFrames: 2,
      lossResetMs: 500,
      minConfidence: 0.5,
      guards: [],
      ...cfg,
    };

    /** 全部事件（带容量上限，供调试台画标注） */
    this.events = [];
    this.maxEvents = 800;

    this.reset();
  }

  reset() {
    this.phase = PHASE_UNKNOWN;
    this.stageIndex = -1;          // -1 表示 unknown
    this.count = 0;
    this.rejections = { too_fast: 0, too_slow: 0, partial: 0, low_conf: 0 };
    this.phaseEnteredAt = 0;
    this.phaseFrames = 0;
    /**
     * 进入「本轮最后一个相位」的时刻。
     *
     * 为什么只测这一段：状态机只观测得到阈值穿越，死区内的穿越它看不见。
     * 所以能测的最长区间是「进入下蹲相 → 回到起始相」，对深蹲约等于半周期
     * （上升段 + 相位判定延迟）。minRepMs / maxRepMs 都是相对这个量定义的。
     * 好处是 maxRepMs 天然能抓「蹲在底部不动」——正好是坐椅子的特征。
     * 意义别猜：调试台会把实测值实时显示出来，照着调即可。
     */
    this.lastPhaseAt = 0;
    /** 是否观测到过"离开起始相位"。防守场景：一开局就蹲着，站起来不该算一次 */
    this.armed = false;
    this.lastGoodAt = 0;           // 最近一次信号可信的时间
    this.lastValue = null;
    this.pendingIdx = -1;
    this.pendingFrames = 0;
    this.frozen = false;
    this.lost = true;
    this.currentGuardFlags = [];
    this.lastRep = null;
    this.events = this.events || [];
    this.events.length = 0;
    this._repMin = null;
    this._repMax = null;
    this._repGuardMap = new Map();
    /**
     * 最近一段信号轨迹，用来量「向心/离心」时长（避开底部停顿）。
     * 只存可信帧；容量按 maxRepMs 截断，最坏情况下也就几百个点。
     */
    this._hist = [];
    /** 本轮起始相位的进入时刻，以及上一轮的（对比用） */
    this._cycleStartAt = 0;
    this._prevCycleStart = 0;
    this._emit('reset', 0, {});
  }

  get cycle() { return this.cfg.cycle; }
  get signalName() { return this.cfg.signal; }

  _emit(type, tMs, extra) {
    const ev = { type, tMs, ...extra };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.shift();
    return ev;
  }

  /** 条件求值：{gte, lte, gt, lt} 任意组合，全部满足才算通过 */
  static test(value, cond) {
    if (value === null || value === undefined || !isFinite(value)) return false;
    if (!cond) return true;
    if (cond.gte != null && !(value >= cond.gte)) return false;
    if (cond.lte != null && !(value <= cond.lte)) return false;
    if (cond.gt != null && !(value > cond.gt)) return false;
    if (cond.lt != null && !(value < cond.lt)) return false;
    return true;
  }

  _guardFlags(values, phase) {
    const flags = [];
    for (const g of this.cfg.guards) {
      if (g.when && g.when !== phase) continue;
      const v = values[g.signal];
      if (v === null || v === undefined) continue;
      const ok = PhaseFsm.test(v, g);
      if (!ok) flags.push({ label: g.label, signal: g.signal, value: v, severity: g.severity || 'warn' });
    }
    return flags;
  }

  /**
   * 推进一步
   * @param {object} frame { values, confidence, tMs }
   * @returns {{events:object[], phase:string, count:number, frozen:boolean, lost:boolean}}
   */
  update(frame) {
    const tMs = frame.tMs;
    const values = frame.values || {};
    const confMap = frame.confidence || {};
    const before = this.events.length;

    const raw = values[this.cfg.signal];
    const conf = confMap[this.cfg.signal] == null ? 1 : confMap[this.cfg.signal];
    this.lastValue = raw === undefined ? null : raw;

    // ---- 信号不可用：冻结推进，按丢失计时决定是否复位 ----
    const usable = raw !== null && raw !== undefined && isFinite(raw);
    const trusted = usable && conf >= this.cfg.minConfidence;

    if (!trusted) {
      this.frozen = true;
      this.lost = true;
      if (usable) this.rejections.low_conf++;
      if (this.lastGoodAt && tMs - this.lastGoodAt > this.cfg.lossResetMs) {
        if (this.phase !== PHASE_UNKNOWN) {
          this._emit('reset', tMs, { reason: 'lost', from: this.phase });
          this.phase = PHASE_UNKNOWN;
          this.stageIndex = -1;
          this.pendingIdx = -1;
          this.pendingFrames = 0;
          this.cycleStartedAt = 0;
        }
      }
      return this._snapshot(before);
    }

    this.frozen = false;
    this.lost = false;
    this.lastGoodAt = tMs;
    this.phaseFrames++;
    this._pushHist(tMs, raw);

    const def = this.cfg.phases;
    const n = this.cfg.cycle.length;

    // ---- 未知相位：认一个当前满足条件的相位，不计数 ----
    if (this.stageIndex < 0) {
      for (let i = 0; i < n; i++) {
        if (PhaseFsm.test(raw, def[this.cfg.cycle[i]].enter)) {
          this._enterPhase(this.cfg.cycle[i], i, tMs, true);
          // 认相位即作为本轮起点。若认出的是「非起始相位」（如开局就蹲着），
          // armed 仍为 false —— 随后站起来会因 PARTIAL 被拒绝，不会白送一次计数
          this.lastPhaseAt = tMs;
          break;
        }
      }
      this._trackExtremes(raw);
      return this._snapshot(before);
    }

    // ---- 常规推进：只看"下一个相位"的条件是否满足 ----
    const nextIdx = (this.stageIndex + 1) % n;
    const nextPhase = this.cfg.cycle[nextIdx];
    const nextOk = PhaseFsm.test(raw, def[nextPhase].enter);

    if (nextOk) {
      // 防单帧尖峰：需要连续 minHoldFrames 帧满足
      if (this.pendingIdx !== nextIdx) {
        this.pendingIdx = nextIdx;
        this.pendingFrames = 1;
      } else {
        this.pendingFrames++;
      }

      if (this.pendingFrames >= this.cfg.minHoldFrames) {
        this._advanceTo(nextIdx, tMs);
      }
    } else {
      this.pendingIdx = -1;
      this.pendingFrames = 0;
    }

    // 规范性检查（只记录，不阻断）。逐帧追加会膨胀，用 Map 按项合并
    this.currentGuardFlags = this._guardFlags(values, this.phase);
    for (const f of this.currentGuardFlags) {
      const k = f.label + '|' + f.signal;
      if (!this._repGuardMap.has(k)) this._repGuardMap.set(k, { ...f, samples: 1 });
      else {
        const prev = this._repGuardMap.get(k);
        prev.samples++;
        prev.value = f.value;
      }
    }
    this._trackExtremes(raw);

    return this._snapshot(before);
  }

  /** 记录可信帧的轨迹（给向心/离心时长用） */
  _pushHist(t, v) {
    this._hist.push({ t, v });
    const keepMs = Math.max(this.cfg.maxRepMs || 12000, 4000) * 1.2;
    while (this._hist.length && this._hist[0].t < t - keepMs) this._hist.shift();
    if (this._hist.length > 1500) this._hist.splice(0, this._hist.length - 1500);
  }

  /** 取 [ta, tb] 区间内的轨迹并量出"真正在动"的时长 */
  _window(ta, tb) {
    if (!ta || !tb || tb <= ta) return { activeMs: null, rawMs: 0, peakRate: null, samples: 0 };
    const seg = this._hist.filter((p) => p.t >= ta && p.t <= tb);
    return activeWindowMs(seg, 0.1);
  }

  /** 记录一次 rep 内主信号的极值，用于判断"蹲到位没有" */
  _trackExtremes(v) {
    if (v === null || !isFinite(v)) return;
    if (this._repMin === null || v < this._repMin) this._repMin = v;
    if (this._repMax === null || v > this._repMax) this._repMax = v;
  }

  _enterPhase(phaseId, idx, tMs, silent) {
    this.phase = phaseId;
    this.stageIndex = idx;
    this.phaseEnteredAt = tMs;
    this.phaseFrames = 0;
    this.pendingIdx = -1;
    this.pendingFrames = 0;
    if (idx === 0) {
      // 回到起始相 = 新一轮开始。旧的那一轮起始时刻留一份给"上一半"用
      this._prevCycleStart = this._cycleStartAt || tMs;
      this._cycleStartAt = tMs;
    } else if (!this._cycleStartAt) {
      // 开局就处在末相位（例如一进来就蹲着）：起始时刻未知，只能记 None
      this._cycleStartAt = 0;
    }
    if (!silent) this._emit('phase', tMs, { to: phaseId, index: idx });
  }

  _advanceTo(nextIdx, tMs) {
    const fromPhase = this.phase;
    const nextPhase = this.cfg.cycle[nextIdx];
    // 离开前所在相位的停留时长（必须在 _enterPhase 之前取）
    const dwellMs = this.phaseEnteredAt ? tMs - this.phaseEnteredAt : 0;
    // 这两个也必须在 _enterPhase 之前取：它会改写 _cycleStartAt
    const cycleStartAt = this._cycleStartAt;
    const lastPhaseAt = this.lastPhaseAt;

    this._enterPhase(nextPhase, nextIdx, tMs);

    if (nextIdx === 1) {
      // 进入「本轮最后一个相位」→ 完成段从这里起算
      this.lastPhaseAt = tMs;
      this.armed = true;
      this._repMin = null;
      this._repMax = null;
      // 注意：**不能在这里清空 _repGuardMap**。
      // 规范性标记属于"整个动作"，起始相位（如俯卧撑的「撑起」）上的标记
      // 才是"这次有没有撑直"的证据。在这里清一次，起点相的标记就永远丢失，
      // 于是 when:'up' 的 guard 写了也等于没写（只能看到终点相的标记）。
    }

    // 某相位停留过久 → 打标记，不阻断计数。
    // 诚实说明：**"坐椅子站起来"与深蹲在单一膝角信号下几乎不可分**，
    // 这不是阈值能解决的问题。做法是不假装能分辨，而是把特征暴露出来，
    // 让界面提示"这次底部停留 3.2s，是否坐着完成？"，由人判断。
    const dwellLimit = this.cfg.phaseMaxDwellMs && this.cfg.phaseMaxDwellMs[fromPhase];
    if (dwellLimit && dwellMs > dwellLimit) {
      const label = (this.cfg.phases[fromPhase] && this.cfg.phases[fromPhase].label) || fromPhase;
      const key = 'dwell|' + fromPhase;
      const prev = this._repGuardMap.get(key);
      if (!prev) {
        this._repGuardMap.set(key, {
          label: '在「' + label + '」停留过久（是否坐着完成？）',
          signal: 'dwellMs',
          value: Math.round(dwellMs),
          severity: 'warn',
          samples: 1,
        });
      } else {
        prev.samples++;
        prev.value = Math.round(dwellMs);
      }
    }

    if (nextIdx === 0) {
      // ---- 回到起始相位：走完一环 ----
      const durationMs = this.lastPhaseAt ? tMs - this.lastPhaseAt : 0;
      const rep = {
        completedAt: tMs,
        durationMs,
        signalMin: this._repMin,
        signalMax: this._repMax,
        from: fromPhase,
        flags: Array.from(this._repGuardMap.values()),
        accepted: false,
        reject: null,
      };

      /**
       * 向心 / 离心拆解。
       * 每个"半程"给出两个数：`rawMs`（阈值穿越的原始时长，混着停顿）与
       * `activeMs`（速度回推到峰值 10% 以内，真正的运动时间）。
       * 教学上要的是后者：「下放 1.2 秒、起身 0.8 秒」。
       *
       * 只在两相位动作（深蹲/俯卧撑/开合跳/仰卧起坐/高抬腿）上拆解。
       * 相位更多时方向不是"下去/起来"这种简单对偶，硬拆会给出误导性的话。
       */
      if (this.cfg.cycle.length === 2) {
        const back = this._window(cycleStartAt, lastPhaseAt);
        const forth = this._window(lastPhaseAt, tMs);
        const c0 = this.cfg.cycle[0];
        const c1 = this.cfg.cycle[1];
        // verb 是给老师看的动词（「下放」「起身」），写在 exercises.json 里。
        // 没写就退回相位名，宁可生硬也不编造词。
        const verb = Array.isArray(this.cfg.verb) ? this.cfg.verb : [];
        const pname = (p) => (this.cfg.phases[p] && this.cfg.phases[p].label) || p;
        rep.transitions = [
          {
            from: c0, to: c1,
            label: verb[0] || pname(c0) + '→' + pname(c1),
            rawMs: back.rawMs, activeMs: back.activeMs, peakRate: back.peakRate,
          },
          {
            from: c1, to: c0,
            label: verb[1] || pname(c1) + '→' + pname(c0),
            rawMs: forth.rawMs, activeMs: forth.activeMs, peakRate: forth.peakRate,
          },
        ];
      }

      if (!this.armed) {
        // 没观测到离开起始相位：只有半个动作（例如开局就蹲着、随后站起来）
        rep.reject = REJECT.PARTIAL;
        this.rejections.partial++;
        this._emit('reject', tMs, { reason: REJECT.PARTIAL, phase: nextPhase });
      } else if (durationMs < this.cfg.minRepMs) {
        rep.reject = REJECT.TOO_FAST;
        this.rejections.too_fast++;
        this._emit('reject', tMs, { reason: REJECT.TOO_FAST, durationMs, min: this.cfg.minRepMs });
      } else if (this.cfg.maxRepMs > 0 && durationMs > this.cfg.maxRepMs) {
        rep.reject = REJECT.TOO_SLOW;
        this.rejections.too_slow++;
        this._emit('reject', tMs, { reason: REJECT.TOO_SLOW, durationMs, max: this.cfg.maxRepMs });
      } else {
        rep.accepted = true;
        rep.index = ++this.count;
        this._emit('count', tMs, {
          count: this.count,
          durationMs,
          signalMin: this._repMin,
          signalMax: this._repMax,
        });
      }

      this.lastRep = rep;
      // 本轮结束，基准归零。下一次「进入末相位」重新起算 —— 不做基准前移，
      // 否则"蹲住很久"会被倒推成很短的完成段而误判为合格
      this.lastPhaseAt = 0;
      this.armed = false;
      this._repMin = null;
      this._repMax = null;
      this._repGuardMap = new Map();
    }
  }

  /**
   * 只取状态、不带事件。
   * 多通道动作（高抬腿左右腿）聚合读数时用 —— 事件由各通道自己保留，
   * 门面只需要状态，避免每次快照都复制几百条事件。
   */
  state() {
    return {
      phase: this.phase,
      stageIndex: this.stageIndex,
      count: this.count,
      armed: this.armed,
      frozen: this.frozen,
      lost: this.lost,
      value: this.lastValue,
      rejections: { ...this.rejections },
      lastRep: this.lastRep,
      guardFlags: this.currentGuardFlags,
    };
  }

  _snapshot(fromIndex) {
    const events = this.events.slice(fromIndex);
    return {
      events,
      phase: this.phase,
      stageIndex: this.stageIndex,
      count: this.count,
      armed: this.armed,
      frozen: this.frozen,
      lost: this.lost,
      value: this.lastValue,
      rejections: this.rejections,
      lastRep: this.lastRep,
      guardFlags: this.currentGuardFlags,
    };
  }
}
