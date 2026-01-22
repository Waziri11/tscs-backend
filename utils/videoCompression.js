const fs = require('fs');
const { spawn } = require('child_process');

const MB = 1024 * 1024;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} failed (${code}): ${err}`));
    });
  });
}

async function getDurationSeconds(filePath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const { out } = await run('ffprobe', args);
  const duration = Number(out.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration from ffprobe');
  return duration;
}

function pickProfile(durationSec) {
  if (durationSec > 60 * 60) return { width: 426, fps: 10, audioKbps: 16 };
  if (durationSec > 20 * 60) return { width: 640, fps: 12, audioKbps: 24 };
  return { width: 854, fps: 15, audioKbps: 32 };
}

function computeBitrates(maxBytes, durationSec, audioKbps) {
  const safeBits = maxBytes * 8 * 0.95;
  const totalBps = Math.floor(safeBits / durationSec);
  const audioBps = audioKbps * 1000;
  const videoBps = Math.max(totalBps - audioBps, 15000);
  return { totalBps, audioBps, videoBps };
}

async function encodeOnce({ inputPath, outputPath, width, fps, videoBps, audioKbps, preset }) {
  const args = [
    '-y',
    '-i', inputPath,
    '-vf', `scale='min(${width},iw)':-2,fps=${fps}`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-b:v', `${videoBps}`,
    '-maxrate', `${videoBps}`,
    '-bufsize', `${videoBps}`,
    '-c:a', 'aac',
    '-b:a', `${audioKbps}k`,
    '-ac', '1',
    '-movflags', '+faststart',
    outputPath
  ];
  await run('ffmpeg', args);
}

async function compressToMaxMb({ inputPath, outputPath, maxMb }) {
  const maxBytes = maxMb * MB;
  const inputStats = fs.statSync(inputPath);
  if (inputStats.size <= maxBytes) {
    fs.copyFileSync(inputPath, outputPath);
    return { compressedBytes: inputStats.size, note: 'Already under cap; copied original.' };
  }

  const durationSec = await getDurationSeconds(inputPath);
  let profile = pickProfile(durationSec);
  let { videoBps } = computeBitrates(maxBytes, durationSec, profile.audioKbps);

  await encodeOnce({
    inputPath,
    outputPath,
    width: profile.width,
    fps: profile.fps,
    videoBps,
    audioKbps: profile.audioKbps,
    preset: 'veryfast'
  });

  let outSize = fs.statSync(outputPath).size;
  if (outSize <= maxBytes) return { compressedBytes: outSize, durationSec };

  const fallbackPath = outputPath.replace(/\.mp4$/, '.fallback.mp4');
  profile = { width: 426, fps: 10, audioKbps: 16 };
  ({ videoBps } = computeBitrates(maxBytes, durationSec, profile.audioKbps));

  await encodeOnce({
    inputPath,
    outputPath: fallbackPath,
    width: profile.width,
    fps: profile.fps,
    videoBps: Math.max(Math.floor(videoBps * 0.85), 10000),
    audioKbps: profile.audioKbps,
    preset: 'veryfast'
  });

  const fallbackSize = fs.statSync(fallbackPath).size;
  fs.renameSync(fallbackPath, outputPath);

  return {
    compressedBytes: fallbackSize,
    durationSec,
    warning: fallbackSize > maxBytes ? 'Still above cap; used most aggressive profile.' : null
  };
}

module.exports = {
  compressToMaxMb,
  getDurationSeconds
};
