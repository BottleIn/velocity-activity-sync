import { DEFAULT_CONFIG } from '../../portal/lib/config.js';
import { EVIDENCE_COMPLETED, buildSnapshot } from '../../portal/lib/snapshot.js';
import { makePortal } from './portal-builder.js';

export const MONTH_TO_ROUND = DEFAULT_CONFIG.monthToRound;
export const DONE = EVIDENCE_COMPLETED;

// 시험용 포털(makePortal)을 만들어 곧바로 buildSnapshot에 넣는다.
export function snapshotOf(specs, fileResults = {}, { monthToRound = MONTH_TO_ROUND, ...portalOptions } = {}) {
  const output = makePortal(specs, portalOptions);
  return buildSnapshot({ output, fileResults, monthToRound });
}

export function applicationOf(snapshot, foundId) {
  return snapshot.applications.find((application) => application.foundId === foundId);
}

export function warningsOf(snapshot, code) {
  return snapshot.warnings.filter((warning) => warning.code === code);
}
