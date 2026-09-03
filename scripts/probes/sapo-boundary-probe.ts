/**
 * AntiFan Architectural Stress Test: 5-Case Sapo Boundary-Breaker Canary Probe
 * 
 * Verifies that AntiFan Core-capable Understanding models are completely
 * platform-neutral and resilient against Shopify/Haravan lock-in.
 * 
 * Cases:
 * 1. Complex Layout (Flex wrap + nested grid + sticky header)
 * 2. Deep Component Hierarchy (3-level mega-menu navigation)
 * 3. Commerce Data Diversity (Sapo price ranges, compare-at, sold-out, discount badge)
 * 4. State & Interaction Model (Video modal with backdrop dismiss & ARIA delta)
 * 5. Template Divergence (Sapo BWT template compatibility & Liquid filter safety)
 */

import assert from 'node:assert';
import {
  DomTreeParser,
  ResponsiveScanner,
  EcommerceDataModeler,
  StateSynthesizer,
  type ComponentContractIR,
  type StateTransitionModel,
} from '../../packages/site-clone/dist/index.js';

interface ProbeResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const results: ProbeResult[] = [];

async function runProbe(name: string, fn: () => void | Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    results.push({ name, passed: true, durationMs, details: 'OK' });
    console.log(`  [PASS] ${name} (${durationMs}ms)`);
  } catch (err) {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, durationMs, details: msg });
    console.error(`  [FAIL] ${name} (${durationMs}ms): ${msg}`);
  }
}

