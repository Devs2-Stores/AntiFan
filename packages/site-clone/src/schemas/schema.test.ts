import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
const schemasDir = path.resolve(__dirname, '../../src/schemas');

describe('Schemas - JSON Schema Validation & Integrity', () => {
  it('1. clone-spec.schema.json is valid and contains required StorefrontStateContract', () => {
    const schemaPath = path.join(schemasDir, 'clone-spec.schema.json');
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
    const schemaPath = path.join(schemasDir, 'qa-matrix.schema.json');
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
    const schemaPath = path.join(schemasDir, 'clone-ir.schema.json');
    assert.ok(fs.existsSync(schemaPath), 'clone-ir.schema.json must exist');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    assert.strictEqual(schema.title, 'AntiFan ComponentContractIR');
    assert.ok(schema.required.includes('version'));
    assert.ok(schema.required.includes('metadata'));
    assert.ok(schema.required.includes('layout'));
    assert.ok(schema.required.includes('themeSettings'));
    assert.ok(schema.required.includes('sections'));
    assert.ok(schema.required.includes('storefrontRuntime'));

    // Dual-version support
    assert.deepStrictEqual(schema.properties.version.enum, ['1.0.0', '1.1.0']);

    // Assets and responsive first-class references
    assert.strictEqual(schema.properties.assets['$ref'], '#/definitions/HarvestedAssetManifest');
    assert.strictEqual(schema.properties.responsive['$ref'], '#/definitions/ResponsiveBreakpointConfig');

    // Controller sectionId & roleId
    const controllerProps = schema.properties.storefrontRuntime.properties.controllers.items.properties;
    assert.ok(controllerProps.sectionId, 'Must define sectionId');
    assert.ok(controllerProps.roleId, 'Must define roleId');

    // Definitions validation
    assert.ok(schema.definitions.HarvestedAssetManifest, 'Must define HarvestedAssetManifest');
    assert.ok(schema.definitions.ResponsiveBreakpointConfig, 'Must define ResponsiveBreakpointConfig');
    assert.ok(schema.definitions.NormalizedProduct, 'Must define NormalizedProduct');
    assert.ok(schema.definitions.NormalizedCategory, 'Must define NormalizedCategory');

    const layout = schema.properties.layout;
    assert.ok(layout.required.includes('containerMaxWidth'));
    assert.ok(layout.required.includes('breakpoints'));
  });
});
