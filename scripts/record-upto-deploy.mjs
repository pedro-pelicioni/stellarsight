#!/usr/bin/env node
/**
 * scripts/record-upto-deploy.mjs — records the one-time testnet deploy+invoke of
 * contracts/upto (see deploy-testnet.sh) as docs/status/upto-settlement-deploy.json,
 * so scripts/soroban-upto-footprint.mjs has a txHash to measure without hand-editing
 * a JSON file — nothing in docs/status/ is ever hand-entered.
 *
 * Usage: node scripts/record-upto-deploy.mjs <contractId> <txHash> <token> <payer> <payTo>
 */
import { writeEvidence, updateProvenance } from './lib/evidence.mjs';

const [contractId, txHash, token, payer, payTo] = process.argv.slice(2);
if (!contractId || !txHash) {
  console.error('usage: record-upto-deploy.mjs <contractId> <txHash> <token> <payer> <payTo>');
  process.exit(2);
}

const { path } = writeEvidence('upto-settlement-deploy', {
  contractId,
  txHash,
  token,
  payer,
  payTo,
  explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
});
updateProvenance({ [txHash]: { label: 'setup', run: 'contracts/upto/deploy-testnet.sh' } });

console.log(`[record-upto-deploy] wrote ${path.replace(`${process.cwd()}/`, '')}`);
