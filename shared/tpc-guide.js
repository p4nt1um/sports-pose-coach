/**
 * tpc-guide.js — 「语音指导」：把判定结果翻译成一句人话，并管好播报顺序
 *
 * 与「语音播报」的分工（这是本模块存在的理由）：
 *
 *   语音播报 = 报**结果**。每 5 次报个数字；计时段结束报「完成 N 秒」。
 *              数字本身不解释任何事，作用是给场上一个节奏感。
 *   语音指导 = 报**原因**。只在动作被判为不合格时出声，一句话说清错在哪。
 *              它是给学生的即时纠正，所以必须短、必须准、必须当下说出来。
 *
 * 两者会撞在同一时刻：第 5 次动作如果恰好不规范，数字和原因都想出声。
 * speechSynthesis 一次只能说一句 —— 若各自调 cancel()，后说的会把先说的
 * 掐断，用户两句话都只听见半截。所以两者**共用本模块的串行队列**，并约定：
 * 撞车时指导抢占计数（纠正晚一秒就过期；数字下一轮还会再报）。
 *
 * 「不合格」在本项目里有两类来源，两条路径都要覆盖：
 *   1) lastRep.reject —— 计数被拒（太快/停住/半程）。**数字根本不涨**，
 *      学生最想知道的就是为什么。旧版界面只在 count 变化时才刷新反馈，
 *      等于把这一类完全漏掉了；本模块以 lastRep 对象是否更换作为触发条件。
 *   2) lastRep.flags  —— 计数通过了但打了规范标记（guards / 停留过久）。
 *   计时类（hold）没有 reject，改用「段没达到 minSessionMs」与「段内抖动次数」。
 *
 * 文案层不认识关键点，也不认识 DOM：它只吃 lastRep / checks / session 这种纯数据，
 * 因此能在 node 里直接单测（tools/test-guide.mjs），不必等浏览器自检。
 */

/**
 * 计数被拒绝时的口语化原因。口径见 tpc-fsm.js 的 REJECT。
 * 写法要求：说"发生了什么"，不说"违反了第几条标准"—— 学生边喘气边听。
 */
export const REJECT_SPEAK = {
  too_fast: '太快了，不算',
  too_slow: '停太久了，不算',
  partial: '只做了一半',
  low_conf: '看不清',
};

/**
 * 把「给眼睛看」的 label 变成「给耳朵听」的短句。
 *
 * 之所以需要这一步：label 是写在界面上给人读的，习惯带括号补充
 * （「手臂未举过头顶（开合跳要求双手上举）」），TTS 会把括号内容一起念出来，
 * 又长又生硬。去掉括号后剩下的主干，恰好就是不合格的核心原因。
 *
 * 想覆盖这个规则时，在 exercises.json 的 guard / condition 上写 "speak" 字段，
 * 本模块优先用它 —— 老师改 JSON 就能改说法，不用碰代码。
 */
export function speakTextOf(label) {
  if (label == null) return '';
  const raw = String(label).trim();
  const cut = raw
    .replace(/（[^）]*）/g, '')      // 中文括号
    .replace(/\([^)]*\)/g, '')      // 半角括号
    .replace(/\s+/g, ' ')
    .trim();
  return cut || raw;                // 整个 label 就是一句括号说明时，原样保留
}

/**
 * 一次动作可能同时踩好几条，只报一条 —— 用户要的是「主要原因」，
 * 连报三条会变成一串听不完的念白。
 *
 * 排序规则：warn 优先于 info；同级看 samples（该标记持续了多少帧，
 * 持续越久说明越不是偶发）。samples 由 PhaseFsm 的 _repGuardMap 累积。
 */
export function pickGuardFlag(flags) {
  const list = (flags || []).filter((f) => f && f.label && f.speak !== false);
  if (!list.length) return null;
  const rank = (f) => (f.severity === 'info' ? 1 : 0);
  return list.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    return (b.samples || 0) - (a.samples || 0);
  })[0];
}

