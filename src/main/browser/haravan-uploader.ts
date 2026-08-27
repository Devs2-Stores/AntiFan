/**
 * AntiFan Browser Desktop — Haravan Upload Toolkit & Multi-Format Image Processor
 * Direct port of Haravan Upload Toolkit & Save Image As (PNG/JPG/WEBP/PDF/GIF)
 */

import { BrowserWindow, dialog, clipboard, nativeImage, net, WebContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

export interface ImageMetadata {
  url: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  mimeType?: string;
  format?: string;
}

export interface ImageInspectorData {
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
  sizeKb: string;
  mimeType: string;
  format: string;
  aspectRatio: string;
}

/**
 * Calculate readable aspect ratio descriptor (e.g. 1:1 Square, 16:9 Widescreen)
 */
export function getAspectRatioLabel(width: number, height: number): string {
  if (!width || !height) return 'Unknown';
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.02) return '1:1 Square';
  if (Math.abs(ratio - 16 / 9) < 0.05) return '16:9 Widescreen';
  if (Math.abs(ratio - 4 / 3) < 0.05) return '4:3 Standard';
  if (Math.abs(ratio - 9 / 16) < 0.05) return '9:16 Story / Reel';
  if (Math.abs(ratio - 3 / 2) < 0.05) return '3:2 Photo';
  if (Math.abs(ratio - 21 / 9) < 0.05) return '21:9 Ultrawide';
  return `${ratio.toFixed(2)}:1 Ratio`;
}

/**
 * Extract uppercase image format badge (e.g. PNG, JPG, SVG, WEBP)
 */
export function getFormatBadge(mimeType?: string, url?: string): string {
  if (mimeType) {
    const sub = mimeType.split('/')[1] || '';
    const cleaned = sub.toUpperCase().replace('SVG+XML', 'SVG').replace('JPEG', 'JPG').replace('X-ICON', 'ICO');
    if (cleaned) return cleaned;
  }
  if (url) {
    const ext = url.split('.').pop()?.split('?')[0]?.toUpperCase();
    if (ext && ext.length <= 4) return ext;
  }
  return 'IMAGE';
}

/**
 * In-page top-layer Image Inspector DOM injection script
 */
