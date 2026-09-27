/**
 * tpc-core.js — MediaPipe Pose Landmarker 引擎封装
 *
 * 职责边界：只负责「拿到关键点」。不认识深蹲、不知道什么叫计数。
 *   - 模型与 WASM 加载（含 GPU → CPU 自动回落）
 *   - 固定节拍的推理循环（与渲染帧率解耦）
 *   - 关键点平滑、FPS 与延迟统计
 *   - 出错不中断循环，只计数并回调
 *
 * 时长统计口径：inferenceMs 是 detectForVideo 的同步耗时，
 * 不含平滑与绘制 —— 排查性能问题时必须能分清是哪一段慢。
 */

import { PoseFilter } from './tpc-filter.js';

export const MODEL_PATHS = {
  lite: 'models/pose_landmarker_lite.task',
  full: 'models/pose_landmarker_full.task',
};

export const MODEL_LABELS = {
  lite: 'Lite（快，多人用）',
  full: 'Full（准，单人用）',
};

/** 滑动窗口计量器：给 FPS 和延迟用，比累计平均更能反映当前状态 */
export class RateMeter {
  constructor(size = 60) {
    this.size = size;
    this.buf = [];
  }
  push(v) {
    if (!isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  get count() { return this.buf.length; }
  get mean() {
    if (!this.buf.length) return 0;
    let s = 0;
    for (const v of this.buf) s += v;
    return s / this.buf.length;
  }
  get max() {
    if (!this.buf.length) return 0;
    return Math.max.apply(null, this.buf);
  }
  /** 95 分位：比最大值稳健，比均值敏感，用来发现偶发卡顿 */
  get p95() {
    if (!this.buf.length) return 0;
    const s = this.buf.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }
  reset() { this.buf = []; }
}

export const EngineState = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  RUNNING: 'running',
  ERROR: 'error',
};

export class PoseEngine {
  /**
   * @param {object} opts
   * @param {string}  opts.vendorBase   资源根路径，默认 '/vendor/'
   * @param {'lite'|'full'} opts.model  模型档位
   * @param {number}  opts.numPoses     最大检测人数
   * @param {'auto'|'GPU'|'CPU'} opts.delegate
   * @param {number}  opts.targetFps    推理节拍上限，0 表示不限制
   * @param {boolean} opts.smoothing    是否启用关键点平滑
   * @param {function} opts.onFrame     每帧回调
   * @param {function} opts.onState     状态变化回调
   * @param {function} opts.onError     错误回调
   */
  constructor(opts = {}) {
    this.opts = {
      vendorBase: '/vendor/',
      model: 'full',
      numPoses: 1,
      delegate: 'auto',
      targetFps: 30,
      smoothing: true,
      minDetectionConfidence: 0.5,
      minPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      ...opts,
    };

    this.state = EngineState.IDLE;
    this.delegateInUse = null;
    this.landmarker = null;
    this.video = null;
    this.running = false;
    this._raf = null;
    this._lastVideoTime = -1;
    this._lastInferAt = 0;
    this._tickCount = 0;

    this.filter = new PoseFilter({ enabled: this.opts.smoothing });

    this.stats = {
      fps: new RateMeter(60),
      inferenceMs: new RateMeter(60),
      totalFrames: 0,
      droppedFrames: 0,
      errorCount: 0,
      poseCount: 0,
      lastError: null,
    };
  }

  _setState(s) {
    this.state = s;
    if (this.opts.onState) this.opts.onState(s, this);
  }

  _fail(err) {
    this.stats.errorCount++;
    this.stats.lastError = String(err && err.message ? err.message : err);
    if (this.opts.onError) this.opts.onError(err, this);
  }

  /** 加载 WASM 运行时与模型。可重复调用以切换模型。 */
  async load() {
    this._setState(EngineState.LOADING);
    const base = this.opts.vendorBase;
    try {
      const mod = await import(/* @vite-ignore */ base + 'mediapipe/vision_bundle.mjs');
      const V = mod && mod.default ? mod.default : mod;
      const FilesetResolver = V.FilesetResolver || (mod && mod.FilesetResolver);
      const PoseLandmarker = V.PoseLandmarker || (mod && mod.PoseLandmarker);
      if (!FilesetResolver || !PoseLandmarker) {
        throw new Error('vision_bundle 未导出 FilesetResolver / PoseLandmarker，可能是版本不兼容');
      }

      const fileset = await FilesetResolver.forVisionTasks(base + 'mediapipe/wasm');
      const modelRel = MODEL_PATHS[this.opts.model] || MODEL_PATHS.full;

      const wanted = this.opts.delegate === 'auto' ? ['GPU', 'CPU'] : [this.opts.delegate];
      let lastErr = null;
      for (const dev of wanted) {
        try {
          this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: base + modelRel,
              delegate: dev,
            },
            runningMode: 'VIDEO',
            numPoses: this.opts.numPoses,
            minPoseDetectionConfidence: this.opts.minDetectionConfidence,
            minPosePresenceConfidence: this.opts.minPresenceConfidence,
            minTrackingConfidence: this.opts.minTrackingConfidence,
            outputSegmentationMasks: false,
          });
          this.delegateInUse = dev;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          this.landmarker = null;
        }
      }
      if (!this.landmarker) {
        throw lastErr || new Error('模型加载失败（GPU 与 CPU 均不可用）');
      }