/**
 * 计数类：从一次完成的判定里取出「不合格的主要原因」。
 * @returns {{text:string, kind:string, reason:string}|null} null 表示这一次是合格的，不必出声
 */
export function guideTextOf(rep) {
  if (!rep) return null;

  // ① 被拒绝：压根没计数。优先级最高 —— 学生看着数字没动。
  if (rep.reject) {
    return {
      text: REJECT_SPEAK[rep.reject] || String(rep.reject),
      kind: 'reject',
      reason: rep.reject,
    };
  }

  // ② 记上了，但不标准（guards 标记 / 相位停留过久）
  const f = pickGuardFlag(rep.flags);
  if (!f) return null;
  return {
    text: typeof f.speak === 'string' ? f.speak : speakTextOf(f.label),
    kind: 'flag',
    reason: f.signal,
    severity: f.severity || 'warn',
    label: f.label,
  };
}

/**
 * 计时类：判断这一段是不是「不合格地结束了」。
 *
 * 这里要克制，不能每段结束都喊一句。难点在于：
 *   学生主动站起来结束  与  姿势散掉导致中断  在数据上是同一件事，
 * 无法靠状态本身分辨。这与「坐椅子站起来 vs 深蹲」是同一类问题 ——
 * 项目的做法是不假装能分辨，只报**确实能分辨**的那种：
 *   · 段的有效累计没到 minSessionMs → 明确不合格，播「时间太短，不算」
 *   · 段内抖动 ≥2 次                → 中途确实散过（正常收势只断 1 次），播原因
 *   其余情况不出声，把判断留给老师。
 *
 * 「抖动次数」的口径要注意（tpc-hold.js 改过一次，这里跟着变）：
 *   · 只有断开超过 breakGraceMs 才记一次抖动；宽限内的短抖（呼吸、关键点噪声）
 *     不记账 —— 它本来就是设计上要被吃掉的，算进去等于把噪声当错误报给学生。
 *   · 段不再因断开而结束，只在断开超过 sessionGapMs 或单段超时时结算；
 *     所以 breaks 是「整段里散了几次」，不是「结束了几个段」。
 *
 * @param {object} session  HoldTracker 的分段记录（含 valid / reason / breaks）
 * @param {object[]} checks 结束那一帧的条件判定（用来指出是哪一条没成立）
 */
export function guideForHold(session, checks) {
  if (!session) return null;
  // 老师主动叫停 / 清零 / 切动作触发的结账不是不合格。
  // 注意 reason 的取值由调用方传：'finalize' = 人叫停（不报），
  // 'auto' = 合成信号喂完或自动结算（照报）—— 两者混用会让整类用例静音。
  if (session.reason === 'finalize') return null;

  if (!session.valid) {
    return { text: '时间太短，不算', kind: 'hold_short', reason: 'too_short' };
  }

  if ((session.breaks || 0) < 2) return null;   // 正常结束，不打扰

  const bad = (checks || []).filter((c) => c && !c.ok && c.speak !== false);
  if (!bad.length) return { text: '没保持住', kind: 'hold_break', reason: 'break' };
  const c = bad[0];
  return {
    text: '没保持住，' + (typeof c.speak === 'string' ? c.speak : speakTextOf(c.label)),
    kind: 'hold_break',
    reason: c.signal,
    label: c.label,
  };
}

/**
 * 串行播报器。
 *
 * 它解决三个真实问题：
 *
 *  1) **抢话**。speechSynthesis 同时只能说一句。两个功能各调各的，
 *     后说的 cancel 掉先说的 → 两句话都只剩半截。
 *     这里只有一个队列，同一时刻只有一条在播。
 *  2) **念白过长**。学生连做 8 个错动作，会把 8 句纠正排成一长串念完，
 *     那时人早就换动作了。待播槽**只留一条**，新消息直接替换旧的
 *     （纠正讲的是"此刻"，过期就该丢）。
 *  3) **碎碎念**。同一句原因（「上身前倾过大」）在 5 秒内重复报没有信息量。
 *     按句冷却，不同原因各有各的额度、互不遮挡。
 *
 * 所有副作用（发声 / 打断）都靠注入，因此可以在 node 里完整单测。
 */
