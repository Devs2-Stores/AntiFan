import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HsGateRules } from '../../src/main/qa/rules/hs-gate-rules';
import { EcommercePlatform } from '../../src/main/qa/scanners/platform-detector';

test('static HS engine: deleteAddress reference without inline handler is a warning, never a gate flip', () => {
  const html = `<a href="/account/addresses/1" onclick="deleteAddress('1')">Delete</a>`;
  const result = HsGateRules.evaluateHtml(html, 'sapo' as EcommercePlatform);
  const hs04 = result.violations.find((item) => item.ruleId === 'HS-04');
  assert.ok(hs04, 'expected an HS-04 violation');
  assert.equal(hs04.severity, 'warning', 'static scan cannot prove handler absence, so it must not be error');
  assert.equal(result.passed, true, 'a warning must not flip the gate to failed');
  assert.equal(result.errorsCount, 0);
});

test('static HS engine: inline deleteAddress handler suppresses the HS-04 violation', () => {
  const html = `<script>window.deleteAddress = (id) => { console.log(id); };</script><a onclick="deleteAddress('1')">Delete</a>`;
  const result = HsGateRules.evaluateHtml(html, 'sapo' as EcommercePlatform);
  assert.ok(!result.violations.some((item) => item.ruleId === 'HS-04'), 'inline handler must clear HS-04');
});

test('static HS engine: Sapo cart using name="id" without variantId flags HS-01 error', () => {
  const html = `<form action="/cart/add"><input name="quantity" value="1"><input name="id" value="42"></form>`;
  const result = HsGateRules.evaluateHtml(html, 'sapo' as EcommercePlatform);
  const hs01 = result.violations.find((item) => item.ruleId === 'HS-01');
  assert.ok(hs01, 'expected an HS-01 violation');
  assert.equal(hs01.severity, 'error');
  assert.equal(result.passed, false);
});

test('static HS engine: Sapo contact form posting to /contact without contact[email] flags HS-02 errors', () => {
  const html = `<form action="/contact" method="post"><input name="body"></form>`;
  const result = HsGateRules.evaluateHtml(html, 'sapo' as EcommercePlatform);
  const endpoint = result.violations.find((item) => item.ruleId === 'HS-02' && item.ruleTitle.includes('Endpoint'));
  const email = result.violations.find((item) => item.ruleId === 'HS-02' && item.ruleTitle.includes('Email'));
  assert.ok(endpoint, 'Sapo /contact endpoint must be flagged');
  assert.ok(email, 'missing contact[email] must be flagged');
  assert.equal(result.passed, false);
});

test('static HS engine: platform unknown short-circuits evaluation without error', () => {
  const html = `<form action="/cart/add"><input name="id" value="1"></form>`;
  const result = HsGateRules.evaluateHtml(html, 'unknown' as EcommercePlatform);
  assert.equal(result.totalViolations, 0);
  assert.equal(result.passed, true);
});

test('HsGateRules.getBrowserEvaluationScript compiles to valid JavaScript syntax without SyntaxError', () => {
  const platforms: EcommercePlatform[] = ['haravan', 'sapo', 'shopify', 'unknown'];
  for (const p of platforms) {
    const script = HsGateRules.getBrowserEvaluationScript(p);
    assert.doesNotThrow(() => {
      // Compile string as a JS function to ensure zero syntax errors
      new Function(script);
    }, `Script for platform ${p} must compile without SyntaxError`);
  }
});

test('HS-05: accepts valid absolute platform CDN images and flags invalid non-CDN images', () => {
  // 1. Haravan CDN image
  const hrvValid = `<img class="featured-image" src="https://file.hstatic.net/200000/file/product_1.jpg" />`;
  assert.equal(HsGateRules.evaluateHtml(hrvValid, 'haravan').violations.some(v => v.ruleId === 'HS-05'), false);

  const hrvInvalid = `<img class="featured-image" src="https://random-domain.com/product_1.jpg" />`;
  assert.equal(HsGateRules.evaluateHtml(hrvInvalid, 'haravan').violations.some(v => v.ruleId === 'HS-05'), true);

  // 2. Sapo CDN image (bizweb.dktcdn.net, dktcdn.net, cdn.sapo.vn)
  const sapoValidBizweb = `<img class="featured-image" src="https://bizweb.dktcdn.net/100/123/456/themes/theme.jpg" />`;
  assert.equal(HsGateRules.evaluateHtml(sapoValidBizweb, 'sapo').violations.some(v => v.ruleId === 'HS-05'), false);

  const sapoValidDkt = `<img class="featured-image" src="https://dktcdn.net/100/123/456/themes/theme.jpg" />`;
  assert.equal(HsGateRules.evaluateHtml(sapoValidDkt, 'sapo').violations.some(v => v.ruleId === 'HS-05'), false);

  const sapoValidCdn = `<img class="featured-image" src="https://cdn.sapo.vn/themes/banner.jpg" />`;
  assert.equal(HsGateRules.evaluateHtml(sapoValidCdn, 'sapo').violations.some(v => v.ruleId === 'HS-05'), false);

  // 3. Shopify CDN image (cdn.shopify.com, shopifycdn.com)
  const shopifyValid = `<img class="product__image" src="https://cdn.shopify.com/s/files/1/0000/products/item.png" />`;
  assert.equal(HsGateRules.evaluateHtml(shopifyValid, 'shopify').violations.some(v => v.ruleId === 'HS-05'), false);
});