/**
 * facetrack.js
 * Skin-tone based face tracking using pure JavaScript (jimp).
 * Extracts frames from a video window, detects horizontal face position
 * via skin-tone center-of-mass, smooths the path with EMA, and returns
 * a dynamic FFmpeg crop-X expression for smooth camera panning.
 */

const { Jimp } = require('jimp');
const { exec }  = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs   = require('fs');

const execAsync = promisify(exec);

// ─── Skin Tone Detection ────────────────────────────────────────────────────

// Simple RGB skin-tone classifier (works well for lit faces)
function isSkinTone(r, g, b) {
  return (
    r > 95 && g > 40 && b > 20 &&
    r > g  && r > b  &&
    Math.max(r, g, b) - Math.min(r, g, b) > 15
  );
}

// Analyse one JPEG frame, return the horizontal center-of-mass fraction (0–1)
// or null if too few skin pixels are detected.
async function analyzeFrame(framePath) {
  try {
    const image  = await Jimp.read(framePath);
    const { data, width, height } = image.bitmap;

    let totalX = 0;
    let count  = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isSkinTone(r, g, b)) {
        const pixelIndex = i / 4;
        totalX += pixelIndex % width;
        count++;
      }
    }

    // Require at least 0.2% of pixels to be skin-tone (avoids false positives)
    if (count < (width * height) * 0.002) return null;
    return totalX / count / width; // fraction 0–1
  } catch {
    return null;
  }
}

// ─── Frame Extraction & Analysis ───────────────────────────────────────────

/**
 * Extracts 1 frame per second from [startSec, startSec+duration] at 240px wide,
 * detects the face fraction per second, applies EMA smoothing, and returns the
 * smoothed fractions array (one entry per second).
 */
async function getFaceTrackFractions(videoPath, startSec, duration, ffmpegBin) {
  const tmpDir = `/tmp/ftrack_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Extract 1 fps at small resolution for fast analysis
    await execAsync(
      `"${ffmpegBin}" -ss ${startSec} -i "${videoPath}" -t ${duration} -vf "fps=1,scale=240:-1" -q:v 3 "${tmpDir}/f%04d.jpg"`,
      { timeout: 90000 }
    );

    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.jpg'))
      .sort();

    // Analyse each frame
    const raw = [];
    for (const frame of frames) {
      raw.push(await analyzeFrame(path.join(tmpDir, frame)));
    }

    if (raw.length === 0) return null;

    // Forward-fill nulls
    let last = 0.5;
    const filled = raw.map(f => { if (f !== null) last = f; return last; });

    // Backward-fill any remaining 0.5 defaults at the start
    last = filled[filled.length - 1];
    for (let i = filled.length - 1; i >= 0; i--) {
      if (raw[i] !== null) last = raw[i];
      else filled[i] = last;
    }

    // Exponential moving average — α=0.3 gives smooth camera movement
    const alpha = 0.3;
    const smoothed = [...filled];
    for (let i = 1; i < smoothed.length; i++) {
      smoothed[i] = alpha * filled[i] + (1 - alpha) * smoothed[i - 1];
    }

    return smoothed;

  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      }
      fs.rmdirSync(tmpDir);
    } catch {}
  }
}

// ─── FFmpeg Crop Expression Builder ────────────────────────────────────────

/**
 * Given an array of horizontal face fractions (one per second), returns a
 * dynamic FFmpeg crop-X expression with linear interpolation between keyframes.
 * Uses FFmpeg's `iw` variable so it works regardless of scaled video width.
 * The result is clamped to [0, iw-1080].
 */
function buildCropXExpression(fractions) {
  if (!fractions || fractions.length === 0) {
    return 'max(0,min(iw-1080,iw/2-540))';
  }

  if (fractions.length === 1) {
    return `max(0,min(iw-1080,iw*${fractions[0].toFixed(4)}-540))`;
  }

  // Build nested ternary with per-second linear interpolation
  // Base case: use last keyframe for t >= last index
  let expr = `iw*${fractions[fractions.length - 1].toFixed(4)}-540`;

  for (let i = fractions.length - 2; i >= 0; i--) {
    const f0 = fractions[i].toFixed(4);
    const f1 = fractions[i + 1].toFixed(4);
    // Linear interpolation from second i to second i+1
    const interp = `(${f0}+(${f1}-${f0})*(t-${i}))`;
    expr = `if(lt(t,${i + 1}),iw*${interp}-540,${expr})`;
  }

  return `max(0,min(iw-1080,${expr}))`;
}

module.exports = { getFaceTrackFractions, buildCropXExpression };
