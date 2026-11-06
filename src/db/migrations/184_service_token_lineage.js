'use strict';
exports.up=db=>db.exec(`
 ALTER TABLE governance_service_tokens ADD COLUMN workload_trust_id INTEGER REFERENCES governance_workload_identity_trusts(id) ON DELETE SET NULL;
 ALTER TABLE governance_service_tokens ADD COLUMN workload_expires_at TEXT;
 CREATE INDEX idx_service_token_workload_trust ON governance_service_tokens(workload_trust_id);
 CREATE INDEX idx_service_token_parent ON governance_service_tokens(rotated_from);
 -- Legacy tokens have no reliable trust/proof linkage. Never guess that linkage.
 WITH RECURSIVE derived(id) AS (
  SELECT id FROM governance_service_tokens WHERE issued_via='workload_exchange'
  UNION SELECT token.id FROM governance_service_tokens token JOIN derived ON token.rotated_from=derived.id
 ) UPDATE governance_service_tokens SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE id IN (SELECT id FROM derived);
 CREATE TRIGGER revoke_workload_tokens_on_trust_change AFTER UPDATE ON governance_workload_identity_trusts
 WHEN OLD.issuer IS NOT NEW.issuer OR OLD.audience IS NOT NEW.audience OR OLD.subject_pattern IS NOT NEW.subject_pattern
  OR OLD.identity_kind IS NOT NEW.identity_kind OR OLD.jwks_json IS NOT NEW.jwks_json OR OLD.scopes_json IS NOT NEW.scopes_json
  OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.enabled IS NOT NEW.enabled OR OLD.token_ttl_seconds IS NOT NEW.token_ttl_seconds
  OR OLD.max_assertion_ttl_seconds IS NOT NEW.max_assertion_ttl_seconds
 BEGIN
  UPDATE governance_service_tokens SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE workload_trust_id=OLD.id;
 END;
 CREATE TRIGGER revoke_workload_tokens_on_trust_delete BEFORE DELETE ON governance_workload_identity_trusts
 BEGIN
  UPDATE governance_service_tokens SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE workload_trust_id=OLD.id;
 END;
`);
exports.down=db=>db.exec(`
 DROP TRIGGER IF EXISTS revoke_workload_tokens_on_trust_change;
 DROP TRIGGER IF EXISTS revoke_workload_tokens_on_trust_delete;
 DROP INDEX IF EXISTS idx_service_token_workload_trust;
 DROP INDEX IF EXISTS idx_service_token_parent;
 ALTER TABLE governance_service_tokens DROP COLUMN workload_trust_id;
 ALTER TABLE governance_service_tokens DROP COLUMN workload_expires_at;
`);
