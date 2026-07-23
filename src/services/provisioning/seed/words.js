'use strict';

// v8.17.0 (Onboarding — Phase 3) — embedded fake dictionaries for the generator.
//
// Curated so NO value can collide with a real person, company, host or reachable
// address (plans/onboarding-mockdata.md §1.3, onboarding-security.md §3):
//   * org names are brand-neutral fictional compounds (Contoso/Northwind style)
//   * person names are common-but-generic; emails always land on `*.example`
//   * city names are placeholder/fictional
//   * images are generic OSS infra images with PINNED tags (determinism)
// The generator NEVER reads a real table to derive a value — that is the
// "masked-real data" trap these lists exist to avoid.

// ── organisations ───────────────────────────────────────────────────────────
const ORG_PREFIXES = [
  'Northwind', 'Contoso', 'Fabrikam', 'Umbra', 'Meadowlark', 'Irongate', 'Blueharbor',
  'Stonebridge', 'Larkfield', 'Westmoor', 'Copperline', 'Elmgrove', 'Thornbury',
  'Silverbeck', 'Greenfell', 'Havenrock', 'Brightwell', 'Ashford', 'Kingsmere', 'Ravenswood',
];
const ORG_SUFFIXES = [
  'Logistics', 'Robotics', 'Foods', 'Labels', 'Systems', 'Industries', 'Packaging',
  'Analytics', 'Components', 'Works', 'Manufacturing', 'Networks', 'Materials', 'Group',
];

// ── people (locale-partitioned; emails are always @<slug>.example) ───────────
const FIRST_NAMES = {
  en: ['Ava', 'Noah', 'Mia', 'Liam', 'Ella', 'Owen', 'Iris', 'Felix', 'Nora', 'Hugo',
    'Clara', 'Milo', 'Rosa', 'Otto', 'June', 'Silas', 'Elsie', 'Arlo', 'Vera', 'Rowan'],
  ro: ['Andrei', 'Ioana', 'Mihai', 'Elena', 'Radu', 'Ana', 'Vlad', 'Maria', 'Sorin', 'Dana',
    'Cristian', 'Alina', 'Bogdan', 'Irina', 'Tudor', 'Carmen', 'Stefan', 'Ruxandra', 'Paul', 'Otilia'],
};
const LAST_NAMES = {
  en: ['Fielding', 'Marsh', 'Waverly', 'Quill', 'Hollis', 'Brambleton', 'Ashby', 'Penrose',
    'Larkin', 'Redmond', 'Sable', 'Thistle', 'Vance', 'Wren', 'Yardley', 'Bexley'],
  ro: ['Popescu', 'Ionescu', 'Radulescu', 'Marin', 'Dobre', 'Stan', 'Barbu', 'Cristea',
    'Neagu', 'Sandu', 'Voicu', 'Toma', 'Lungu', 'Serban', 'Enache', 'Dumitrescu'],
};
const CITIES = {
  en: ['Springfield', 'Fairview', 'Riverton', 'Oakhurst', 'Northbrook', 'Westhaven',
    'Kingsport', 'Millbrook', 'Ashwood', 'Pinecrest'],
  ro: ['Valea Mare', 'Campuri', 'Dealul Nou', 'Rausor', 'Poiana Verde', 'Vadul Vechi',
    'Ograda', 'Fantanele', 'Sat Nou', 'Podul Lung'],
};

// ── infrastructure vocabulary ───────────────────────────────────────────────
const HOST_ROLES = ['edge', 'core', 'db', 'build', 'dmz', 'plant-a', 'plant-b', 'gw', 'app', 'cache'];

const SERVICE_STACKS = [
  'erp', 'wms', 'mes', 'checkout', 'warehouse-api', 'label-printer', 'edge-gw',
  'telemetry', 'billing', 'portal', 'scheduler', 'reporting',
];

const SERVICE_NAMES = [
  'api', 'worker', 'web', 'db', 'cache', 'queue', 'gateway', 'scheduler',
  'exporter', 'proxy', 'sync', 'ingest',
];