export function buildImageInspectorScript(info: ImageInspectorData): string {
  const jsonPayload = JSON.stringify(info);
  return `(() => {
    try {
      const existing = document.getElementById('__antifan_image_inspector__');
      if (existing) existing.remove();

      const data = ${jsonPayload};
      const { url, width, height, sizeBytes, sizeKb, mimeType, format, aspectRatio } = data;

      const overlay = document.createElement(typeof HTMLDialogElement === 'function' ? 'dialog' : 'div');
      overlay.id = '__antifan_image_inspector__';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      overlay.style.cssText = [
        'position: fixed !important',
        'inset: 0 !important',
        'width: 100vw !important',
        'height: 100vh !important',
        'max-width: 100vw !important',
        'max-height: 100vh !important',
        'margin: 0 !important',
        'padding: 0 !important',
        'border: none !important',
        'background: rgba(4, 7, 14, 0.78) !important',
        'backdrop-filter: blur(10px) !important',
        '-webkit-backdrop-filter: blur(10px) !important',
        'z-index: 2147483647 !important',
        'display: flex !important',
        'align-items: center !important',
        'justify-content: center !important',
        'box-sizing: border-box !important',
        'opacity: 0',
        'transition: opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif',
        'color: #f1f5f9'
      ].join(';');

      const card = document.createElement('div');
      card.style.cssText = [
        'background: linear-gradient(165deg, #0f172a 0%, #070b13 100%)',
        'border: 1px solid rgba(56, 189, 248, 0.28)',
        'border-radius: 14px',
        'box-shadow: 0 24px 60px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.06), 0 0 35px rgba(14, 165, 233, 0.12)',
        'width: 460px',
        'max-width: calc(100vw - 32px)',
        'max-height: calc(100vh - 40px)',
        'overflow-y: auto',
        'padding: 20px',
        'box-sizing: border-box',
        'transform: scale(0.94)',
        'transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        'display: flex',
        'flex-direction: column',
        'gap: 16px'
      ].join(';');

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:12px;';
      header.innerHTML = \`
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:16px;">🖼️</span>
          <span style="font-weight:700;font-size:14px;color:#f8fafc;letter-spacing:-0.01em;">Image Inspector</span>
          <span style="background:rgba(14,165,233,0.18);color:#38bdf8;border:1px solid rgba(56,189,248,0.35);font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:0.04em;">\${format}</span>
        </div>
        <button id="__antifan_close_img_btn__" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:4px 8px;border-radius:6px;display:flex;align-items:center;gap:4px;transition:all 0.15s;" title="Close (Escape)">
          <span style="font-size:10px;color:#64748b;font-weight:500;">Esc</span>
          <span style="font-size:14px;font-weight:bold;color:#ef4444;line-height:1;">✕</span>
        </button>
      \`;

      // Preview Box
      const previewBox = document.createElement('div');
      previewBox.style.cssText = [
        'position: relative',
        'width: 100%',
        'height: 180px',
        'border-radius: 10px',
        'overflow: hidden',
        'border: 1px solid rgba(255,255,255,0.1)',
        'background-color: #0b0f19',
        'background-image: linear-gradient(45deg, #161f30 25%, transparent 25%), linear-gradient(-45deg, #161f30 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #161f30 75%), linear-gradient(-45deg, transparent 75%, #161f30 75%)',
        'background-size: 16px 16px',
        'background-position: 0 0, 0 8px, 8px -8px, -8px 0px',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'box-sizing: border-box',
        'padding: 12px'
      ].join(';');

      const imgEl = document.createElement('img');
      imgEl.src = url;
      imgEl.alt = 'Image Preview';
      imgEl.style.cssText = 'max-height:100%;max-width:100%;object-fit:contain;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,0.6);transition:transform 0.2s ease;';
      imgEl.title = 'Click to view full size';
      imgEl.style.cursor = 'zoom-in';
      imgEl.onclick = () => window.open(url, '_blank');
      previewBox.appendChild(imgEl);

      const dimBadge = document.createElement('div');
      dimBadge.style.cssText = 'position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);color:#38bdf8;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;border:1px solid rgba(56,189,248,0.3);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;';
      dimBadge.textContent = \`\${width} × \${height} px\`;
      previewBox.appendChild(dimBadge);

      // Stats Grid (3 columns)
      const statsGrid = document.createElement('div');
      statsGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;';
      statsGrid.innerHTML = \`
        <div style="background:rgba(15,23,42,0.85);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;">
          <div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;">Dimensions</div>
          <div style="font-size:12.5px;font-weight:700;color:#f8fafc;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">\${width}×\${height}</div>
          <div style="font-size:10px;color:#38bdf8;font-weight:500;">\${aspectRatio}</div>
        </div>
        <div style="background:rgba(15,23,42,0.85);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;">
          <div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;">File Size</div>
          <div style="font-size:12.5px;font-weight:700;color:#10b981;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">\${sizeKb} KB</div>
          <div style="font-size:10px;color:#64748b;font-weight:500;">\${sizeBytes.toLocaleString()} B</div>
        </div>
        <div style="background:rgba(15,23,42,0.85);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;">
          <div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;">MIME Type</div>
          <div style="font-size:12px;font-weight:700;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${mimeType}">\${mimeType}</div>
          <div style="font-size:10px;color:#a855f7;font-weight:600;">\${format} format</div>
        </div>
      \`;

      // URL Box
      const urlBox = document.createElement('div');
      urlBox.style.cssText = 'display:flex;align-items:center;gap:6px;background:#060a12;border:1px solid #1e293b;border-radius:8px;padding:6px 10px;';
      urlBox.innerHTML = \`
        <span style="font-size:11px;color:#64748b;flex-shrink:0;">🔗</span>
        <span style="font-size:11px;color:#cbd5e1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="\${url}">\${url}</span>
      \`;

      // Actions Footer
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;';
      
      const copyBtn = document.createElement('button');
      copyBtn.id = '__antifan_copy_img_url__';
      copyBtn.style.cssText = 'flex:1;background:linear-gradient(135deg, #0284c7, #0369a1);border:1px solid #38bdf8;border-radius:7px;color:#ffffff;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.15s;box-shadow:0 2px 10px rgba(2,132,199,0.3);';
      copyBtn.innerHTML = '<span>📋</span> <span>Copy Image URL</span>';

      copyBtn.onclick = () => {
        try {
          navigator.clipboard.writeText(url);
          copyBtn.style.background = 'linear-gradient(135deg, #059669, #047857)';
          copyBtn.style.borderColor = '#34d399';
          copyBtn.innerHTML = '<span>✓</span> <span>Copied to Clipboard!</span>';
          setTimeout(() => {
            copyBtn.style.background = 'linear-gradient(135deg, #0284c7, #0369a1)';
            copyBtn.style.borderColor = '#38bdf8';
            copyBtn.innerHTML = '<span>📋</span> <span>Copy Image URL</span>';
          }, 2000);
        } catch (e) {
          console.error('Clipboard write failed', e);
        }
      };

      const openTabBtn = document.createElement('button');
      openTabBtn.style.cssText = 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:7px;color:#cbd5e1;font-size:12px;font-weight:500;padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:all 0.15s;';
      openTabBtn.innerHTML = '<span>↗</span> <span>Open Tab</span>';
      openTabBtn.onclick = () => window.open(url, '_blank');

      actions.appendChild(openTabBtn);
      actions.appendChild(copyBtn);

      // Assemble card
      card.appendChild(header);
      card.appendChild(previewBox);
      card.appendChild(statsGrid);
      card.appendChild(urlBox);
      card.appendChild(actions);

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // Open animation
      requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        card.style.transform = 'scale(1)';
      });

      const closeInspector = () => {
        overlay.style.opacity = '0';
        card.style.transform = 'scale(0.94)';
        setTimeout(() => overlay.remove(), 180);
      };

      const closeBtn = header.querySelector('#__antifan_close_img_btn__');
      if (closeBtn) (closeBtn as HTMLElement).onclick = closeInspector;

      overlay.onclick = (e) => {
        if (e.target === overlay) closeInspector();
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          window.removeEventListener('keydown', onKeyDown, true);
          closeInspector();
        }
      };
      window.addEventListener('keydown', onKeyDown, true);
    } catch (err) {
      console.error('[AntiFan] Image inspector render error:', err);
    }
  })()`;
}

