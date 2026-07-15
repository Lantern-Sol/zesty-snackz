#!/usr/bin/env node
'use strict';

/**
 * Figma asset watcher.
 *
 * Watches the `figma/` folder (created if missing) at the repo root. Whenever a
 * new source file lands, it is converted with ffmpeg and the result is written
 * to `figma/converted/`:
 *
 *   - images (png, jpg, gif, ...)  ->  .webp
 *   - videos (mov, mp4, mkv, ...)  ->  .webm  (VP9 + Opus)
 *
 * Originals are left in place (non-destructive). Existing, up-to-date outputs
 * are skipped so the watcher can be restarted freely.
 *
 * Requires ffmpeg on PATH: `brew install ffmpeg`
 *
 * Exports `startWatcher()` so the `lanternsol` CLI can run it in-process
 * alongside `shopify theme dev`. Run standalone with `npm run figma:watch`.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let chokidar;
try {
  chokidar = require('chokidar');
} catch (err) {
  console.error(
    '[figma] Missing dependency "chokidar". Run `npm install` first.'
  );
  throw err;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const FIGMA_DIR = path.join(REPO_ROOT, 'figma');
const CONVERTED_DIR = path.join(FIGMA_DIR, 'converted');

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif',
]);
const VIDEO_EXTS = new Set([
  '.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.flv', '.mpeg', '.mpg', '.webm',
]);

function log(msg) {
  console.log(`[figma] ${msg}`);
}

function hasBinary(bin, versionFlag = '-version') {
  const res = spawnSync(bin, [versionFlag], { stdio: 'ignore' });
  return res.status === 0;
}

function ensureDirs() {
  fs.mkdirSync(CONVERTED_DIR, { recursive: true });
}

/** Decide the target format for a given source file, or null to skip it. */
function targetFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, path.extname(filePath));
  if (IMAGE_EXTS.has(ext)) {
    return { kind: 'image', out: path.join(CONVERTED_DIR, `${base}.webp`) };
  }
  if (VIDEO_EXTS.has(ext)) {
    return { kind: 'video', out: path.join(CONVERTED_DIR, `${base}.webm`) };
  }
  return null;
}

/** Skip conversion when a fresh output already exists. */
function isUpToDate(src, out) {
  try {
    const srcStat = fs.statSync(src);
    const outStat = fs.statSync(out);
    return outStat.mtimeMs >= srcStat.mtimeMs;
  } catch {
    return false;
  }
}

const WEBP_QUALITY = '80';

/**
 * Build the conversion command for a source file.
 *   - GIF   -> gif2webp (preserves animation)
 *   - image -> cwebp
 *   - video -> ffmpeg (VP9 + Opus WebM)
 * Homebrew's ffmpeg bottle ships without a webp encoder, so images go through
 * libwebp's own tools instead.
 */
function buildCommand(kind, src, out) {
  const ext = path.extname(src).toLowerCase();
  if (kind === 'image') {
    if (ext === '.gif') {
      return { bin: 'gif2webp', args: ['-q', WEBP_QUALITY, src, '-o', out] };
    }
    return { bin: 'cwebp', args: ['-q', WEBP_QUALITY, src, '-o', out] };
  }
  // Video -> WebM (VP9 video, Opus audio). `-deadline good -cpu-used 2`
  // trades a little quality for reasonable encode speed on a dev machine.
  return {
    bin: 'ffmpeg',
    args: [
      '-y', '-i', src,
      '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0',
      '-deadline', 'good', '-cpu-used', '2',
      '-c:a', 'libopus', '-b:a', '128k',
      out,
    ],
  };
}

// Serialize conversions so multiple drops don't spawn a swarm of ffmpeg procs.
let queue = Promise.resolve();
const inFlight = new Set();

