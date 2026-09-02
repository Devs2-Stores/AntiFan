/**
 * Main Application Bootstrap
 * Progressive enhancement for the Haravan-Ready HTML structure
 */

import { Slider } from './slider.js';
import { initNavigation } from './navigation.js';
import { initQuoteForm } from './quote-form.js';

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Hero Slider
  const heroSlider = new Slider('.hero-slider', {
    autoplay: true,
    interval: 5000,
    loop: true
  });

  // Initialize Navigation and Dropdowns
  initNavigation();

  // Initialize Quotation Form Handling
  initQuoteForm();

  console.log('✅ Hop Long Benchmark Theme Initialized Successfully.');
});
