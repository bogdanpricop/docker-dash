'use strict';

// v8.7.7 — Deployment Configurator recipe templates.
// Every recipe must render valid YAML for both default and custom options.
// These are the same templates the Tools-tab UI uses live and that
// scripts/generate-deployment-examples.js writes to disk under
// examples/deployments/ — so one source of truth, one set of guarantees.

const path = require('path');
const yaml = require('yaml');

const DC = require(path.join(__dirname, '../../public/js/components/deployment-configurator.js'));

const ALL_IDS = DC.RECIPES.map(r => r.id);

describe('DeploymentConfigurator recipes', () => {
  it('ships the expected 7 recipes', () => {
    expect(ALL_IDS).toEqual([
      'standalone', 'caddy', 'traefik', 'npm', 'swarm-traefik', 'ha', 'synology',
    ]);
  });

  describe.each(DC.RECIPES.map(r => [r.id, r]))('recipe %s', (id, recipe) => {
    it('renders valid YAML with defaults', () => {
      const out = DC._render(id);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(50);
      const doc = yaml.parse(out);
      expect(doc).toBeTruthy();
      expect(doc.services).toBeTruthy();
      expect(Object.keys(doc.services).length).toBeGreaterThan(0);
      // every service has an image
      for (const svc of Object.values(doc.services)) {
        expect(svc.image).toBeTruthy();
      }
    });

    it('renders valid YAML with custom user options', () => {
      const custom = {};
      for (const k of recipe.fields) {
        const def = recipe.defaults[k];
        custom[k] = typeof def === 'number' ? def + 1 : `custom-${k}-value`;
      }
      const out = DC._render(id, custom);
      const doc = yaml.parse(out);
      expect(doc.services).toBeTruthy();
    });

    it('always exposes the docker socket read-only', () => {
      const out = DC._render(id);
      expect(out).toMatch(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
    });

    it('uses unless-stopped restart policy (non-Swarm) or a Swarm restart_policy', () => {
      const out = DC._render(id);
      const usesCompose = /restart: unless-stopped/.test(out);
      const usesSwarm = /restart_policy:/.test(out);
      expect(usesCompose || usesSwarm).toBe(true);
    });
  });

  it('throws on unknown recipe id', () => {
    expect(() => DC._render('not-a-real-recipe')).toThrow(/Unknown recipe/);
  });

  it('caddy recipe substitutes domain + email into the inline Caddyfile', () => {
    const out = DC._render('caddy', { domain: 'dd.example.test', email: 'ops@example.test' });
    expect(out).toMatch(/dd\.example\.test \{/);
    expect(out).toMatch(/tls ops@example\.test/);
    expect(out).toMatch(/reverse_proxy docker-dash:8101/);
  });

  it('traefik recipe substitutes domain + network + certResolver into labels', () => {
    const out = DC._render('traefik', { domain: 'dd.example.test', network: 'web', certResolver: 'le' });
    expect(out).toMatch(/Host\(`dd\.example\.test`\)/);
    expect(out).toMatch(/tls\.certresolver=le/);
    // non-Swarm Traefik recipe declares the external network at the top level
    expect(yaml.parse(out).networks.web.external).toBe(true);
  });

  it('swarm-traefik recipe pins to manager role and includes traefik.docker.network', () => {
    const out = DC._render('swarm-traefik', { network: 'overlay-net' });
    expect(out).toMatch(/node\.role == manager/);
    expect(out).toMatch(/traefik\.docker\.network=overlay-net/);
    expect(out).toMatch(/^networks:[\s\S]+overlay-net:[\s\S]+external: true/m);
  });

  it('ha recipe creates redis + two replicas on distinct host ports', () => {
    const out = DC._render('ha', { port: 9000, redisPassword: 'strong-secret-xyz' });
    const doc = yaml.parse(out);
    expect(doc.services['dd-redis']).toBeTruthy();
    expect(doc.services['dd-1']).toBeTruthy();
    expect(doc.services['dd-2']).toBeTruthy();
    expect(out).toMatch(/DD_MODE=ha/);
    expect(out).toMatch(/9000:8101/);
    expect(out).toMatch(/9001:8101/); // dd-2 on port+1
    expect(out).toMatch(/strong-secret-xyz/);
  });

  it('synology recipe uses bind mount under the configured stack path', () => {
    const out = DC._render('synology', { stackPath: '/volume2/apps/dd' });
    expect(out).toMatch(/\/volume2\/apps\/dd\/data:\/data/);
  });

  it('standalone recipe is the smallest (single service, named volume)', () => {
    const out = DC._render('standalone');
    const doc = yaml.parse(out);
    expect(Object.keys(doc.services)).toEqual(['docker-dash']);
    expect(Object.keys(doc.volumes || {})).toEqual(['docker-dash-data']);
  });
});
