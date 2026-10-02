/**
 * tpc-hold.js — 「保持类」动作的计时器（马步、靠墙静蹲、平板支撑…）
 *
 * 计数关心「走完一个相位环」，计时关心「条件成立持续了多久」。
 * 两者不能用同一个类硬套：计时的验收标准是**与秒表对表**，
 * 所以这里的时间累加口径必须明确、可解释、可测。
 *
 * 四个口径都是有意的：
 *
 *  1) 累加的是「条件成立的那些帧的间隔之和」，而不是 now - startAt。
 *     用挂钟差会在两种真实情况下骗人：关键点丢失（人走出画面、被遮挡）时
 *     计时会继续走；浏览器标签页被切到后台时限流也会让时间照样前进。
 *     按帧累加则两个问题自动消失 —— 没有帧就没有时间。
 *     这条在「保持 → 断开 → 再保持」的拼接段上同样成立：断开期间的帧
 *     一律不得计入，所以拼接段的时长自动等于各段成立时长之和，不需要额外扣减。
 *
 *  2) minHoldMs —— 条件成立后先稳定这么久才开始计入。
 *     否则人从站立过渡到静蹲时，膝角「路过」合格区间的几十毫秒也会被算进去，
 *     30 秒下来能多出好几秒。注意：稳定期本身的时间**会补计**（条件确实成立过），
 *     只是要等够 minHoldMs 才确认，避免刚开始计时就读数乱跳。
 *     同一段内「散掉再恢复」时**不重新走**这道闸：段已经确认过了，恢复即继续。
 *
 *  3) breakGraceMs —— 条件短暂不成立（关键点抖一下、呼吸让躯干角度跳两度）
 *     不当作中断。宽限期内的时间**不累加**：没保持就不算，这条宁可保守 ——
 *     与秒表对表时少计比多计更容易解释。
 *
 *  4) 段内断开不结束整段，只暂停累加，恢复后接着加（本文件最重要的一条设计）。
 *
 *     这条规则是踩出来的。早期实现里 breakGraceMs 是「这一段还剩多少命」：
 *     断开超过宽限期就 _endSession，下次条件成立要从零重走 minHoldMs 才开新段。
 *     于是「人弓着背调整了一下姿势再贴回墙」会变成：
 *       断开 400ms → 整段结束；恢复 → 稳定 500ms → 开新段，currentMs 从 0 起。
 *     学生看见的是「我明明一直贴着墙，计时却反复跳回一两秒」。
 *     更糟的是它两头都不讨好：宽限期设长会把「站起来喝水」也算成保持，
 *     设短则任何一次小调整都把成绩清零。根因是把两个不同的问题
 *     —— 「这一下要不要扣时间」和「这一段算不算结束了」—— 绑成了一个阈值。
 *
 *     现在拆开：
 *       · 断开时长 ≤ breakGraceMs   → 当作抖动，不记次数，仍计为同一段（暂停累加）
 *       · 断开时长 >  breakGraceMs   → 记一次「抖动」，仍计为同一段（暂停累加）
 *       两种情况都恢复即继续累加，**绝不重置 currentMs**。
 *     「这一段结束了」只由两件事触发：
 *       · 断开超过 sessionGapMs（默认远大于宽限期，比如 4s）→ 老师/学生明显换了个回合
 *       · 恢复后靠撑的时间仍然不够 breakConfirmMs 被 sessionTimeoutMs 截断 → 实在撑不住了
 *
 *     这个改法顺带让 breaks 的语义变得更可读：它不再是「断了几次就结束几次」，
 *     而是**整段里抖动了几次**，直接可以当稳定性指标用（越小越稳）。
 *
 *     为什么不干脆「永不结束」：段是结算与说话的单位，只进不出的段会让
 *     liveMs 在离场后一直涨、让「第 N 段」永远只有第 1 段。
 *     所以保留两个出口，只是都放宽到「明显不是保持」才触发。
 *
 * 与 PhaseFsm 一样，这个类不认识关键点索引，也不认识「马步」。
 * 它只吃一维数值，因此能在 node 里被合成信号直接单测。
 */

import { PhaseFsm } from './tpc-fsm.js';

/** 计时器的阶段，用于界面文案 */
export const HOLD_STATE = {
  IDLE: 'idle',           // 条件不满足，且还没有段在进行
  PENDING: 'pending',     // 条件成立，正在等 minHoldMs 确认
  HOLDING: 'holding',     // 正在计时
  PAUSED: 'paused',       // 段还在，但条件暂时不成立（暂停累加，等着接回）
};

