'use strict';

/**
 * ESXi Version Knowledge Base — v8.9.12-alpha.1
 *
 * Ported verbatim from the SOS ESXi Monitor (esxi-version-db.ts). Curated,
 * OFFLINE database of ESXi versions, builds, EOL dates and known critical
 * CVEs. No network calls. Needs periodic MANUAL updates when Broadcom ships
 * new patches / advisories.
 *
 * Sources:
 *   - VMware Build Numbers: https://knowledge.broadcom.com/external/article?legacyId=2143832
 *   - VMware Security Advisories: https://www.vmware.com/security/advisories.html
 *   - VMware Lifecycle Matrix: https://lifecycle.vmware.com/
 *
 * Last updated: 2026-03-16 (source vintage — refresh when new ESXi patches ship).
 */

const ESXI_VERSIONS = [
  {
    version: '8.0', latestBuild: '24585300', latestPatch: 'ESXi 8.0 Update 3b',
    latestPatchDate: '2025-03-04', generalAvailability: '2022-10-11',
    endOfGeneralSupport: '2027-10-11', endOfTechnicalGuidance: '2029-10-11', isEndOfLife: false,
  },
  {
    version: '7.0', latestBuild: '24322402', latestPatch: 'ESXi 7.0 Update 3r',
    latestPatchDate: '2025-01-16', generalAvailability: '2020-04-02',
    endOfGeneralSupport: '2025-04-02', endOfTechnicalGuidance: '2027-04-02', isEndOfLife: false,
  },
  {
    version: '6.7', latestBuild: '22509723', latestPatch: 'ESXi 6.7 U3s',
    latestPatchDate: '2024-03-29', generalAvailability: '2018-04-17',
    endOfGeneralSupport: '2022-10-15', endOfTechnicalGuidance: '2025-11-15', isEndOfLife: true,
  },
  {
    version: '6.5', latestBuild: '22348808', latestPatch: 'ESXi 6.5 U3s',
    latestPatchDate: '2024-03-29', generalAvailability: '2016-11-15',
    endOfGeneralSupport: '2022-10-15', endOfTechnicalGuidance: '2025-11-15', isEndOfLife: true,
  },
  {
    version: '6.0', latestBuild: '18828794', latestPatch: 'ESXi 6.0 U3p',
    latestPatchDate: '2022-01-27', generalAvailability: '2015-03-12',
    endOfGeneralSupport: '2020-03-12', endOfTechnicalGuidance: '2022-03-12', isEndOfLife: true,
  },
];

const ESXI_CRITICAL_CVES = [
  {
    id: 'CVE-2024-37085', severity: 'HIGH', cvssScore: 7.2,
    title: 'Active Directory Integration Authentication Bypass',
    affectedVersions: ['7.0', '8.0'], fixedInPatch: 'ESXi 8.0 Update 3',
    publishedDate: '2024-06-25', advisory: 'VMSA-2024-0013',
    description: 'Allows AD group manipulation to gain full admin access to ESXi. Actively exploited in the wild by ransomware groups.',
  },
  {
    id: 'CVE-2024-22273', severity: 'HIGH', cvssScore: 8.1,
    title: 'Storage Controller Out-of-Bounds Read/Write',
    affectedVersions: ['7.0', '8.0'], fixedInPatch: 'ESXi 8.0 Update 2c',
    publishedDate: '2024-06-25', advisory: 'VMSA-2024-0013',
    description: 'Out-of-bounds read/write vulnerability in the storage controllers could lead to code execution.',
  },
  {
    id: 'CVE-2024-22254', severity: 'HIGH', cvssScore: 7.9,
    title: 'ESXi Out-of-Bounds Write',
    affectedVersions: ['7.0', '8.0'], fixedInPatch: 'ESXi 8.0 Update 2b',
    publishedDate: '2024-03-05', advisory: 'VMSA-2024-0006',
    description: 'Out-of-bounds write vulnerability leading to escape from the sandbox.',
  },
  {
    id: 'CVE-2024-22252', severity: 'CRITICAL', cvssScore: 9.3,
    title: 'XHCI USB Controller Use-After-Free',
    affectedVersions: ['6.5', '6.7', '7.0', '8.0'], fixedInPatch: 'ESXi 8.0 Update 2b',
    publishedDate: '2024-03-05', advisory: 'VMSA-2024-0006',
    description: 'Use-after-free in XHCI USB controller. A malicious actor with local admin privileges on a VM may exploit to execute code on the host.',
  },
  {
    id: 'CVE-2023-20867', severity: 'HIGH', cvssScore: 7.5,
    title: 'VMware Tools Authentication Bypass',
    affectedVersions: ['6.5', '6.7', '7.0', '8.0'], fixedInPatch: 'VMware Tools 12.2.5',
    publishedDate: '2023-06-13', advisory: 'VMSA-2023-0013',
    description: 'A fully compromised ESXi host can force VMware Tools to fail to authenticate host-to-guest operations. Exploited by UNC3886 (Chinese APT).',
  },
  {
    id: 'CVE-2022-31696', severity: 'HIGH', cvssScore: 8.8,
    title: 'ESXi Heap Out-of-Bounds Write in Network',
    affectedVersions: ['6.5', '6.7', '7.0'], fixedInPatch: 'ESXi 7.0 Update 3i',
    publishedDate: '2022-12-13', advisory: 'VMSA-2022-0030',
    description: 'Heap out-of-bounds write vulnerability in the network stack. Could lead to code execution.',
  },
  {
    id: 'CVE-2021-21974', severity: 'HIGH', cvssScore: 8.8,
    title: 'ESXi OpenSLP Heap Overflow (ESXiArgs ransomware)',
    affectedVersions: ['6.5', '6.7', '7.0'], fixedInPatch: 'ESXi 7.0 Update 3c',
    publishedDate: '2021-02-23', advisory: 'VMSA-2021-0002',
    description: 'OpenSLP heap overflow. Massively exploited by ESXiArgs ransomware campaign in February 2023.',
  },
];

