'use strict';
const page = require('../../public/js/pages/provider-security-posture');
describe('provider security posture page', () => { it('labels coverage as declared evidence', () => { const html = page._coverageHtml({ coverage: { declaredFeatureCount: 3, states: { supported: 1, conditional: 1, unsupported: 1 } } }); expect(html).toContain('Declared SDK contract evidence'); expect(html).toContain('unsupported'); }); });