export class HoldTracker {
  /**
   * @param {object} cfg
   * @param {object[]} cfg.conditions 全部满足才算「在保持」。每项 {signal, gte?,lte?,gt?,lt?,label?}
   * @param {number} [cfg.minHoldMs=500]        稳定多久才确认开始计时
   * @param {number} [cfg.breakGraceMs=500]     条件短暂不成立多久内不记抖动（期间不计时）
   * @param {number} [cfg.sessionGapMs=4000]    断开超过此值才认定这一段结束（必须 ≥ breakGraceMs）
   * @param {number} [cfg.sessionTimeoutMs=120000] 单段最长挂多久（含暂停时间），超时强制结束
   * @param {number} [cfg.minSessionMs=1000]    单段有效累计短于此不计入总时长（仍保留在 sessions 里标 invalid）
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
      sessionGapMs: 4000,
      sessionTimeoutMs: 120000,
      minSessionMs: 1000,
      minConfidence: 0.5,
      ...cfg,
    };
    // 物理一致性：断开判定必须比宽限期更宽松，否则「宽限」形同虚设
    if (!(this.cfg.sessionGapMs >= this.cfg.breakGraceMs)) {
      this.cfg.sessionGapMs = this.cfg.breakGraceMs;
    }

    this.events = [];
    this.maxEvents = 400;
    this.reset();
  }

  reset() {
    this.inSession = false;
    this.candidateSince = 0;      // 条件首次成立的时刻（只用于「开新段」）
    this.brokenAt = 0;            // 条件开始不成立的时刻
    this.sessionStartAt = 0;
    this.currentMs = 0;           // 当前这一段已累计的「有效」时长
    this.totalMs = 0;             // 有效段累计
    this.bestMs = 0;
    this.sessions = [];
    this.checks = [];
    this.lastTMs = 0;
    this.lastGoodAt = 0;
    /**
     * 当前段内「实质性抖动」的次数 —— 断开超过 breakGraceMs 才 ++。
     * 宽限内的抖动不记（它本来就该被吃掉）；同一段内恢复后再断，会再 +1 而**不结束段**。
     *
     * 它有两个用处：
     *   1) 语音指导的判据 —— 正常收势只会断 1 次（收势那次），
     *      中途散过又接回来的会 ≥2 次；只报后者，不报「主动站起来」。
     *   2) 稳定性指标 —— 段内抖动越少说明保持得越稳，界面直接显示。
     */
    this._breakCount = 0;
    this._undershoots = 0;       // 已熬过宽限期之前的短抖动次数（只统计）
    this._lastMarkedBreakAt = 0; // 去重：同一次断开只记一次抖动
    this._graceSeen = false;     // 去重：同一次断开只记一次短抖动
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
    if (this.inSession) return this.brokenAt ? HOLD_STATE.PAUSED : HOLD_STATE.HOLDING;
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
   * 为什么必须显式：段只在「断开太久」或「超时」时自动结束。若学生一直保持到
   * 老师说停，那段始终处于进行中，不调这里就不会进入 totalMs，计时看起来像没记上。
   * 界面实时显示走 snapshot().liveMs，不需要等这次结账。
   *
   * @param {number} [tMs] 结束时刻，默认沿用最后一帧的时间
   * @param {string} [reason='finalize'] 结账原因。默认 'finalize' 表示**人主动叫停**
   *   （老师按停止 / 清零 / 关页面），这类不算不合格，语音指导不吭声；
   *   自检里「合成信号喂完了」补的结账要传 'auto'，它与自动结算同义 ——
   *   该报的「时间太短」「没保持住」都要照报。两者混用会让整类用例静音。
   */
  finalize(tMs, reason = 'finalize') {
    const at = tMs === undefined ? this.lastTMs : tMs;
    // 注意这里**不**补一次 _tick：结账发生在「老师说停 / 学生收势」的时刻，
    // 此刻的断开恰恰是最正常的那一次，把它记成抖动会污染稳定性指标，
    // 也会让 guideForHold 把一次好成绩误判成「没保持住」。
    if (this.inSession) this._endSession(at, reason);
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
      this._onGood(tMs, dt);
    } else {
      this._onBad(tMs);
    }
    // 两件事必须每帧都查，不能只在条件成立的那一帧查：
    // 「断开太久」与「单段超时」都发生在条件不成立的时候，
    // 只在「成立」分支里查，人一走开就永远等不到检查，段会挂到天荒地老。
    this._tick(tMs);

