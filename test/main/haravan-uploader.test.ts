import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  getAspectRatioLabel,
  getFormatBadge,
  buildImageInspectorScript,
  buildImageInspectorHtml,
  ImageInspectorData,
} from '../../src/main/browser/haravan-uploader';

describe('Image Inspector Helpers and UI Generators', () => {
  describe('getAspectRatioLabel', () => {
    it('accurately identifies common aspect ratios', () => {
      assert.strictEqual(getAspectRatioLabel(128, 128), '1:1 Square');
      assert.strictEqual(getAspectRatioLabel(500, 500), '1:1 Square');
      assert.strictEqual(getAspectRatioLabel(1920, 1080), '16:9 Widescreen');
      assert.strictEqual(getAspectRatioLabel(1280, 720), '16:9 Widescreen');
      assert.strictEqual(getAspectRatioLabel(800, 600), '4:3 Standard');
      assert.strictEqual(getAspectRatioLabel(1024, 768), '4:3 Standard');
      assert.strictEqual(getAspectRatioLabel(1080, 1920), '9:16 Story / Reel');
      assert.strictEqual(getAspectRatioLabel(600, 400), '3:2 Photo');
      assert.strictEqual(getAspectRatioLabel(2560, 1080), '21:9 Ultrawide');
    });

    it('formats arbitrary aspect ratios cleanly', () => {
      assert.strictEqual(getAspectRatioLabel(500, 300), '1.67:1 Ratio');
      assert.strictEqual(getAspectRatioLabel(100, 300), '0.33:1 Ratio');
    });

    it('handles zero or missing dimensions gracefully', () => {
      assert.strictEqual(getAspectRatioLabel(0, 0), 'Unknown');
      assert.strictEqual(getAspectRatioLabel(0, 100), 'Unknown');
      assert.strictEqual(getAspectRatioLabel(100, 0), 'Unknown');
    });
  });

  describe('getFormatBadge', () => {
    it('extracts format badge from mimeType', () => {
      assert.strictEqual(getFormatBadge('image/png'), 'PNG');
      assert.strictEqual(getFormatBadge('image/jpeg'), 'JPG');
      assert.strictEqual(getFormatBadge('image/webp'), 'WEBP');
      assert.strictEqual(getFormatBadge('image/svg+xml'), 'SVG');
      assert.strictEqual(getFormatBadge('image/gif'), 'GIF');
      assert.strictEqual(getFormatBadge('image/x-icon'), 'ICO');
    });

    it('falls back to URL extension when mimeType is missing', () => {
      assert.strictEqual(getFormatBadge(undefined, 'https://cdn.shopify.com/files/hero.avif'), 'AVIF');
      assert.strictEqual(getFormatBadge(undefined, 'https://hstatic.net/img.png?v=123'), 'PNG');
    });

    it('returns default fallback when both are unavailable', () => {
      assert.strictEqual(getFormatBadge(undefined, undefined), 'IMAGE');
    });
  });

  describe('buildImageInspectorScript', () => {
    it('generates valid in-page injection script with payload embedded', () => {
      const sampleData: ImageInspectorData = {
        url: 'http://localhost:20128/providers/antigravity.png',
        width: 128,
        height: 128,
        sizeBytes: 11588,
        sizeKb: '11.3',
        mimeType: 'image/png',
        format: 'PNG',
        aspectRatio: '1:1 Square',
      };

      const script = buildImageInspectorScript(sampleData);
      assert.ok(typeof script === 'string' && script.length > 500);
      assert.ok(script.includes('__antifan_image_inspector__'));
      assert.ok(script.includes('http://localhost:20128/providers/antigravity.png'));
      assert.ok(script.includes('"width":128'));
      assert.ok(script.includes('"sizeKb":"11.3"'));
      assert.ok(script.includes('"aspectRatio":"1:1 Square"'));
      assert.ok(script.includes('"format":"PNG"'));
      assert.ok(script.includes('Escape'));
    });
  });

  describe('buildImageInspectorHtml', () => {
    it('generates valid HTML document for standalone modal', () => {
      const sampleData: ImageInspectorData = {
        url: 'https://example.com/photo.jpg',
        width: 1920,
        height: 1080,
        sizeBytes: 254100,
        sizeKb: '248.1',
        mimeType: 'image/jpeg',
        format: 'JPG',
        aspectRatio: '16:9 Widescreen',
      };

      const html = buildImageInspectorHtml(sampleData);
      assert.ok(typeof html === 'string' && html.length > 500);
      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('Image Inspector'));
      assert.ok(html.includes('1920×1080'));
      assert.ok(html.includes('248.1 KB'));
      assert.ok(html.includes('16:9 Widescreen'));
      assert.ok(html.includes('https://example.com/photo.jpg'));
    });
  });
});