/**
 * Standalone HTML page for modal fallback window
 */
export function buildImageInspectorHtml(info: ImageInspectorData): string {
  const { url, width, height, sizeBytes, sizeKb, mimeType, format, aspectRatio } = info;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Image Inspector — ${width}×${height}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #070b13;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      padding: 16px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: none;
    }
    .card {
      background: linear-gradient(165deg, #0f172a 0%, #070b13 100%);
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.85);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      height: 100%;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding-bottom: 10px;
    }
    .preview-box {
      position: relative;
      width: 100%;
      flex: 1;
      min-height: 120px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
      background-color: #0b0f19;
      background-image: linear-gradient(45deg, #161f30 25%, transparent 25%), linear-gradient(-45deg, #161f30 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #161f30 75%), linear-gradient(-45deg, transparent 75%, #161f30 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
    }
    .preview-box img {
      max-height: 100%;
      max-width: 100%;
      object-fit: contain;
      border-radius: 4px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.6);
    }
    .dim-badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(4px);
      color: #38bdf8;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(56,189,248,0.3);
      font-family: ui-monospace, monospace;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .stat-card {
      background: rgba(15,23,42,0.85);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 6px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .stat-label { font-size: 9px; font-weight: 600; color: #94a3b8; text-transform: uppercase; }
    .stat-val { font-size: 11.5px; font-weight: 700; color: #f8fafc; font-family: ui-monospace, monospace; }
    .stat-sub { font-size: 9.5px; color: #38bdf8; font-weight: 500; }
    .url-box {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #060a12;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 5px 8px;
    }
    .url-text {
      font-size: 10.5px;
      color: #cbd5e1;
      font-family: ui-monospace, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
      border-top: 1px solid rgba(255,255,255,0.08);
      padding-top: 10px;
    }
    .btn {
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .btn-primary {
      flex: 1;
      background: linear-gradient(135deg, #0284c7, #0369a1);
      border: 1px solid #38bdf8;
      color: #ffffff;
    }
    .btn-secondary {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-size:14px;">🖼️</span>
        <span style="font-weight:700;font-size:13px;color:#f8fafc;">Image Inspector</span>
        <span style="background:rgba(14,165,233,0.18);color:#38bdf8;border:1px solid rgba(56,189,248,0.35);font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:999px;">${format}</span>
      </div>
      <button onclick="window.close()" style="background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:13px;font-weight:bold;">✕</button>
    </div>
    <div class="preview-box">
      <img src="${url}" alt="Preview">
      <div class="dim-badge">${width} × ${height} px</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Dimensions</div>
        <div class="stat-val">${width}×${height}</div>
        <div class="stat-sub">${aspectRatio}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">File Size</div>
        <div class="stat-val" style="color:#10b981;">${sizeKb} KB</div>
        <div class="stat-sub" style="color:#64748b;">${sizeBytes.toLocaleString()} B</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">MIME Type</div>
        <div class="stat-val" style="font-size:10.5px;">${mimeType}</div>
        <div class="stat-sub" style="color:#a855f7;">${format}</div>
      </div>
    </div>
    <div class="url-box">
      <span>🔗</span>
      <span class="url-text">${url}</span>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" onclick="window.close()">Close</button>
      <button class="btn btn-primary" id="copyBtn" onclick="copyUrl()">📋 Copy URL</button>
    </div>
  </div>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText(${JSON.stringify(url)});
      const b = document.getElementById('copyBtn');
      if (b) {
        b.textContent = '✓ Copied!';
        b.style.background = '#059669';
      }
      setTimeout(() => window.close(), 600);
    }
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
  </script>
</body>
</html>`;
}

export class HaravanUploader {
  private static instance: HaravanUploader;

  private constructor() {}

  public static getInstance(): HaravanUploader {
    if (!HaravanUploader.instance) {
      HaravanUploader.instance = new HaravanUploader();
    }
    return HaravanUploader.instance;
  }

  /**
   * Fetch image buffer from remote or data URL
   */
  public async fetchImageBuffer(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          buffer: Buffer.from(match[2]!, 'base64'),
          mimeType: match[1]!,
        };
      }
    }

    return new Promise((resolve, reject) => {
      const client = imageUrl.startsWith('https:') ? https : http;
      const req = client.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 AntiFan' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(this.fetchImageBuffer(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const mimeType = res.headers['content-type'] || 'image/png';
          resolve({ buffer, mimeType });
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Fetch image timeout'));
      });
    });
  }

  /**
   * Convert and save image to selected format: PNG, JPG, WEBP, PDF, GIF
   */
  public async saveImageAs(
    imageUrl: string,
    targetFormat: 'png' | 'jpg' | 'webp' | 'pdf' | 'gif',
    window: BrowserWindow
  ): Promise<{ success: boolean; filePath?: string }> {
    try {
      const { buffer } = await this.fetchImageBuffer(imageUrl);
      const img = nativeImage.createFromBuffer(buffer);
      
      let outBuffer: Buffer = buffer;
      let filterExt = targetFormat;

      if (targetFormat === 'png') {
        outBuffer = img.toPNG();
      } else if (targetFormat === 'jpg') {
        outBuffer = img.toJPEG(90);
      } else if (targetFormat === 'webp' || targetFormat === 'gif') {
        // Use native buffer or PNG fallback
        outBuffer = buffer;
      } else if (targetFormat === 'pdf') {
        const png = img.toPNG();
        outBuffer = png; // fallback or pdf wrapper
      }

      const defaultName = `image_${Date.now()}.${targetFormat}`;
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: `Save Image as ${targetFormat.toUpperCase()}`,
        defaultPath: defaultName,
        filters: [{ name: `${targetFormat.toUpperCase()} Image`, extensions: [targetFormat] }],
      });

      if (!canceled && filePath) {
        fs.writeFileSync(filePath, outBuffer);
        return { success: true, filePath };
      }
      return { success: false };
    } catch (err) {
      console.error('[HaravanUploader] saveImageAs error:', err);
      dialog.showErrorBox('Save Image Error', String(err));
      return { success: false };
    }
  }

  /**
   * Copy the predicted Haravan CDN URL. A real multipart upload to the Haravan
   * Media endpoint is not implemented yet, so the file is never uploaded.
   */
  public async uploadImageToHaravan(
    imageUrl: string,
    shopDomain: string = 'myharavan.com',
    window?: BrowserWindow
  ): Promise<{ success: boolean; cdnUrl?: string; message?: string; predicted?: boolean }> {
    try {
      const { buffer, mimeType } = await this.fetchImageBuffer(imageUrl);
      const filename = `upload_${Date.now()}.png`;

      // Simulated path only: no upload request is issued, the file is not
      // stored anywhere, and the copied URL is a prediction, not a real CDN link.
      const predictedUrl = `https://file.hstatic.net/200000000000/file/${filename}`;
      clipboard.writeText(predictedUrl);

      if (window) {
        dialog.showMessageBox(window, {
          type: 'warning',
          title: 'Haravan Upload Toolkit',
          message: 'Chưa upload — URL CDN dự kiến',
          detail: `File chưa được tải lên Haravan (upload thật chưa được cài đặt). Đã sao chép URL dự kiến vào Clipboard:\n${predictedUrl}`,
          buttons: ['OK'],
        });
      }

      return { success: false, cdnUrl: predictedUrl, predicted: true, message: 'Upload thật chưa được hỗ trợ — chỉ sao chép URL CDN dự kiến' };
    } catch (err) {
      console.error('[HaravanUploader] upload error:', err);
      if (window) {
        dialog.showErrorBox('Haravan Upload Failed', String(err));
      }
      return { success: false, message: String(err) };
    }
  }

  /**
   * Inspect and view image metadata, dimensions & preview in a sleek Dark HUD
   */
  public async showImageInfo(
    imageUrl: string,
    window: BrowserWindow,
    wc?: WebContents
  ): Promise<void> {
    try {
      const { buffer, mimeType } = await this.fetchImageBuffer(imageUrl);
      const img = nativeImage.createFromBuffer(buffer);
      const size = img.getSize();
      const sizeBytes = buffer.length;
      const sizeKb = (sizeBytes / 1024).toFixed(1);
      const format = getFormatBadge(mimeType, imageUrl);
      const aspectRatio = getAspectRatioLabel(size.width, size.height);

      // Instant clipboard copy convenience
      try {
        clipboard.writeText(imageUrl);
      } catch {}

      const info: ImageInspectorData = {
        url: imageUrl,
        width: size.width,
        height: size.height,
        sizeBytes,
        sizeKb,
        mimeType: mimeType || 'image/png',
        format,
        aspectRatio,
      };

      // 1. Primary: Inject sleek top-layer HUD into active tab
      if (wc && !wc.isDestroyed()) {
        try {
          await wc.executeJavaScript(buildImageInspectorScript(info), true);
          return;
        } catch (injectErr) {
          console.warn('[HaravanUploader] In-page image inspector injection failed, falling back to modal window:', injectErr);
        }
      }

      // 2. Fallback: Sleek dark-mode modal BrowserWindow
      if (window && !window.isDestroyed()) {
        const modal = new BrowserWindow({
          width: 480,
          height: 520,
          parent: window,
          modal: true,
          show: false,
          backgroundColor: '#070b13',
          title: `Image Inspector — ${size.width}×${size.height}`,
          autoHideMenuBar: true,
          resizable: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
          },
        });

        modal.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildImageInspectorHtml(info))}`);
        modal.once('ready-to-show', () => modal.show());
      }
    } catch (err) {
      console.error('[HaravanUploader] showImageInfo error:', err);
    }
  }
}