      this.filter.reset();
      this._setState(EngineState.READY);
      return { delegate: this.delegateInUse, model: this.opts.model };
    } catch (err) {
      this._setState(EngineState.ERROR);
      this._fail(err);
      throw err;
    }
  }

  /** 开始推理循环 */
  start(videoEl) {
    if (!this.landmarker) throw new Error('请先 load()');
    this.video = videoEl;
    if (this.running) return;
    this.running = true;
    this.filter.reset();
    this._lastVideoTime = -1;
    this._lastInferAt = 0;
    this.stats.fps.reset();
    this.stats.inferenceMs.reset();
    this._setState(EngineState.RUNNING);
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this.state === EngineState.RUNNING) this._setState(EngineState.READY);
  }

  /** 释放 wasm 与模型资源 */
  close() {
    this.stop();
    if (this.landmarker && typeof this.landmarker.close === 'function') {
      try { this.landmarker.close(); } catch (e) { /* 释放失败不影响主流程 */ }
    }
    this.landmarker = null;
    this._setState(EngineState.IDLE);
  }

  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(() => this._loop());

    const v = this.video;
    if (!v || v.readyState < 2) return;

    // 同一帧视频只推理一次；否则会在视频 fps 低于渲染 fps 时重复计算
    if (v.currentTime === this._lastVideoTime) return;

    const now = performance.now();
    if (this.opts.targetFps > 0) {
      const minGap = 1000 / this.opts.targetFps - 1; // -1ms 容差，避免刚好卡在边界被跳过
      if (now - this._lastInferAt < minGap) {
        this.stats.droppedFrames++;
        return;
      }
    }

    this._lastVideoTime = v.currentTime;
    this._lastInferAt = now;

    const t0 = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(v, now);
    } catch (err) {
      this._fail(err);
      return;
    }
    const inferenceMs = performance.now() - t0;

    this.stats.totalFrames++;
    this.stats.inferenceMs.push(inferenceMs);
    if (this._tickCount > 0) {
      const gap = performance.now() - (this._prevTickAt || now);
      if (gap > 0) this.stats.fps.push(1000 / gap);
    }
    this._prevTickAt = performance.now();
    this._tickCount++;

    const rawPoses = [];
    const lms = result && result.landmarks ? result.landmarks : [];
    const wlms = result && result.worldLandmarks ? result.worldLandmarks : [];
    for (let i = 0; i < lms.length; i++) {
      rawPoses.push({ landmarks: lms[i], worldLandmarks: wlms[i] || null });
    }
    this.stats.poseCount = rawPoses.length;

    const ts = now;
    const poses = rawPoses.map((p) => this.filter.filter(p, ts));

    if (this.opts.onFrame) {
      try {
        this.opts.onFrame({
          poses,
          rawPoses,
          timestampMs: ts,
          inferenceMs,
          fps: this.stats.fps.mean,
        });
      } catch (err) {
        this._fail(err);
      }
    }
  }
}

/** 摄像头封装：统一处理就绪等待与停止 */
export class CameraSource {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
  }

  async start(constraints = {}) {
    const c = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: 'user',
        ...(constraints.video || {}),
      },
      audio: false,
      ...constraints,
    };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前环境不支持摄像头（需要 https 或 localhost）');
    }
    this.stream = await navigator.mediaDevices.getUserMedia(c);
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    await this._waitForFrames();
    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      track: this.stream.getVideoTracks()[0],
    };
  }

  /** 等到真的出画为止：play() 返回时 videoWidth 可能还是 0 */
  _waitForFrames(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const check = () => {
        if (this.video.videoWidth > 0 && this.video.readyState >= 2) return resolve();
        if (performance.now() - t0 > timeoutMs) return reject(new Error('摄像头已打开但无画面'));
        requestAnimationFrame(check);
      };
      check();
    });
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}