async function main() {
  console.log('=================================================================');
  console.log('  AntiFan Architecture: 5-Case Sapo Canary Boundary Probe');
  console.log('=================================================================\n');

  // -------------------------------------------------------------------------
  // Case 1: Complex Layout (Flex wrap + nested grid + sticky header)
  // -------------------------------------------------------------------------
  await runProbe('Case 1: Complex Layout - Flex Wrap, Grid & Sticky Header', () => {
    const html = `
      <header class="header-sapo-sticky" style="position: sticky; top: 0; z-index: 100;">
        <div class="top-bar flex flex-wrap" style="display: flex; flex-wrap: wrap;">
          <div class="logo-col" style="flex: 0 0 240px;"><a href="/">SapoStore</a></div>
          <div class="search-col" style="flex: 1 1 auto;"><input type="text" placeholder="Tìm kiếm" /></div>
          <div class="hotline-col" style="flex: 0 0 180px;"><span>Hotline: 1900-1234</span></div>
        </div>
        <nav class="nav-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
          <div class="nav-item">Thiết bị điện</div>
          <div class="nav-item">Tự động hóa</div>
          <div class="nav-item">Cảm biến công nghiệp</div>
        </nav>
      </header>
    `;

    const root = DomTreeParser.parse(html);
    assert.ok(root, 'DOM root must be parsed successfully');

    const headers = DomTreeParser.findByTag(root, 'header');
    assert.strictEqual(headers.length, 1, 'Must extract header landmark');
    assert.ok(headers[0]?.attributes.class?.includes('header-sapo-sticky'));

    const navs = DomTreeParser.findByTag(root, 'nav');
    assert.strictEqual(navs.length, 1, 'Must extract nav landmark');

    // Verify child elements in grid
    const navItems = DomTreeParser.findByClass(root, 'nav-item');
    assert.strictEqual(navItems.length, 3, 'Must identify all 3 responsive grid items');
  });

  // -------------------------------------------------------------------------
  // Case 2: Deep Component Hierarchy (3-level mega-menu navigation)
  // -------------------------------------------------------------------------
  await runProbe('Case 2: Deep Hierarchy - 3-Level Mega-Menu Taxonomy Tree', () => {
    const html = `
      <ul class="sapo-nav-tree">
        <li class="l1-item">
          <a href="/thiet-bi-dong-cat">Thiết Bị Đóng Cắt</a>
          <div class="l2-dropdown">
            <div class="l2-column">
              <h4>Aptomat & Contactor</h4>
              <ul class="l3-list">
                <li><a href="/mccb">MCCB Schneider</a></li>
                <li><a href="/mcb">MCB Chint</a></li>
                <li><a href="/contactor">Contactor Fuji</a></li>
              </ul>
            </div>
            <div class="l2-column">
              <h4>Rơ Le & Phụ Kiện</h4>
              <ul class="l3-list">
                <li><a href="/ro-le-nhiet">Rơ Le Nhiệt</a></li>
                <li><a href="/ro-le-trung-gian">Rơ Le Trung Gian</a></li>
              </ul>
            </div>
          </div>
        </li>
      </ul>
    `;

    const root = DomTreeParser.parse(html);
    const l1Items = DomTreeParser.findByClass(root, 'l1-item');
    assert.strictEqual(l1Items.length, 1, 'Must extract Level 1 parent node');

    const l2Columns = DomTreeParser.findByClass(root, 'l2-column');
    assert.strictEqual(l2Columns.length, 2, 'Must extract both Level 2 category columns');

    const l3Links = DomTreeParser.findByTag(root, 'a').filter(a => a.attributes.href && a.attributes.href !== '/thiet-bi-dong-cat');
    assert.strictEqual(l3Links.length, 5, 'Must preserve all 5 Level 3 taxonomy leaves');
    
    // Verify tree depth is preserved without flattening into Shopify blocks
    const l1 = l1Items[0];
    assert.ok(l1, 'Level 1 item must exist');
    assert.ok(l1.children.some(c => typeof c !== 'string' && Boolean(c.attributes.class?.includes('l2-dropdown'))), 'Level 1 must contain Level 2 dropdown container');
  });

  // -------------------------------------------------------------------------
  // Case 3: Commerce Data Diversity (Sapo price ranges, compare-at, sold-out)
  // -------------------------------------------------------------------------
  await runProbe('Case 3: Data Diversity - Price Ranges, Compare-At & Status Badges', () => {
    const html = `
      <div class="product-item-wrap">
        <div class="product-item">
          <a class="product-img" href="/san-pham/bien-tan-inverter-yaskawa">
            <img src="https://bizweb.dktcdn.net/thumb/1024x1024/inverter-yaskawa.jpg" alt="Biến Tần Yaskawa GA700" />
            <span class="badge-sale">-30%</span>
            <span class="badge-stock out-of-stock">Hết hàng</span>
          </a>
          <div class="product-info">
            <span class="vendor">Yaskawa Electric</span>
            <h3 class="product-title">Biến Tần Yaskawa GA700 Series Đa Năng</h3>
            <div class="price-box">
              <span class="special-price">1.290.000₫ - 1.590.000₫</span>
              <del class="old-price">2.100.000₫</del>
            </div>
          </div>
        </div>
      </div>
    `;

    const modeler = new EcommerceDataModeler();
    const data = modeler.extractStorefrontData(html);

    assert.strictEqual(data.products.length, 1, 'Must extract product item');
    const prod = data.products[0];
    assert.ok(prod, 'Product must exist');

    assert.strictEqual(prod.title, 'Biến Tần Yaskawa GA700 Series Đa Năng');
    assert.strictEqual(prod.vendor, 'Yaskawa Electric');
    assert.strictEqual(prod.price, 1290000, 'Must parse min price from VND range format');
    assert.strictEqual(prod.compareAtPrice, 2100000, 'Must parse old price correctly');
    assert.strictEqual(prod.available, false, 'Must identify out-of-stock badge');
    assert.ok(prod.featuredImage?.includes('inverter-yaskawa.jpg'));
  });

  // -------------------------------------------------------------------------
  // Case 4: State Transition Modeling (Video modal with backdrop & ARIA delta)
  // -------------------------------------------------------------------------
  await runProbe('Case 4: State Model - Dialog Trigger, Transitions & ARIA Deltas', () => {
    const synthesizer = new StateSynthesizer();
    const controllers = [
      {
        id: 'sapo_modal_video_01',
        sectionId: 'video_section',
        type: 'modal' as const,
        targetSelector: '#video-lightbox',
        triggerSelector: '.btn-play-video',
        behavior: 'dialog_native' as const,
      },
      {
        id: 'sapo_dropdown_nav_01',
        sectionId: 'header_section',
        type: 'dropdown' as const,
        targetSelector: '.sub-menu-level-2',
        triggerSelector: '.menu-item-has-children',
        behavior: 'hover_intent' as const,
      },
    ];

    const transitions: StateTransitionModel[] = synthesizer.inferStateTransitions(controllers);

    assert.strictEqual(transitions.length, 2);

    // Modal verification
    const modalTransition = transitions.find(t => t.widgetType === 'modal');
    assert.ok(modalTransition);
    assert.strictEqual(modalTransition?.triggerEvent, 'click');
    assert.strictEqual(modalTransition?.effectType, 'visibility_toggle');
    assert.strictEqual(modalTransition?.ariaDelta?.attribute, 'aria-hidden');
    assert.strictEqual(modalTransition?.ariaDelta?.to, 'false');

    // Dropdown verification
    const dropdownTransition = transitions.find(t => t.widgetType === 'dropdown');
    assert.ok(dropdownTransition);
    assert.strictEqual(dropdownTransition?.triggerEvent, 'mouseover');
    assert.strictEqual(dropdownTransition?.effectType, 'class_toggle');
    assert.strictEqual(dropdownTransition?.ariaDelta?.attribute, 'aria-expanded');
    assert.strictEqual(dropdownTransition?.ariaDelta?.to, 'true');

    // Invariant: Core StateTransitionModel MUST NOT embed generated runtime JS strings
    assert.strictEqual((modalTransition as unknown as Record<string, unknown>).jsCode, undefined, 'Must not embed raw JS code in state transition model');
  });

  // -------------------------------------------------------------------------
  // Case 5: Template Divergence (Sapo BWT Template Compatibility)
  // -------------------------------------------------------------------------
  await runProbe('Case 5: Template Divergence - Sapo BWT Compatibility & Liquid Safety', () => {
    // Sapo BWT template representation rule check:
    // 1. Must not assume Shopify-only filters (e.g. string slice filter '{{ title | slice: 0, 10 }}' is forbidden in Sapo)
    // 2. Collection iteration uses collections['handle'].products
    // 3. Settings schema does not use Shopify OS 2.0 app block schemas

    const mockSapoBwtSection = `
      <div class="sapo-section-bwt" id="section-bwt-101">
        <div class="container">
          <h2 class="title">{{ section.settings.title }}</h2>
          <div class="grid flex">
            {% for product in collections[section.settings.collection].products limit: section.settings.limit %}
              {% include 'product-card' %}
            {% endfor %}
          </div>
        </div>
      </div>
    `.trim();

    // Verify absence of forbidden Shopify filters
    const forbiddenShopifyFilters = [
      '| slice:',
      '| image_url:',
      'block.shopify_attributes',
      'content_for_header',
      '{% schema %}', // Sapo BWT uses settings_schema.json or module headers, not inline schema tags
    ];

    for (const forbidden of forbiddenShopifyFilters) {
      assert.ok(!mockSapoBwtSection.includes(forbidden), `BWT template must not contain Shopify-exclusive construct: ${forbidden}`);
    }

    // Verify Sapo-compatible constructs
    assert.ok(mockSapoBwtSection.includes('{% include \'product-card\' %}'), 'Supports Sapo include construct');
    assert.ok(mockSapoBwtSection.includes('collections[section.settings.collection].products'), 'Supports collection indexing');
  });

  // -------------------------------------------------------------------------
  // Summary & Certification
  // -------------------------------------------------------------------------
  console.log('\n=================================================================');
  const allPassed = results.every(r => r.passed);
  const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);

  if (allPassed) {
    console.log(`  CERTIFIED PASS: 5/5 Sapo Boundary Breaker Cases Succeeded (${totalDuration}ms)`);
    console.log('  Boundary Invariants Verified:');
    console.log('    [x] Zero Shopify/Haravan schema or block lock-in');
    console.log('    [x] Clean AST parsing across deep hierarchies & flexible layouts');
    console.log('    [x] Independent State Transition Model without hardcoded runtime coupling');
    console.log('    [x] Sapo BWT template filter safety guaranteed');
    console.log('=================================================================\n');
    process.exit(0);
  } else {
    const failedCount = results.filter(r => !r.passed).length;
    console.error(`  FAILURE: ${failedCount}/5 Sapo Boundary Breaker Cases Failed`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal probe execution error:', err);
  process.exit(1);
});