// Pinned tags: an unpinned `:latest` would make the dataset non-reproducible
// in spirit even though the string is stable.
const IMAGES = [
  'nginx:1.25', 'postgres:16', 'redis:7', 'grafana/grafana:11', 'traefik:3',
  'rabbitmq:3.13', 'mariadb:11', 'node:22-alpine', 'python:3.12-slim', 'golang:1.22-alpine',
  'prom/prometheus:v2.53', 'influxdb:2.7', 'minio/minio:RELEASE.2024-06-13T22-53-53Z',
  'mosquitto:2.0', 'nats:2.10', 'vault:1.16',
];

const HOST_GROUP_NAMES = ['Core', 'Edge', 'Plant A', 'Plant B', 'DMZ', 'Build farm'];
const TEAM_NAMES = ['Platform', 'Plant A Ops', 'Plant B Ops', 'Security', 'Data', 'On-call'];
const CONTAINER_GROUP_NAMES = ['Critical path', 'Batch jobs', 'Observability', 'Edge services', 'Databases', 'Internal tools'];

// Posture finding templates — titles/severities shaped like the live posture
// checks so the demo's posture page reads as authentic.
const POSTURE_CHECKS = [
  { id: 'docker-socket-exposed', severity: 'critical', title: 'Docker socket mounted into a container' },
  { id: 'privileged-container', severity: 'high', title: 'Container running in privileged mode' },
  { id: 'root-user', severity: 'high', title: 'Container process runs as root' },
  { id: 'no-healthcheck', severity: 'medium', title: 'Container has no HEALTHCHECK' },
  { id: 'host-network', severity: 'medium', title: 'Container attached to the host network' },
  { id: 'latest-tag', severity: 'low', title: 'Image pinned to a floating tag' },
  { id: 'no-restart-policy', severity: 'low', title: 'No restart policy configured' },
  { id: 'unbounded-memory', severity: 'medium', title: 'No memory limit set' },
];

const FIREWALL_REASONS = [
  'Allow monitoring scrape', 'Block stale partner range', 'Allow internal API mesh',
  'Restrict database to app tier', 'Allow VPN management access', 'Block outbound to legacy DC',
];

// ── locale defaults (drive the nomenclature seed) ───────────────────────────
const LOCALE_DEFAULTS = {
  en: { currency: 'USD', unitSystem: 'metric', dateFormat: 'YYYY-MM-DD', firstDayOfWeek: 1 },
  'en-US': { currency: 'USD', unitSystem: 'imperial', dateFormat: 'MM/DD/YYYY', firstDayOfWeek: 0 },
  'en-GB': { currency: 'GBP', unitSystem: 'metric', dateFormat: 'DD/MM/YYYY', firstDayOfWeek: 1 },
  ro: { currency: 'RON', unitSystem: 'metric', dateFormat: 'DD.MM.YYYY', firstDayOfWeek: 1 },
  'ro-RO': { currency: 'RON', unitSystem: 'metric', dateFormat: 'DD.MM.YYYY', firstDayOfWeek: 1 },
};

/** The word pool for a locale, falling back to `en` for anything unknown. */
function poolFor(locale) {
  const base = String(locale || 'en').toLowerCase();
  const short = base.split('-')[0];
  const key = FIRST_NAMES[base] ? base : (FIRST_NAMES[short] ? short : 'en');
  return {
    firstNames: FIRST_NAMES[key],
    lastNames: LAST_NAMES[key],
    cities: CITIES[key],
    defaults: LOCALE_DEFAULTS[base] || LOCALE_DEFAULTS[short] || LOCALE_DEFAULTS.en,
  };
}

/** Slugify a generated label into a `[a-z0-9-]` token (never from user input). */
function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'demo';
}

module.exports = {
  ORG_PREFIXES, ORG_SUFFIXES, FIRST_NAMES, LAST_NAMES, CITIES,
  HOST_ROLES, SERVICE_STACKS, SERVICE_NAMES, IMAGES,
  HOST_GROUP_NAMES, TEAM_NAMES, CONTAINER_GROUP_NAMES,
  POSTURE_CHECKS, FIREWALL_REASONS, LOCALE_DEFAULTS,
  poolFor, slugify,
};
