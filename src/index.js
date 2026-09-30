// Entry point: launch the local rehearsal backend and review UI.
//
// Everything here is local. The simulator is synthetic and cannot reach
// Landmark. No model calls are made.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { startServer } from './server.js';

export const DEMO_REQUEST = `Highlands Corned Beef 150g x2
Pasta Roma Fusilli 500g x2`;

// Pre-existing simulated cart used by the demo. It deliberately contains a
// matching unit (add one), a different configuration (preserved), an excess
// (reduction needs approval), and unrelated contents (preserved).
export const DEMO_CART = {
  'hl-beef-150g': 1,
  'hl-beef-260g': 1,
  'pr-fusilli-500g': 3,
  'mccormick-seasoning-200g': 1,
};

export async function main() {
  const dataDir = path.resolve(process.env.REHEARSAL_DATA_DIR ?? '.local');
  const port = Number(process.env.PORT ?? 4180);
  const stepDelayMs = Number(process.env.REHEARSAL_STEP_DELAY_MS ?? 250);

  const store = createStore({ dataDir, stepDelayMs });
  store.load();
  if (!store.simulator.exists()) store.simulator.seedCart(DEMO_CART);

  const { url } = await startServer(store, { port });
  console.log(`SIMULATION — synthetic catalogue and cart; this build cannot reach Landmark.`);
  console.log(`Local review UI: ${url}`);
  console.log(`Data directory:  ${dataDir}`);
  return { store, url };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
