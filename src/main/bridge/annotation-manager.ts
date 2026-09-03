/**
 * AntiFan Browser Desktop — Annotation Manager & Artifact Generator
 * 100% Feature Parity with Antigravity Browser Element Annotation / Add Comment Pipeline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CapabilityError } from '../../shared/control-plane-contracts';
import {
  buildAgentTaskHeader,
  buildEvidenceEnvelope,
  classifyTaskIntent,
  getInitialTerminalState,
} from '../../shared/annotation-prompt';

export const ACTIVE_CSS_PROPERTIES: Record<string, true> = {
  display: true,
  'flex-direction': true,
  'justify-content': true,
  'align-items': true,
  'align-self': true,
  gap: true,
  'grid-template-columns': true,
  'grid-template-rows': true,
  position: true,
  top: true,
  right: true,
  bottom: true,
  left: true,
  'z-index': true,
  width: true,
  'max-width': true,
  'min-width': true,
  height: true,
  'max-height': true,
  'min-height': true,
  padding: true,
  margin: true,
  color: true,
  'background-color': true,
  background: true,
  'font-size': true,
  'font-weight': true,
  'font-family': true,
  'line-height': true,
  'text-align': true,
  'text-transform': true,
  border: true,
  'border-radius': true,
  'box-shadow': true,
  opacity: true,
  transform: true,
  overflow: true,
  'box-sizing': true,
  cursor: true,
  'pointer-events': true,
  visibility: true,
};

export interface AnnotationPayload {
  annotationId?: string;
  workspaceDir?: string;
  url?: string;
  title?: string;
  selector?: string;
  tagName?: string;
  id?: string;
  classes?: string[];
  dimensions?: string;
  domAncestry?: string;
  childCount?: number;
  childTags?: string[];
  position?: Record<string, any>;
  viewport?: Record<string, any>;
  attributes?: Record<string, any>;
  liquidContext?: Record<string, any>;
  computedStyles?: Record<string, any>;
  outerHTML?: string;
  textContent?: string;
  userComment?: string;
  targetImageBase64?: string;
  viewportImageBase64?: string;
  attachedImages?: Array<{ name: string; dataUrl: string }>;
  interactionState?: Record<string, any>;
  accessibilitySnapshot?: Record<string, any>;
  sourceHints?: Record<string, any>;
  runtimeErrors?: any[];
  resourceFailures?: any[];
  slowResources?: any[];
  captureWarnings?: string[];
  multiItems?: any[];
  isUnique?: boolean;
  matchCount?: number;
  captureTimeDomIndex?: number;
  isClone?: boolean;
  canonicalEvidence?: Record<string, any>;
  relativeSubpath?: string;
  relativeSubpathStability?: string;
  isLoopItem?: boolean;
  indexStability?: string;
  boxModel?: Record<string, any>;
  parentLayout?: Record<string, any>;
  siblingSemantics?: any[];
}

export class AnnotationManager {
  private static instance: AnnotationManager;

  public static getInstance(): AnnotationManager {
    if (!this.instance) {
      this.instance = new AnnotationManager();
    }
    return this.instance;
  }

  private getStorageDirectories(customWsDir?: string): { annotationsDir: string; snapshotsDir: string } {
    if (!customWsDir || typeof customWsDir !== 'string' || !fs.existsSync(customWsDir)) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'Annotation processing requires a valid, bound workspace directory');
    }
    const baseDir = path.join(path.resolve(customWsDir), '.antifan');
    const annotationsDir = path.join(baseDir, 'annotations');
    const snapshotsDir = path.join(baseDir, 'snapshots');

    try {
      fs.mkdirSync(annotationsDir, { recursive: true });
      fs.mkdirSync(snapshotsDir, { recursive: true });
    } catch {}

    return { annotationsDir, snapshotsDir };
  }

  public async processAnnotationPayload(payload: AnnotationPayload): Promise<{
    ok: boolean;
    annotationId: string;
    markdownPath: string;
    markdownContent: string;
    targetImagePath?: string;
    viewportImagePath?: string;
    userComment: string;
    error?: string;
    errorCode?: string;
  }> {
    try {
      const { annotationsDir, snapshotsDir } = this.getStorageDirectories(payload.workspaceDir);
      const timestamp = Date.now();
      const annotationId = payload.annotationId || `annotation_${timestamp}`;
      const safe = (val: unknown, max = 4000) => (typeof val === 'string' ? val.slice(0, max) : '');
      const userComment = safe(payload.userComment, 2000).trim();
      const selector = safe(payload.selector, 1000) || safe(payload.tagName, 100) || 'element';
      const dimensions = safe(payload.dimensions, 100);
      const domAncestry = safe(payload.domAncestry, 2000);
      const childCount = typeof payload.childCount === 'number' ? payload.childCount : 0;
      const childTags = Array.isArray(payload.childTags) ? payload.childTags.join(', ') : '';

      // 1. Save Target Image
      let targetImagePath = '';
      if (payload.targetImageBase64) {
        const rawBase64 = payload.targetImageBase64.replace(/^data:image\/\w+;base64,/, '');
        targetImagePath = path.join(snapshotsDir, `element_${timestamp}_target.png`);
        fs.writeFileSync(targetImagePath, Buffer.from(rawBase64, 'base64'));
      }

      // 2. Save Viewport Image
      let viewportImagePath = '';
      if (payload.viewportImageBase64) {
        const rawBase64 = payload.viewportImageBase64.replace(/^data:image\/\w+;base64,/, '');
        viewportImagePath = path.join(snapshotsDir, `element_${timestamp}_viewport.png`);
        fs.writeFileSync(viewportImagePath, Buffer.from(rawBase64, 'base64'));
      }

      // 3. Process Attached User Images
      const attachedImagesList = Array.isArray(payload.attachedImages) ? payload.attachedImages : [];
      const savedAttachedImages: Array<{ name: string; path: string }> = [];
      attachedImagesList.slice(0, 4).forEach((item, idx) => {
        if (item && typeof item.dataUrl === 'string') {
          try {
            const raw = item.dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const attPath = path.join(snapshotsDir, `element_${timestamp}_attach_${idx + 1}.png`);
            fs.writeFileSync(attPath, Buffer.from(raw, 'base64'));
            savedAttachedImages.push({ name: item.name || `attach_${idx + 1}`, path: attPath });
          } catch {}
        }
      });

      // 4. Build Evidence Envelope
      const evidenceEnvelope = buildEvidenceEnvelope({
        annotationId,
        generatedAt: new Date().toISOString(),
        sourceRevision: `doc_gen_${timestamp}`,
        captureMethod: 'snapdom_canvas',
        selectionType: 'element',
        evidenceStatus: 'complete',
        terminalState: getInitialTerminalState(userComment, classifyTaskIntent(userComment)),
      });

      // 5. Build Markdown Content
      const commentSection = userComment
        ? `\n## 💬 User Instructions / Prompt for AI\n> **${userComment.replaceAll('\n', '\n> ')}**\n`
        : '';

      const targetRelPath = targetImagePath ? `../snapshots/${path.basename(targetImagePath)}` : '';
      const viewportRelPath = viewportImagePath ? `../snapshots/${path.basename(viewportImagePath)}` : '';

      const targetImgSection = targetImagePath
        ? `![Target element](${targetRelPath})`
        : 'No target image captured.';
      const viewportImgSection = viewportImagePath
        ? `\n### Viewport context\n![Viewport context](${viewportRelPath})\n`
        : '';
      const attachedSection = savedAttachedImages.length > 0
        ? `\n## Attached images (user-provided)\n${savedAttachedImages.map((img) => `![${img.name}](../snapshots/${path.basename(img.path)})`).join('\n')}\n`
        : '';

      const rawStyles = payload.computedStyles ? Object.entries(payload.computedStyles) : [];
      const stylesList = rawStyles.length > 0
        ? rawStyles.filter(([k]) => ACTIVE_CSS_PROPERTIES[k] === true).slice(0, 30)
        : [];
      const attributesList = payload.attributes ? Object.entries(payload.attributes).slice(0, 30) : [];

      const isClone = payload.isClone || false;
      const canonicalEv = payload.canonicalEvidence || {};

      const elementIdentitySection = `## 🎯 Element Identity & Target Resolution
- Primary Scoped Selector: \`${selector}\`
- Uniqueness in DOM: ${payload.isUnique ? '✅ **100% Unique Match (1 node)**' : `⚠️ **Multiple Matches (${payload.matchCount || 'unknown'} nodes)**`}
- Carousel / Clone Status: ${isClone ? '⚠️ **IS_CLONE (Detected inside cloned loop/carousel slide)**' : '✅ **ORIGINAL_NODE (Non-cloned element)**'}
${isClone ? `- Canonical Counterpart: \`${canonicalEv.canonicalFound ? (canonicalEv.isUniqueCanonicalTarget ? 'Verified non-clone canonical found' : 'Multiple non-clone canonicals') : 'Unresolved'}\`\n- Owner Key: \`${canonicalEv.ownerKey || 'n/a'}="${canonicalEv.ownerValue || ''}"\`\n- Relative Subpath: \`${canonicalEv.relativeSubSelector || 'self'}\`\n- **Warning for AI Agent**: Element is inside a cloned slide (e.g. Slick/Swiper). Do NOT edit the clone wrapper. Modify the canonical template node or component matching the business key.` : ''}
- Loop/List Item: ${payload.isLoopItem ? `Yes (${payload.matchCount} sibling items with same signature)` : 'No'}
- Capture-Time Index: \`${payload.captureTimeDomIndex !== undefined ? payload.captureTimeDomIndex : 'n/a'}\`
- Index Stability: \`${payload.indexStability || 'stable'}\` ${payload.indexStability === 'unstable-on-rerender' ? '(⚠️ Index will change when list re-orders or filters; do not hardcode :nth-of-type in code edits)' : ''}
`;

      const formatBoxEdge = (val: unknown): string => {
        if (!val) return '0px';
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && val !== null) {
          const edge = val as { top?: number; right?: number; bottom?: number; left?: number };
          const t = edge.top ?? 0, r = edge.right ?? 0, b = edge.bottom ?? 0, l = edge.left ?? 0;
          if (t === b && r === l) {
            return t === r ? `${t}px` : `${t}px ${r}px`;
          }
          return `${t}px ${r}px ${b}px ${l}px`;
        }
        return String(val);
      };

      const contentW = payload.boxModel?.content?.width ?? payload.boxModel?.contentWidth;
      const contentH = payload.boxModel?.content?.height ?? payload.boxModel?.contentHeight;
      const contentSizeStr = (contentW !== undefined && contentH !== undefined) ? `${contentW} x ${contentH} px` : `${dimensions}`;

      const boxModelSection = payload.boxModel ? `## 📐 Layout & Box Model Metrics
- Dimensions: ${dimensions}
- Box Sizing: \`${payload.boxModel.boxSizing || 'border-box'}\`
- Margin: \`${formatBoxEdge(payload.boxModel.margin)}\`
- Border: \`${formatBoxEdge(payload.boxModel.border)}\`
- Padding: \`${formatBoxEdge(payload.boxModel.padding)}\`
- Content Size: \`${contentSizeStr}\`
` : '';

      const parentTag = payload.parentLayout?.parentTag || payload.parentLayout?.tag || 'unknown';
      const parentClasses = payload.parentLayout?.parentClasses || payload.parentLayout?.classes || (payload.parentLayout?.selector?.startsWith('.') ? [payload.parentLayout.selector.slice(1)] : []);
      const parentLayoutSection = payload.parentLayout ? `## 🧱 Parent Layout Context
- Parent Tag: \`${parentTag}\`${parentClasses?.length ? ` (\`.${parentClasses.join(' .')}\`)` : ''}
- Layout Mode: \`${payload.parentLayout.display || 'block'}\`
${payload.parentLayout.display?.includes('flex') ? `- Flex Properties: \`flex-direction: ${payload.parentLayout.flexDirection || 'row'}\`, \`justify-content: ${payload.parentLayout.justifyContent || 'flex-start'}\`, \`align-items: ${payload.parentLayout.alignItems || 'stretch'}\`${payload.parentLayout.gap ? `, \`gap: ${payload.parentLayout.gap}\`` : ''}` : ''}
${payload.parentLayout.display?.includes('grid') ? `- Grid Properties: \`grid-template-columns: ${payload.parentLayout.gridTemplateColumns || 'none'}\`${payload.parentLayout.gap ? `, \`gap: ${payload.parentLayout.gap}\`` : ''}` : ''}
` : '';

      const sourceHintsSection = payload.sourceHints && (payload.sourceHints.signals?.length || payload.sourceHints.framework !== 'unknown') ? `## 📍 Source Ownership & AST Code Locators
> High-confidence signals mapping this DOM element to codebase templates.

- Detected Framework: **${payload.sourceHints.framework || 'unknown'}** (Confidence: \`${payload.sourceHints.confidence || 'low'}\`)
${payload.sourceHints.suggestedFile ? `- Suggested Source File: \`${payload.sourceHints.suggestedFile}\`` : ''}
${payload.sourceHints.suggestedLine ? `- Suggested Line: \`${payload.sourceHints.suggestedLine}\`` : ''}
${payload.sourceHints.suggestedComponent ? `- Suggested Component: \`${payload.sourceHints.suggestedComponent}\`` : ''}
\`\`\`json
${JSON.stringify(payload.sourceHints, null, 2)}
\`\`\`
` : '';

      const siblingSemanticsSection = Array.isArray(payload.siblingSemantics) && payload.siblingSemantics.length > 0 ? `## 👯 Sibling & Context Semantics
${payload.siblingSemantics.map((sib: any, idx: number) => `- Sibling ${idx + 1}: \`<${sib.tag}>\`${sib.role ? ` (role: \`${sib.role}\`)` : ''}${sib.isTarget ? ' **[TARGET]**' : ''}${sib.textSnippet ? ` - "${sib.textSnippet}"` : ''}`).join('\n')}
` : '';

      const hasRuntimeErrors = Array.isArray(payload.runtimeErrors) && payload.runtimeErrors.length > 0;
      const hasResourceFailures = Array.isArray(payload.resourceFailures) && payload.resourceFailures.length > 0;
      const hasSlowResources = Array.isArray(payload.slowResources) && payload.slowResources.length > 0;
      const diagnosticsSection = (hasRuntimeErrors || hasResourceFailures || hasSlowResources) ? `## ⚠️ Correlated Runtime Diagnostics
${hasRuntimeErrors ? `### JavaScript Errors\n\`\`\`json\n${JSON.stringify(payload.runtimeErrors, null, 2)}\n\`\`\`\n` : ''}${hasResourceFailures ? `### Failed Network Resources (404/500)\n\`\`\`json\n${JSON.stringify(payload.resourceFailures, null, 2)}\n\`\`\`\n` : ''}${hasSlowResources ? `### Slow Resources (> 500ms)\n\`\`\`json\n${JSON.stringify(payload.slowResources, null, 2)}\n\`\`\`\n` : ''}
` : '';

      const liquidSection = payload.liquidContext && Object.values(payload.liquidContext).some(Boolean) ? `## ⚓ Liquid & Theme Semantic Anchors
\`\`\`json
${JSON.stringify(payload.liquidContext, null, 2)}
\`\`\`
` : '';

      const attributesSection = attributesList.length > 0 ? `## 🏷️ HTML Attributes
\`\`\`json
{
${attributesList.map(([key, value]) => `  "${safe(key, 100)}": ${JSON.stringify(safe(value, 500))}`).join(',\n')}
}
\`\`\`
` : '';

      const stylesSection = stylesList.length > 0 ? `## 🎨 Key Computed CSS Styles
\`\`\`css
${stylesList.map(([key, value]) => `${safe(key, 100)}: ${safe(value, 500)};`).join('\n')}
\`\`\`
` : '';

      const cleanedOuterHTML = payload.outerHTML
        ? safe(payload.outerHTML.replace(/src="data:image\/[^;]+;base64,[^"]{60,}"/gi, 'src="data:[image-base64]"'), 4000)
        : '';

      const detailedFileContent = `${evidenceEnvelope}
${buildAgentTaskHeader(userComment)}

## Captured element evidence [Visual Mode: Element SnapDOM Capture]
- Annotation ID: ${annotationId}
- Page URL: ${safe(payload.url, 4096)}
- Element Selector: \`${selector}\`
- DOM Ancestry: \`${domAncestry || selector}\`
- Tag Name: \`${safe(payload.tagName, 100)}\`
- Dimensions: ${dimensions}

${elementIdentitySection}
${boxModelSection}
${parentLayoutSection}
${siblingSemanticsSection}
${sourceHintsSection}
${liquidSection}
${commentSection}
## Visual evidence
Capture method: SnapDOM-rendered PNG produced from the selected element and its computed DOM styles.

### Target element
${targetImgSection}
${viewportImgSection}
${attachedSection}
${diagnosticsSection}
${attributesSection}
${payload.textContent && payload.textContent.trim() ? `## 📝 Text Content\n\`\`\`text\n${payload.textContent.trim()}\n\`\`\`\n` : ''}
${stylesSection}
${cleanedOuterHTML ? `## 🧩 Complete Outer HTML\n\`\`\`html\n${cleanedOuterHTML}\n\`\`\`\n` : ''}
${Array.isArray(payload.multiItems) && payload.multiItems.length > 1 ? `\n## Multi-Element Batch Breakdown (${payload.multiItems.length} Elements Selected)\n` + payload.multiItems.map((item, idx) => `### ${idx + 1}. \`${safe(item.selector, 200)}\`\n- Tag: \`${safe(item.tagName || item.tag, 50)}\`\n- Dimensions: ${safe(item.dimensions, 50)}\n${item.userComment ? `- User Comment: **${safe(item.userComment, 500)}**\n` : ''}${item.textContent ? `- Text: "${safe(item.textContent, 200)}"\n` : ''}`).join('\n') : ''}
`;

      const markdownFileName = `element_${timestamp}.md`;
      const markdownPath = path.join(annotationsDir, markdownFileName);
      fs.writeFileSync(markdownPath, detailedFileContent, 'utf8');

      return {
        ok: true,
        annotationId,
        markdownPath,
        markdownContent: detailedFileContent,
        targetImagePath,
        viewportImagePath,
        userComment: userComment || 'Inspect the attached browser element annotation.',
      };
    } catch (err: unknown) {
      let errorCode = '';
      if (err instanceof CapabilityError) {
        errorCode = err.code;
      }
      return {
        ok: false,
        annotationId: '',
        markdownPath: '',
        markdownContent: '',
        userComment: '',
        error: err instanceof Error ? err.message : String(err),
        errorCode: errorCode || undefined,
      };
    }
  }
}
