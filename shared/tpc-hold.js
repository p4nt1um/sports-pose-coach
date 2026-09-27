/**
 * tpc-hold.js — 「保持类」动作的计时器（马步、靠墙静蹲、平板支撑…）
 *
 * 计数关心「走完一个相位环」，计时关心「条件成立持续了多久」。
 * 两者不能用同一个类硬套：计时的验收标准是**与秒表对表**，
 * 所以这里的时间累加口径必须明确、可解释、可测。
 *
 * 三个口径都是有意的：
 *
 *  1) 累加的是「条件成立的那些帧的间隔之和」，而不是 now - startAt。
 *     用挂钟差会在两种真实情况下骗人：关键点丢失（人走出画面、被遮挡）时
 *     计时会继续走；浏览器标签页被切到后台时限流也会让时间照样前进。
 *     按帧累加则两个问题自动消失 —— 没有帧就没有时间。
 *
 *  2) minHoldMs —— 条件成立后先稳定这么久才开始计入。
 *     否则人从站立过渡到静蹲时，膝角「路过」合格区间的几十毫秒也会被算进去，
 *     30 秒下来能多出好几秒。注意：稳定期本身的时间**会补计**（条件确实成立过），
 *     只是要等够 minHoldMs 才确认，避免刚开始计时就读数乱跳。
 *
 *  3) breakGraceMs —— 条件短暂不成立（关键点抖一下、呼吸让躯干角度跳两度）
 *     不当作中断，超过宽限期才结束当前段。宽限期内的时间**不累加**：
 *     没保持就不算，这条宁可保守 —— 与秒表对表时少计比多计更容易解释。
 *
 * 与 PhaseFsm 一样，这个类不认识关键点索引，也不认识「马步」。
 * 它只吃一维数值，因此能在 node 里被合成信号直接单测。
 */

import { PhaseFsm } from './tpc-fsm.js';

/** 计时器的阶段，用于界面文案 */
export const HOLD_STATE = {
  IDLE: 'idle',           // 条件不满足
  PENDING: 'pending',     // 条件成立，正在等 minHoldMs 确认
  HOLDING: 'holding',     // 正在计时
  GRACE: 'grace',         // 条件刚断，宽限期内（可能接回上段）
};

export class HoldTracker {
  /**
   * @param {object} cfg
   * @param {object[]} cfg.conditions 全部满足才算「在保持」。每项 {signal, gte?,lte?,gt?,lt?,label?}
   * @param {number} [cfg.minHoldMs=500]    稳定多久才确认开始计时
   * @param {number} [cfg.breakGraceMs=500] 条件中断多久才算这一段结束
   * @param {number} [cfg.minSessionMs=1000] 单段短于此不计入总时长（仍保留在 sessions 里标 invalid）
   * @param {number} [cfg.minConfidence=0.5]
   */
  constructor(cfg = {}) {
    if (!Array.isArray(cfg.conditions) || !cfg.conditions.length) {
      throw new Error('HoldTracker: 缺少 conditions（至少一条）');
    }
    for (const c of cfg.conditions) {
      if (!c.signal) throw new Error('HoldTracker: conditions 每项都需要 signal');
      if (c.gte == null && c.lte == null && c.gt == null && c.lt == null) {
        throw new Error('HoldTracker: conditions 的 ' + c.signal + ' 没有任何比较条件，会永远成立');
      }
    }

    this.cfg = {
      minHoldMs: 500,
      breakGraceMs: 500,
      minSessionMs: 1000,
      minConfidence: 0.5,
      ...cfg,
    };

    this.events = [];
    this.maxEvents = 400;
    this.reset();
  }

  reset() {
    this.inSession = false;
    this.candidateSince = 0;      // 条件首次成立的时刻
    this.brokenAt = 0;            // 条件开始不成立的时刻
    this.sessionStartAt = 0;
    this.currentMs = 0;           // 当前这一段已累计
    this.totalMs = 0;             // 有效段累计（bestMs 的累加）
    this.bestMs = 0;
    this.sessions = [];
    this.checks = [];
    this.lastTickAt = 0;
    this.lastGoodAt = 0;
    this.lastTMs = 0;
    /**
     * 当前段内「条件断开」的次数。
     *
     * 它存在的唯一理由是给语音指导一个**可分辨**的判据：
     * 「学生主动站起来结束」与「姿势散掉导致中断」在数据上是同一件事
     * （都是条件不成立 → break → 宽限期过 → 结束），无法区分。
     * 但次数能区分一个相邻的事实：正常结束只会断 1 次；
     * 中途姿势散过、抖回来的，会断 ≥2 次。指导只报后者。
     */
    this._breakCount = 0;
    this.events = this.events || [];
    this.events.length = 0;
    this._emit('reset', 0, {});
  }

  _emit(type, tMs, extra) {
    const ev = { type, tMs, ...extra };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.shift();
    return ev;
  }

  /** 当前阶段（界面文案用） */
  get state() {
    if (this.inSession) return this.brokenAt ? HOLD_STATE.GRACE : HOLD_STATE.HOLDING;
    if (this.candidateSince) return HOLD_STATE.PENDING;
    return HOLD_STATE.IDLE;
  }

  /** 各条件是否成立 —— 界面靠它回答「为什么没开始计时」 */
  _evaluate(values, confidence) {
    const minConf = this.cfg.minConfidence;
    return this.cfg.conditions.map((c) => {
      const v = values[c.signal];
      const cv = confidence[c.signal] == null ? 1 : confidence[c.signal];
      const ok = PhaseFsm.test(v, c);
      const confOk = cv >= minConf;
      return {
        signal: c.signal,
        label: c.label || c.signal,
        value: v === undefined ? null : v,
        ok: ok && confOk,
        condOk: ok,
        conf: cv,
      };
    });
  }

