/**
 * tpc-draw.js — 骨架叠加绘制
 *
 * 两个容易翻车的点，这里都处理了：
 *  1) letterbox 偏移。视频若用 object-fit: contain，画面两侧会有黑边，
 *     关键点是按视频帧归一化的，直接 x*canvasWidth 画会整体错位。
 *  2) 背景不可控。学生穿深色衣服、背后是白墙都会吃掉单色线条，
 *     因此每根线都是「深色粗描边 + 亮色细线」两遍绘制。
 */

import { SKELETON, LM_LABELS_CN } from './tpc-landmarks.js';

const GHOST = 'rgba(6, 16, 32, 0.75)';

/** 按可见度给颜色：绿=可信，黄=勉强，红=不可信 */
export function visibilityColor(v) {
  const x = v == null ? 1 : v;
  if (x >= 0.75) return '#22D3EE';
  if (x >= 0.5) return '#FBBF24';
  return '#F87171';
}

/**
 * 计算视频在 canvas 上的实际显示区域（对应 object-fit: contain）。
 * @returns {{ox,oy,dw,dh,cw,ch,dpr}}
 */
export function computeLayout(canvas, video) {
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { ox: (cw - dw) / 2, oy: (ch - dh) / 2, dw, dh, cw, ch };
}

/** 把画布像素尺寸对齐到显示尺寸与设备像素比 */
export function resizeCanvas(canvas, video) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return computeLayout(canvas, video);
}

/** 归一化坐标 → 画布像素坐标 */
export function toPx(lm, layout, mirrored) {
  const x = mirrored ? 1 - lm.x : lm.x;
  return {
    x: layout.ox + x * layout.dw,
    y: layout.oy + lm.y * layout.dh,
    v: lm.visibility == null ? 1 : lm.visibility,
  };
}

/**
 * 绘制所有检测到的人。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} poses   已平滑的 pose 数组（含 landmarks）
 * @param {object} layout computeLayout 的结果
 * @param {object} opts   { mirrored, minVisibility, lineWidth, pointRadius,
 *                          showPoints, showAngles, showIndex, showLabels, angles }
 *                          angles: [{ at, value, label }] 由调用方算好传入
 */
export function drawPoses(ctx, poses, layout, opts = {}) {
  const o = {
    mirrored: true,
    minVisibility: 0.3,
    lineWidth: 3,
    pointRadius: 4,
    showPoints: true,
    showAngles: true,
    showIndex: false,
    showLabels: false,
    angles: [],
    ...opts,
  };

  ctx.clearRect(0, 0, layout.cw, layout.ch);
  if (!poses || !poses.length) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  poses.forEach((pose, pi) => {
    const lm = pose.landmarks;
    if (!lm || !lm.length) return;

    // 第一遍：深色描边
    ctx.strokeStyle = GHOST;
    ctx.lineWidth = o.lineWidth + 3;
    for (const [a, b] of SKELETON) {
      if (!lm[a] || !lm[b]) continue;
      if (Math.min(lm[a].visibility ?? 1, lm[b].visibility ?? 1) < o.minVisibility) continue;
      const p1 = toPx(lm[a], layout, o.mirrored);
      const p2 = toPx(lm[b], layout, o.mirrored);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // 第二遍：按可见度着色的亮线（逐段取两端可见度的较小值）
    ctx.lineWidth = o.lineWidth;
    for (const [a, b] of SKELETON) {
      if (!lm[a] || !lm[b]) continue;
      const va = lm[a].visibility ?? 1;
      const vb = lm[b].visibility ?? 1;
      const v = Math.min(va, vb);
      if (v < o.minVisibility) continue;
      const p1 = toPx(lm[a], layout, o.mirrored);
      const p2 = toPx(lm[b], layout, o.mirrored);
      ctx.strokeStyle = visibilityColor(v);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // 关键点
    if (o.showPoints) {
      for (let i = 0; i < lm.length; i++) {
        const v = lm[i].visibility ?? 1;
        if (v < o.minVisibility) continue;
        const p = toPx(lm[i], layout, o.mirrored);
        ctx.beginPath();
        ctx.arc(p.x, p.y, o.pointRadius, 0, Math.PI * 2);
        ctx.fillStyle = GHOST;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, o.pointRadius - 1.5, 0, Math.PI * 2);
        ctx.fillStyle = visibilityColor(v);
        ctx.fill();
      }
    }

    // 关键点编号（校对索引用，默认关）
    if (o.showIndex) {
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < lm.length; i++) {
        if ((lm[i].visibility ?? 1) < o.minVisibility) continue;
        const p = toPx(lm[i], layout, o.mirrored);
        ctx.fillStyle = 'rgba(6,16,32,0.8)';
        ctx.beginPath();
        ctx.arc(p.x, p.y + 0.01, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#E2F4FF';
        ctx.fillText(String(i), p.x, p.y);
      }
    }

    // 关键点名称
    if (o.showLabels) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < lm.length; i++) {
        if ((lm[i].visibility ?? 1) < 0.6) continue;
        const p = toPx(lm[i], layout, o.mirrored);
        const text = i + ' ' + (LM_LABELS_CN[i] || '');
        ctx.fillStyle = 'rgba(6,16,32,0.75)';
        ctx.fillRect(p.x + 7, p.y - 8, ctx.measureText(text).width + 8, 16);
        ctx.fillStyle = '#E2F4FF';
        ctx.fillText(text, p.x + 11, p.y + 0.5);
      }
    }

    // 关节角度标注
    if (o.showAngles && o.angles && o.angles.length) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const ang of o.angles) {
        if (ang.at == null || ang.value == null) continue;
        const p = toPx(ang.at, layout, o.mirrored);
        const text = (ang.label ? ang.label + ' ' : '') + Math.round(ang.value) + '\u00B0';
        const w = ctx.measureText(text).width + 14;
        ctx.fillStyle = 'rgba(6, 16, 32, 0.82)';
        ctx.beginPath();
        const rx = p.x - w / 2;
        const ry = p.y - 30;
        ctx.roundRect ? ctx.roundRect(rx, ry, w, 22, 6) : ctx.rect(rx, ry, w, 22);
        ctx.fill();
        ctx.fillStyle = '#7DF9FF';
        ctx.fillText(text, p.x, ry + 11.5);
      }
    }

    // 多人序号
    if (o.showIndex || poses.length > 1) {
      const valid = lm.filter((p) => (p.visibility ?? 1) >= o.minVisibility);
      if (valid.length) {
        let minX = Infinity, minY = Infinity;
        for (const p of valid) {
          const px = toPx(p, layout, o.mirrored);
          if (px.x < minX) minX = px.x;
          if (px.y < minY) minY = px.y;
        }
        const tag = '#' + (pi + 1);
        ctx.font = '600 14px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(tag).width + 16;
        ctx.fillStyle = 'rgba(6, 16, 32, 0.85)';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(minX - 8, minY - 34, w, 24, 6) : ctx.rect(minX - 8, minY - 34, w, 24);
        ctx.fill();
        ctx.fillStyle = '#7DF9FF';
        ctx.fillText(tag, minX, minY - 22);
      }
    }
  });
}
