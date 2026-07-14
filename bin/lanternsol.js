#!/usr/bin/env node
'use strict';

/**
 * `lanternsol` CLI.
 *
 *   lanternsol theme dev [...flags]   Run the figma asset watcher AND
 *                                     `shopify theme dev` together. Ctrl+C stops
 *                                     both; if `shopify theme dev` exits, the
 *                                     watcher tears down and we exit with its
 *                                     code.
 *
 *   lanternsol <anything else>        Transparent passthrough to `shopify`.
 *                                     e.g. `lanternsol theme push`.
 *
 * Install once per machine from the repo root:
 *   npm install && npm link
 */

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

function runShopify(passthroughArgs, { onExit } = {}) {
  const child = spawn('shopify', passthroughArgs, { stdio: 'inherit' });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(
        '[lanternsol] `shopify` CLI not found. Install it: https://shopify.dev/docs/storefronts/themes/tools/cli'
      );
    } else {
      console.error(`[lanternsol] failed to launch shopify: ${err.message}`);
    }
    process.exit(1);
  });
  if (onExit) child.on('close', onExit);
  return child;
}

// `theme dev` -> combined watcher + shopify theme dev
const isThemeDev = args[0] === 'theme' && args[1] === 'dev';

if (isThemeDev) {
  const { startWatcher } = require(path.join(__dirname, '..', 'scripts', 'figma-watch.js'));

  const watcher = startWatcher();
  let shuttingDown = false;

  const shopify = runShopify(args, {
    onExit: (code) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('[lanternsol] shopify theme dev exited — stopping watcher.');
      watcher.close().finally(() => process.exit(code == null ? 0 : code));
    },
  });

  // Forward interrupts to the shopify child; its exit handler cleans up.
  const forward = (signal) => () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[lanternsol] received ${signal}, shutting down…`);
    watcher.close();
    if (!shopify.killed) shopify.kill(signal);
    // Fallback in case shopify ignores the signal.
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
} else {
  // Transparent passthrough to shopify for every other command.
  runShopify(args, { onExit: (code) => process.exit(code == null ? 0 : code) });
}