  /** 公开快照。界面与 node 测试都走它，避免直接用内部方法 */
  snapshot(fromIndex = 0) {
    return this._snapshot(fromIndex);
  }

  /** 事件列表（与 RepsTracker.allEvents 同形，供调试台统一画标记） */
  allEvents() {
    return this.events.slice();
  }

  /** 供门面统一调用：计时类没有「计数」概念，统一报 0 */
  get count() { return 0; }

  /**
   * 结账「进行中的那一段」。停止计数、关摄像头、切换动作前都要调。
   *
   * 为什么必须显式：段只在「条件断开」时自动结束。若学生一直保持到老师说停，
   * 那段始终处于进行中，不调这里就不会进入 totalMs，计时看起来像没记上。
   * 界面实时显示走 snapshot().liveMs，不需要等这次结账。
   * @param {number} [tMs] 结束时刻，默认沿用最后一帧的时间
   */
  finalize(tMs) {
    const at = tMs === undefined ? this.lastTMs : tMs;
    if (this.inSession) this._endSession(at, 'finalize');
    return this._snapshot(0);
  }

  /**
   * 推进一帧
   * @param {object} frame { values, confidence, tMs }
   */
  update(frame) {
    const tMs = frame.tMs;
    const before = this.events.length;
    const dt = this.lastTMs ? tMs - this.lastTMs : 0;

    this.checks = this._evaluate(frame.values || {}, frame.confidence || {});
    const ok = this.checks.every((c) => c.ok);

    if (ok) {
      this.lastGoodAt = tMs;
      if (!this.candidateSince) this.candidateSince = tMs;

      if (this.brokenAt) {
        if (tMs - this.brokenAt <= this.cfg.breakGraceMs) {
          this.brokenAt = 0;                       // 宽限内抖回 → 仍是同一段
        } else {
          this._endSession(tMs, 'timeout');        // 真断了
          this.candidateSince = tMs;               // 重新累计 minHoldMs
        }
      }

      if (!this.inSession && tMs - this.candidateSince >= this.cfg.minHoldMs) {
        this._startSession(this.candidateSince, tMs);
      }

      if (this.inSession && dt > 0) this.currentMs += dt;
    } else {
      this.candidateSince = 0;
      if (this.inSession && !this.brokenAt) {
        this.brokenAt = tMs;
        this._breakCount++;
        this._emit('break', tMs, { graceMs: this.cfg.breakGraceMs, nth: this._breakCount });
      }
      if (this.inSession && this.brokenAt && tMs - this.brokenAt > this.cfg.breakGraceMs) {
        this._endSession(tMs, 'break');
      }
    }

    this.lastTMs = tMs;
    return this._snapshot(before);
  }

  _startSession(startAt, tMs) {
    this.inSession = true;
    this.sessionStartAt = startAt;
    // 稳定期的时间补计：条件在 startAt 就成立了，只是到 tMs 才确认
    this.currentMs = Math.max(0, tMs - startAt);
    this.brokenAt = 0;
    this._breakCount = 0;
    this._emit('start', tMs, { at: startAt, backfillMs: Math.round(this.currentMs) });
  }

  /** 结束当前段。ms 取实际累加值 —— 宽限期内不计时，所以不能用 endAt - startAt */
  _endSession(tMs, reason) {
    const ms = Math.round(this.currentMs);
    const valid = ms >= this.cfg.minSessionMs;
    const s = {
      index: this.sessions.length + 1,
      startAt: this.sessionStartAt,
      endAt: tMs,
      ms,
      valid,
      reason,
      /** 段内条件断开次数。正常结束为 1；中途散过又抖回来的会 ≥2 */
      breaks: this._breakCount,
    };
    this.sessions.push(s);
    if (valid) {
      this.totalMs += ms;
      if (ms > this.bestMs) this.bestMs = ms;
    }
    this.inSession = false;
    this.sessionStartAt = 0;
    this.currentMs = 0;
    this.candidateSince = 0;
    this.brokenAt = 0;
    this._breakCount = 0;
    this._emit('end', tMs, { ms, valid, reason, breaks: s.breaks });
  }

  _snapshot(fromIndex) {
    return {
      events: this.events.slice(fromIndex),
      mode: 'hold',
      state: this.state,
      holding: this.inSession,
      currentMs: Math.round(this.currentMs),
      /** 已结账的有效段之和。不含进行中的那一段 —— 停止前它还在累 */
      totalMs: Math.round(this.totalMs),
      /**
       * 界面实时读数用这个：已结账 + 进行中。
       * 只用 totalMs 的话，「一直保持到老师说停」的场景全程显示 0，
       * 因为进行中的段要等结束才结账。
       */
      liveMs: Math.round(this.totalMs + (this.inSession ? this.currentMs : 0)),
      bestMs: Math.round(this.bestMs),
      sessions: this.sessions,
      sessionCount: this.sessions.filter((s) => s.valid).length,
      // 距确认还差多久（界面显示「稳定判定中 0.3s / 0.5s」）
      pendingMs: this.candidateSince ? Math.round(Math.min(this.cfg.minHoldMs, this.lastTMs - this.candidateSince)) : 0,
      needHoldMs: this.cfg.minHoldMs,
      graceMs: this.brokenAt ? Math.round(this.lastTMs - this.brokenAt) : 0,
      graceLimitMs: this.cfg.breakGraceMs,
      checks: this.checks,
    };
  }
}

export default HoldTracker;
