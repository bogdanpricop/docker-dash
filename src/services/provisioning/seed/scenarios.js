'use strict';

// v8.17.0 (Onboarding — Phase 3) — scenario overlays.
//
// A scenario is a THIN bias layer on top of a profile: the profile decides HOW
// MANY rows, the scenario decides WHAT STORY they tell. Any scenario runs at any
// profile; the pairing below is a recommendation, not a lock
// (plans/onboarding-mockdata.md §5.3).

const SCENARIOS = Object.freeze({
  // "Healthy small shop" — everything green. The happy path a prospect sees first.
  'healthy-shop': Object.freeze({
    key: 'healthy-shop',
    recommendedProfile: 'small',
    daemonMix: [['docker', 10]],
    connStates: [['ok', 20]],
    containerStates: [['running', 9], ['exited', 1]],
    postureBase: 92,            // score the trend hovers around
    postureDrift: -2,           // end-of-series delta
    criticalFindings: 0,
    highFindings: 0,
    blueprintDrift: false,
    unhealthyContainers: 0,
    firewallExternalRatio: 0.2, // fraction of rules sourced from TEST-NET
  }),

  // "Busy estate" — the flagship demo: there IS work to do and the tool surfaces it.
  'busy-estate': Object.freeze({
    key: 'busy-estate',
    recommendedProfile: 'medium',
    daemonMix: [['docker', 6], ['podman', 2], ['incus', 1]],
    connStates: [['ok', 12], ['unreachable', 2], ['auth_failed', 1]],
    containerStates: [['running', 7], ['exited', 2], ['created', 1]],
    postureBase: 74,
    postureDrift: -14,          // the dip that exposes the critical finding
    criticalFindings: 1,
    highFindings: 2,
    blueprintDrift: true,
    unhealthyContainers: 3,
    firewallExternalRatio: 0.45,
  }),

  // "Multi-daemon plant" — scale + heterogeneity + RBAC segmentation.
  'multi-daemon-plant': Object.freeze({
    key: 'multi-daemon-plant',
    recommendedProfile: 'large',
    daemonMix: [['docker', 8], ['podman', 4], ['incus', 3], ['proxmox', 3], ['kubernetes', 2]],
    connStates: [['ok', 16], ['unreachable', 2], ['error', 1]],
    containerStates: [['running', 8], ['exited', 1], ['paused', 1]],
    postureBase: 81,
    postureDrift: 6,            // improving estate
    criticalFindings: 0,
    highFindings: 3,
    blueprintDrift: true,
    unhealthyContainers: 2,
    firewallExternalRatio: 0.35,
  }),
});

const SCENARIO_KEYS = Object.freeze(Object.keys(SCENARIOS));

/** Resolve a scenario key to its frozen overlay; throws on an unknown key. */
function getScenario(key) {
  const s = SCENARIOS[key];
  if (!s) throw new Error(`unknown seed scenario ${JSON.stringify(key)} (expected ${SCENARIO_KEYS.join('|')})`);
  return s;
}

/** Catalog shape for the wizard's scenario picker (no DB access). */
function listScenarios() {
  return SCENARIO_KEYS.map((k) => ({
    key: k,
    recommendedProfile: SCENARIOS[k].recommendedProfile,
  }));
}

module.exports = { SCENARIOS, SCENARIO_KEYS, getScenario, listScenarios };
