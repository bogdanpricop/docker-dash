'use strict';
exports.up=db=>db.exec(`
 CREATE INDEX idx_service_token_tenant ON governance_service_tokens(tenant_id);
 UPDATE governance_service_tokens SET revoked_at=COALESCE(revoked_at,datetime('now'))
  WHERE tenant_id IN (SELECT id FROM tenants WHERE status!='active');
 CREATE TRIGGER revoke_service_tokens_on_tenant_suspend AFTER UPDATE OF status ON tenants WHEN NEW.status!='active'
 BEGIN
  UPDATE governance_service_tokens SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE tenant_id=NEW.id;
 END;
`);
exports.down=db=>db.exec(`
 DROP TRIGGER IF EXISTS revoke_service_tokens_on_tenant_suspend;
 DROP INDEX IF EXISTS idx_service_token_tenant;
`);