    this.lastTMs = tMs;
    return this._snapshot(before);
  }

  /** 条件成立的一帧 */
  _onGood(tMs, dt) {
    // 段的闸门只有一个：断开太久。断开没超时就一律接回原段 ——
    // 这正是「调整一下姿势不再清零」的关键，早先版本在这里 _endSession 了。
    if (this.inSession && this.brokenAt) {
      const gap = tMs - this.brokenAt;
      if (gap > this.cfg.sessionGapMs) {
        this._endSession(tMs, 'gap');       // 隔得太久，上一个回合结束
        this.candidateSince = tMs;          // 开新段要重新走 minHoldMs
        this.brokenAt = 0;
      } else {
        this.brokenAt = 0;                  // 段继续，累计接着往下加
        this._emit('resume', tMs, { gapMs: Math.round(gap) });
      }
    }

    if (!this.inSession) {
      if (!this.candidateSince) this.candidateSince = tMs;
      // 新段（或初次）才开始计时，必须先稳定 minHoldMs；
      // 已经进行中的段恢复时不走这道闸（见文件头 2)
      if (tMs - this.candidateSince >= this.cfg.minHoldMs) {
        this._startSession(this.candidateSince, tMs);
      }
    }

    if (this.inSession) {
      // 按帧累加，断开期间的帧根本走不到这里，所以不必额外扣减
      if (dt > 0) this.currentMs += dt;
      if (tMs - this.sessionStartAt > this.cfg.sessionTimeoutMs) {
        this._endSession(tMs, 'timeout');   // 挂太久了，强制结算
      }
    }
  }

  /** 条件不成立的一帧：只暂停累加，不结束段 */
  _onBad(tMs) {
    this.candidateSince = 0;                // 未确认的候选作废（要重新凑 minHoldMs）
    if (!this.inSession || this.brokenAt) return;
    this.brokenAt = tMs;
    this._undershoots = 0;                  // 新一次断开，短抖动计数归零
    this._graceSeen = false;
  }

  /**
   * 每帧检查「断开太久」与「单段超时」。
   * 单独成一个方法是因为两件事都可能发生在一帧里，且都要在条件不成立时也持续检查
   * —— 只在条件成立的那一帧查，人一旦走开就永远等不到检查，段会挂到天荒地老。
   */
  _tick(tMs) {
    if (!this.inSession) return;
    if (this.brokenAt) {
      const gap = tMs - this.brokenAt;
      if (gap > this.cfg.sessionGapMs) {
        this._endSession(tMs, 'gap');
        return;
      }
      // 抖动的记账点：熬过宽限期才算一次「实质性抖动」，且只记一次。
      // 宽限内的抖动不记账 —— 它本来就设计成被吃掉，只统计个数（undershoots）。
      if (gap > this.cfg.breakGraceMs) {
        if (this._lastMarkedBreakAt !== this.brokenAt) {
          this._lastMarkedBreakAt = this.brokenAt;
          this._breakCount++;
          this._emit('break', tMs, { afterMs: Math.round(gap), nth: this._breakCount });
        }
      } else if (!this._graceSeen) {
        this._graceSeen = true;              // 这一档只记一次，避免每帧 +1
        this._undershoots = (this._undershoots || 0) + 1;
      }
    }
    if (tMs - this.sessionStartAt > this.cfg.sessionTimeoutMs) {
      this._endSession(tMs, 'timeout');
    }
  }

  _startSession(startAt, tMs) {
    this.inSession = true;
    this.sessionStartAt = startAt;
    // 稳定期的时间补计：条件在 startAt 就成立了，只是到 tMs 才确认
    this.currentMs = Math.max(0, tMs - startAt);
    this.brokenAt = 0;
    this._breakCount = 0;
    this._lastMarkedBreakAt = 0;
    this._graceSeen = false;
    this._emit('start', tMs, { at: startAt, backfillMs: Math.round(this.currentMs) });
  }

  /** 结束当前段。ms 取实际累加值 —— 断开期间不计时，所以不能用 endAt - startAt */
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
      /** 段内实质性抖动次数（宽限期内的抖动不计）。正常收势为 1；中途散过又接回来的 ≥2 */
      breaks: this._breakCount,
      /** 整段占用的挂钟时间（含断开）。ms / spanMs 可以直接当「保持率」看 */
      spanMs: Math.round(tMs - this.sessionStartAt),
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
    this._lastMarkedBreakAt = 0;
    this._graceSeen = false;
    this._emit('end', tMs, { ms, valid, reason, breaks: s.breaks });
  }

  _snapshot(fromIndex) {
    return {
      events: this.events.slice(fromIndex),
      mode: 'hold',
      state: this.state,
      holding: this.inSession && !this.brokenAt,
      /** 段还在、只是暂时没保持住（界面显示「姿势散了，接回来继续算」） */
      paused: this.inSession && !!this.brokenAt,
      inSession: this.inSession,
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
      /**
       * 恢复窗口的进度。两个读数：
       *   graceMs / graceLimitMs   —— 宽限期还剩多少（停在「还在宽限」这一档）
       *   gapMs / gapLimitMs       —— 距「这一段作废」还有多久（宽限过后接着走）
       */
      graceMs: this.brokenAt ? Math.round(Math.min(this.cfg.breakGraceMs, this.lastTMs - this.brokenAt)) : 0,
      graceLimitMs: this.cfg.breakGraceMs,
      gapMs: this.brokenAt ? Math.round(this.lastTMs - this.brokenAt) : 0,
      gapLimitMs: this.cfg.sessionGapMs,
      /** 当前段内已记的实质性抖动次数 */
      breaks: this._breakCount,
      /** 本次段内被宽限期吃掉的短抖动次数（只统计，不影响时长） */
      undershoots: this._undershoots || 0,
      sessionTimeoutMs: this.cfg.sessionTimeoutMs,
      checks: this.checks,
    };
  }
}

export default HoldTracker;
