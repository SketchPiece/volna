import test from 'node:test';
import assert from 'node:assert/strict';
import { schema } from './extractor.ts';

test('the memory schema is valid for strict Structured Outputs: anyOf instead of oneOf, closed objects', () => {
  const json = JSON.stringify(schema());
  assert.doesNotMatch(json, /"oneOf"/, 'OpenAI strict mode rejects oneOf with 400 invalid_json_schema');
  const items = (schema() as any).properties.operations.items;
  assert.equal(items.anyOf.length, 5);
  assert.doesNotMatch(json, /"default"/, 'strict mode does not know default');
  for (const branch of items.anyOf) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual([...branch.required].sort(), Object.keys(branch.properties).sort(), 'strict mode needs every field required');
  }
});
