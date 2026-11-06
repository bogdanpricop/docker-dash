'use strict';

// The application validates these constraints after decoding. Keep the wire
// schema within the subset shared by the two structured-output APIs.
function cloudSchema(schema, requireAll = false) {
  const output = { ...schema };
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum']) delete output[key];
  if (output.type === 'object') {
    const properties = Object.entries(schema.properties || {});
    output.additionalProperties = false;
    output.properties = Object.fromEntries(properties.map(([key, value]) => {
      const child = cloudSchema(value, requireAll);
      return [key, requireAll && !schema.required?.includes(key) ? { anyOf: [child, { type: 'null' }] } : child];
    }));
    if (requireAll) output.required = Object.keys(output.properties);
  }
  if (schema.items) output.items = cloudSchema(schema.items, requireAll);
  return output;
}

module.exports = cloudSchema;