/**
 * Resolve an installed version+build against the knowledge base.
 * @param {string} esxiVersion e.g. "6.7.0"
 * @param {string} buildNumber e.g. "22509723"
 */
function checkVersion(esxiVersion, buildNumber) {
  const majorVersion = String(esxiVersion || '').split('.').slice(0, 2).join('.');
  const versionInfo = ESXI_VERSIONS.find(v => majorVersion.startsWith(v.version));
  const applicableCVEs = ESXI_CRITICAL_CVES
    .filter(cve => cve.affectedVersions.some(v => majorVersion.startsWith(v)))
    .sort((a, b) => b.cvssScore - a.cvssScore);
  const now = new Date();
  const recommendations = [];

  if (!versionInfo) {
    return {
      installedVersion: esxiVersion, installedBuild: buildNumber,
      latestPatch: 'Unknown', latestBuild: 'Unknown', latestPatchDate: '',
      isUpToDate: false, endOfGeneralSupport: 'Unknown', endOfTechnicalGuidance: 'Unknown',
      isEndOfLife: true, isEndOfSupportSoon: false, daysUntilEndOfSupport: null,
      applicableCVEs,
      criticalCVECount: applicableCVEs.filter(c => c.severity === 'CRITICAL').length,
      highCVECount: applicableCVEs.filter(c => c.severity === 'HIGH').length,
      recommendations: ['This ESXi version is not recognized. Consider upgrading to a supported version.'],
    };
  }

  const isUpToDate = String(buildNumber) === versionInfo.latestBuild;
  const endOfSupportDate = new Date(versionInfo.endOfGeneralSupport);
  const daysUntilEndOfSupport = Math.ceil((endOfSupportDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const isEndOfSupportSoon = daysUntilEndOfSupport > 0 && daysUntilEndOfSupport <= 180;

  if (versionInfo.isEndOfLife) {
    recommendations.push(`ESXi ${versionInfo.version} is End of Life. Upgrade to ESXi 8.0 for continued security updates.`);
  } else if (isEndOfSupportSoon) {
    recommendations.push(`General support ends in ${daysUntilEndOfSupport} days (${versionInfo.endOfGeneralSupport}). Plan your upgrade.`);
  }
  if (!isUpToDate) {
    recommendations.push(`Update to ${versionInfo.latestPatch} (build ${versionInfo.latestBuild}) released ${versionInfo.latestPatchDate}.`);
  }
  if (applicableCVEs.filter(c => c.severity === 'CRITICAL').length > 0) {
    recommendations.push('Critical CVEs affect this version. Patch immediately or apply mitigations.');
  }
  if (recommendations.length === 0) {
    recommendations.push('This host is running the latest patch and is fully supported.');
  }

  return {
    installedVersion: esxiVersion, installedBuild: buildNumber,
    latestPatch: versionInfo.latestPatch, latestBuild: versionInfo.latestBuild,
    latestPatchDate: versionInfo.latestPatchDate, isUpToDate,
    endOfGeneralSupport: versionInfo.endOfGeneralSupport,
    endOfTechnicalGuidance: versionInfo.endOfTechnicalGuidance,
    isEndOfLife: versionInfo.isEndOfLife, isEndOfSupportSoon,
    daysUntilEndOfSupport: daysUntilEndOfSupport > 0 ? daysUntilEndOfSupport : 0,
    applicableCVEs,
    criticalCVECount: applicableCVEs.filter(c => c.severity === 'CRITICAL').length,
    highCVECount: applicableCVEs.filter(c => c.severity === 'HIGH').length,
    recommendations,
  };
}

module.exports = { ESXI_VERSIONS, ESXI_CRITICAL_CVES, checkVersion };