export class GuideSpeaker {
  /**
   * @param {object} opts
   * @param {(text:string, onEnd:Function)=>void} opts.say 真正发声。必须保证回调 onEnd（成功或失败都算）
   * @param {()=>void} [opts.cancel] 打断当前发声
   * @param {number}  [opts.cooldownMs=5000] 同一句话的重复冷却
   * @param {()=>number} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    this.say = opts.say || ((text, done) => done());
    this.cancel = opts.cancel || (() => {});
    this.cooldownMs = opts.cooldownMs == null ? 5000 : opts.cooldownMs;
    this.now = opts.now || (() => Date.now());

    this.speaking = null;    // 正在播的文本（null = 空闲）
    this.current = null;     // 正在播的整条记录（含 priority）
    this.pending = null;     // 待播槽，只有一条
    this.lastText = '';
    this.lastAt = -Infinity;
    /** 实际播出去过的句子。自检与排查读它 —— 它记录的是"决定播什么"，与是否真的出声无关 */
    this.history = [];
    this.blocked = 0;        // 被冷却挡掉的次数
  }

  /**
   * 唯一的对外入口。
   * @param {string} text
   * @param {object} [opts] { priority: 1 计数播报 / 2 语音指导, atMs, kind }
   * @returns {boolean} 是否被接受（false = 冷却期内重复，或空文本）
   */
  speak(text, opts = {}) {
    if (!text) return false;
    const s = String(text);
    const at = opts.atMs == null ? this.now() : opts.atMs;
    const pri = opts.priority == null ? 1 : opts.priority;

    if (s === this.lastText && at - this.lastAt < this.cooldownMs) {
      this.blocked++;
      return false;
    }

    // 抢占：纠正必须比「计数播报」先出声。只抢优先级更低的，
    // 同级不互相打断 —— 两条纠正掐来掐去，最后哪条都听不清。
    if (this.current && pri > this.current.priority) {
      this._interruptCurrent();
    }

    return this._enqueue(s, pri, at, opts.kind || '');
  }

  _enqueue(text, priority, at, kind) {
    const item = { text, priority, at, kind };
    if (!this.speaking) { this._play(item); return true; }
    // 正在播：进待播槽。同级或更高就替换掉旧的（新的更贴近当下）
    if (!this.pending || priority >= this.pending.priority) this.pending = item;
    return true;
  }

  _interruptCurrent() {
    try { this.cancel(); } catch (e) { /* 发声失败不该影响计数 */ }
    // cancel 之后旧 utterance 的回调可能不再触发，这里必须自己把槽位放掉，
    // 否则队列会永久卡住 —— 症状是"勾了开关却再也不出声"。
    this.current = null;
    this.speaking = null;
  }

  _play(item) {
    this.current = item;
    this.speaking = item.text;
    this.lastText = item.text;
    this.lastAt = item.at;
    this.history.push({ text: item.text, at: item.at, kind: item.kind, priority: item.priority });
    if (this.history.length > 80) this.history.shift();

    const done = () => {
      if (this.speaking !== item.text) return;   // 已被打断或已释放，防重复回调
      this.current = null;
      this.speaking = null;
      const nx = this.pending;
      this.pending = null;
      if (nx) this._play(nx);
    };
    try { this.say(item.text, done); } catch (e) { done(); }
  }

  /** 当前是否有话在说 / 在排队（界面可用它显示"正在语音指导"） */
  get busy() { return !!(this.speaking || this.pending); }

  /** 清空队列与去重状态。清零、切换动作、离开页面时调 */
  reset() {
    this._interruptCurrent();
    this.pending = null;
    this.lastText = '';
    this.lastAt = -Infinity;
    this.blocked = 0;
    this.history.length = 0;
  }
}

export default GuideSpeaker;
