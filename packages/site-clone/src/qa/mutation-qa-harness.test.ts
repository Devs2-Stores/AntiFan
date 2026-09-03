import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MutationQAHarness } from './mutation-qa-harness.js';

describe('MutationQAHarness - Layout & Content Mutation Stress Tests', () => {
  it('1. Generates mutant HTML fixtures for all scenarios', () => {
    const baseHtml = `
      <div class="product-grid">
        <div class="product-item">
          <img src="prod1.jpg" alt="Product 1" />
          <h3 class="title">Ao so mi nam</h3>
          <span class="price">250.000đ</span>
        </div>
      </div>
    `;

    // 1a. Text stretch
    const textMutant = MutationQAHarness.generateMutantHtml(baseHtml, 'text_stretch');
    assert.ok(textMutant.includes(MutationQAHarness.LONG_TEXT_PAYLOAD), 'Must inject 200-char string');

    // 1b. Image ratio tall
    const tallMutant = MutationQAHarness.generateMutantHtml(baseHtml, 'image_ratio_tall');
    assert.ok(tallMutant.includes('viewBox="0 0 300 900"'), 'Must inject tall SVG viewBox');

    // 1c. Image ratio wide
    const wideMutant = MutationQAHarness.generateMutantHtml(baseHtml, 'image_ratio_wide');
    assert.ok(wideMutant.includes('viewBox="0 0 900 300"'), 'Must inject wide SVG viewBox');

    // 1d. Cardinality 11
    const cardsMutant = MutationQAHarness.generateMutantHtml(baseHtml, 'cardinality_11');
    const matches = cardsMutant.match(/product-item/g);
    assert.strictEqual(matches?.length, 11, 'Must clone to 11 cards');
  });

  it('2. Builds executable Chromium evaluation script with safety checks', () => {
    const script = MutationQAHarness.buildChromiumEvaluationScript('text_stretch');
    assert.ok(script.includes('document.documentElement.scrollWidth'), 'Must check scrollWidth');
    assert.ok(script.includes('overflowDeltaX'), 'Must calculate overflow delta');
    assert.ok(script.includes('liquidLeak'), 'Must audit Liquid expression leaks');
  });

  it('3. evaluateMeasurement enforces strict hard blockers', () => {
    const validBaseline = {
      targetFound: true,
      cardCount: 4,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      cardHeight: 280,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      gridWrapAndRowAlignmentValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    };

    // 3a. Clean run passes
    const cleanResult = MutationQAHarness.evaluateMeasurement('text_stretch', {
      targetFound: true,
      cardCount: 4,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      cardHeight: 300,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      gridWrapAndRowAlignmentValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(cleanResult.passed, true);
    assert.strictEqual(cleanResult.hardBlockerTriggered, false);

    // 3b. Missing target fails closed
    const missingResult = MutationQAHarness.evaluateMeasurement('text_stretch', {
      targetFound: false,
      cardCount: 0,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: false,
      imageLoaded: false,
      priceFound: false,
      priceValid: false,
      liquidLeakDetected: false,
      overlapDetected: false
    });
    assert.strictEqual(missingResult.passed, false);
    assert.strictEqual(missingResult.hardBlockerTriggered, true);
    assert.ok(missingResult.failureReasons[0].includes('No valid product card target found'));

    // 3c. Missing or invalid price triggers Hard Blocker
    const nanPriceResult = MutationQAHarness.evaluateMeasurement('text_stretch', {
      targetFound: true,
      cardCount: 4,
      cardHeight: 280,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: false,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(nanPriceResult.passed, false);
    assert.strictEqual(nanPriceResult.hardBlockerTriggered, true);
    assert.ok(nanPriceResult.failureReasons.some((r) => r.includes('price element missing')));

    // 3d. Missing or unloaded image triggers Hard Blocker
    const unloadedImgResult = MutationQAHarness.evaluateMeasurement('image_ratio_tall', {
      targetFound: true,
      cardCount: 4,
      cardHeight: 280,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: false,
      imageRenderWidth: 0,
      imageRenderHeight: 0,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(unloadedImgResult.passed, false);
    assert.strictEqual(unloadedImgResult.hardBlockerTriggered, true);
    assert.ok(unloadedImgResult.failureReasons.some((r) => r.includes('failed to load or has 0 render dimensions')));

    // 3e. Missing baseline height triggers Hard Blocker
    const noBaselineResult = MutationQAHarness.evaluateMeasurement('text_stretch', {
      targetFound: true,
      cardCount: 4,
      cardHeight: 280,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    });
    assert.strictEqual(noBaselineResult.passed, false);
    assert.strictEqual(noBaselineResult.hardBlockerTriggered, true);
    assert.ok(noBaselineResult.failureReasons.some((r) => r.includes('Missing valid baseline card height')));

    // 3f. Cardinality 1 count & nav controls check
    const card1FailResult = MutationQAHarness.evaluateMeasurement('cardinality_1', {
      targetFound: true,
      cardCount: 3,
      cardHeight: 280,
      navControlsHidden: false,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(card1FailResult.passed, false);
    assert.strictEqual(card1FailResult.hardBlockerTriggered, true);
    assert.ok(card1FailResult.failureReasons.some((r) => r.includes('expected exactly 1 card')));
    assert.ok(card1FailResult.failureReasons.some((r) => r.includes('Navigation controls')));

    // 3f-2. Cardinality 1 card width blowout > 480px ceiling
    const cardBlowoutResult = MutationQAHarness.evaluateMeasurement('cardinality_1', {
      targetFound: true,
      cardCount: 1,
      cardHeight: 280,
      cardWidth: 500,
      navControlsHidden: true,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(cardBlowoutResult.passed, false);
    assert.strictEqual(cardBlowoutResult.hardBlockerTriggered, true);
    assert.ok(cardBlowoutResult.failureReasons.some((r) => r.includes('480px ceiling')));

    // 3f-3. Cardinality 1 missing cardWidth triggers fail-closed
    const missingWidthResult = MutationQAHarness.evaluateMeasurement('cardinality_1', {
      targetFound: true,
      cardCount: 1,
      cardHeight: 280,
      navControlsHidden: true,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(missingWidthResult.passed, false);
    assert.strictEqual(missingWidthResult.hardBlockerTriggered, true);
    assert.ok(missingWidthResult.failureReasons.some((r) => r.includes('card width measurement is missing')));
    const card11WrapFail = MutationQAHarness.evaluateMeasurement('cardinality_11', {
      targetFound: true,
      cardCount: 11,
      cardHeight: 280,
      gridWrapAndRowAlignmentValid: false,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(card11WrapFail.passed, false);
    assert.strictEqual(card11WrapFail.hardBlockerTriggered, true);
    assert.ok(card11WrapFail.failureReasons.some((r) => r.includes('failed grid wrap containment or row alignment')));

    // 3h. Height ratio blowout assertion against baseline
    const heightRatioFailResult = MutationQAHarness.evaluateMeasurement('text_stretch', {
      targetFound: true,
      cardCount: 4,
      cardHeight: 1200,
      scrollWidth: 1440,
      clientWidth: 1440,
      overflowDeltaX: 0,
      imageFound: true,
      imageLoaded: true,
      imageRenderWidth: 200,
      imageRenderHeight: 200,
      priceFound: true,
      priceValid: true,
      liquidLeakDetected: false,
      overlapDetected: false
    }, validBaseline);
    assert.strictEqual(heightRatioFailResult.passed, false);
    assert.strictEqual(heightRatioFailResult.hardBlockerTriggered, true);
    assert.ok(heightRatioFailResult.failureReasons.some((r) => r.includes('Card height ratio')));
  });
  it('4. Preserves header logo and navigation menu items during mutation', () => {
    const complexHtml = `
      <header class="site-header">
        <img class="logo" src="https://cdn.example.com/logo.png" alt="Store Logo" />
        <nav class="main-nav">
          <ul>
            <li class="menu-item"><a href="/">Trang chủ</a></li>
            <li class="nav-item"><a href="/products">Sản phẩm</a></li>
          </ul>
        </nav>
      </header>
      <main>
        <div class="product-grid">
          <div class="product-card">
            <img class="thumb" src="https://cdn.example.com/prod1.jpg" alt="Product" />
            <h3 class="product-title">Tên sản phẩm gốc</h3>
            <span class="price">100.000đ</span>
          </div>
        </div>
      </main>
    `;

    // Image mutation must touch product image, NOT logo
    const mutantImg = MutationQAHarness.generateMutantHtml(complexHtml, 'image_ratio_tall');
    assert.ok(mutantImg.includes('src="https://cdn.example.com/logo.png"'), 'Logo image must remain untouched');
    assert.ok(mutantImg.includes(MutationQAHarness.SVG_TALL), 'Product image must be mutated to tall SVG');

    // Text stretch must touch product title, NOT menu
    const mutantText = MutationQAHarness.generateMutantHtml(complexHtml, 'text_stretch');
    assert.ok(mutantText.includes('Trang chủ'), 'Menu navigation text must remain untouched');
    assert.ok(mutantText.includes(MutationQAHarness.LONG_TEXT_PAYLOAD), 'Product title must be stretched');
  });

  it('5. Fails closed when no valid product card is present', () => {
    const noProductHtml = `
      <header class="header">
        <h1>Blog Page</h1>
        <div class="article-item">
          <p>This is a blog post without products</p>
        </div>
      </header>
    `;

    assert.throws(
      () => MutationQAHarness.generateMutantHtml(noProductHtml, 'text_stretch'),
      /No valid product card candidate found/
    );
  });
});
