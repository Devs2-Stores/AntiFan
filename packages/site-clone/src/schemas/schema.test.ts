import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Schemas - JSON Schema Validation & Integrity', () => {
  it('1. clone-spec.schema.json is valid and contains required StorefrontStateContract', () => {
    const schemaPath = path.resolve('packages/site-clone/src/schemas/clone-spec.schema.json');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    assert.strictEqual(schema.title, 'HaravanCloneSpec');
    assert.ok(schema.required.includes('metadata'));
    assert.ok(schema.required.includes('themeSettings'));
    assert.ok(schema.required.includes('sections'));
    assert.ok(schema.required.includes('assets'));
    assert.ok(schema.required.includes('stateContract'));

    const stateContract = schema.properties.stateContract;
    assert.ok(stateContract.properties.interactiveWidgets, 'Must require interactiveWidgets');
  });

  it('2. qa-matrix.schema.json defines all 8 dimensions and 3 viewports', () => {
    const schemaPath = path.resolve('packages/site-clone/src/schemas/qa-matrix.schema.json');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    assert.strictEqual(schema.title, 'HaravanQAMatrix');
    const requiredDims = schema.properties.dimensions.required;
    assert.strictEqual(requiredDims.length, 8);
    assert.ok(requiredDims.includes('visualFidelity'));
    assert.ok(requiredDims.includes('domSemantics'));
    assert.ok(requiredDims.includes('cssModularity'));
    assert.ok(requiredDims.includes('interactiveOperability'));
    assert.ok(requiredDims.includes('haravanCompliance'));
    assert.ok(requiredDims.includes('assetIntegrity'));
    assert.ok(requiredDims.includes('responsiveParity'));
    assert.ok(requiredDims.includes('performanceCWV'));

    const requiredViewports = schema.properties.viewports.required;
    assert.ok(requiredViewports.includes('desktop'));
    assert.ok(requiredViewports.includes('tablet'));
    assert.ok(requiredViewports.includes('mobile'));
  });

  it('3. clone-ir.schema.json validates ComponentContractIR and its core invariants', () => {
    const schemaPath = path.resolve('packages/site-clone/src/schemas/clone-ir.schema.json');
    assert.ok(fs.existsSync(schemaPath), 'clone-ir.schema.json must exist');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

    assert.strictEqual(schema.title, 'AntiFan ComponentContractIR');
    assert.ok(schema.required.includes('version'));
    assert.ok(schema.required.includes('metadata'));
    assert.ok(schema.required.includes('layout'));
    assert.ok(schema.required.includes('themeSettings'));
    assert.ok(schema.required.includes('sections'));
    assert.ok(schema.required.includes('storefrontRuntime'));

    const layout = schema.properties.layout;
    assert.ok(layout.required.includes('containerMaxWidth'));
    assert.ok(layout.required.includes('breakpoints'));
  });
});