// Watcher lifecycle. chokidar fires every existing-file 'add' during the
// initial scan (before 'ready'); we process those quietly so a re-launch
// doesn't bury the Shopify output under a wall of skip lines.
let ready = false;
let scanSkipped = 0;
let scanPending = 0;

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function enqueue(src) {
  const target = targetFor(src);
  if (!target) return; // unsupported type — ignore silently
  if (inFlight.has(src)) return;

  if (!ready) {
    // Initial scan of files already on disk: stay quiet. Skip anything that's
    // already converted; only queue (and later log) the ones needing work.
    if (isUpToDate(src, target.out)) {
      scanSkipped += 1;
      return;
    }
    scanPending += 1;
  } else {
    log(`detected  ${path.relative(FIGMA_DIR, src)}`);
  }

  inFlight.add(src);
  queue = queue.then(() => convert(src, target)).finally(() => inFlight.delete(src));
}

function convert(src, target) {
  return new Promise((resolve) => {
    const rel = path.relative(FIGMA_DIR, src);
    const outRel = path.relative(FIGMA_DIR, target.out);

    if (isUpToDate(src, target.out)) {
      // Live re-adds of an already-converted file are rare; the initial scan
      // handles existing files silently, so only report skips once live.
      if (ready) log(`skip (already converted): ${rel}`);
      return resolve();
    }

    log(`converting ${rel} → ${outRel}  (${target.kind})…`);
    const { bin, args } = buildCommand(target.kind, src, target.out);
    const child = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        let savings = '';
        try {
          const inBytes = fs.statSync(src).size;
          const outBytes = fs.statSync(target.out).size;
          const pct = inBytes > 0 ? Math.round((1 - outBytes / inBytes) * 100) : 0;
          savings = `  (${humanSize(inBytes)} → ${humanSize(outBytes)}, ${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)`;
        } catch {
          /* size reporting is best-effort */
        }
        log(`✓ done  ${outRel}${savings}`);
      } else {
        log(`FAILED (${code}): ${rel}`);
        // Surface the tail of ffmpeg's output to help diagnose.
        const tail = stderr.trim().split('\n').slice(-4).join('\n');
        if (tail) console.error(tail);
        // Remove a partial/corrupt output so a retry re-converts cleanly.
        fs.rmSync(target.out, { force: true });
      }
      resolve();
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        log(`missing tool "${bin}" for ${rel}. Install with: brew install ffmpeg webp`);
      } else {
        log(`${bin} error on ${rel}: ${err.message}`);
      }
      resolve();
    });
  });
}

/**
 * Start watching. Returns a handle with `.close()` for graceful shutdown.
 */
function startWatcher() {
  const missing = [];
  if (!hasBinary('ffmpeg')) missing.push('ffmpeg (video → webm)');
  if (!hasBinary('cwebp', '-version')) missing.push('webp (image → webp)');
  if (missing.length) {
    log(`missing tools: ${missing.join(', ')}`);
    log('Install them with: brew install ffmpeg webp');
    log('Watcher will still run, but affected conversions will be skipped.');
  }

  ready = false;
  scanSkipped = 0;
  scanPending = 0;

  ensureDirs();
  log(`watching ${path.relative(REPO_ROOT, FIGMA_DIR) || 'figma'}/ (drop files here)`);

  const watcher = chokidar.watch(FIGMA_DIR, {
    ignoreInitial: false, // convert anything already sitting in figma/ on startup
    depth: 0, // only the top level of figma/, not converted/ or nested dirs
    ignored: CONVERTED_DIR,
    awaitWriteFinish: {
      // Wait for large files to finish copying before touching them.
      stabilityThreshold: 1500,
      pollInterval: 200,
    },
  });

  watcher
    .on('add', (filePath) => enqueue(filePath))
    .on('change', (filePath) => enqueue(filePath))
    .on('ready', () => {
      ready = true;
      const parts = [];
      if (scanSkipped) parts.push(`${scanSkipped} already converted`);
      if (scanPending) parts.push(`${scanPending} to convert`);
      const summary = parts.length ? parts.join(', ') : 'no existing assets';
      log(`ready — ${summary}. Watching for new files…`);
    })
    .on('error', (err) => log(`watcher error: ${err.message}`));

  return watcher;
}

module.exports = { startWatcher };

// Allow standalone execution: `node scripts/figma-watch.js`
if (require.main === module) {
  const watcher = startWatcher();
  const shutdown = () => {
    log('shutting down watcher…');
    watcher.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
