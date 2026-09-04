/**
 * AntiFan Core — Theme Source Mapper
 *
 * Maps rendered DOM element telemetry to local theme source files (Liquid snippets/sections).
 * Follows the 2-signal rule for HIGH confidence: requires at least two independent evidence
 * signals (e.g. class match + render call match) before recommending a primary candidate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ThemeEvidenceEnvelope,
  createThemeEvidenceEnvelope,
} from '../tools/theme-evidence-envelope';

export interface ElementSourceHints {
  tagName?: string;
  classes?: string[];
  attributes?: Record<string, string>;
  textSnippet?: string;
  commentHints?: string[];
}

export interface CandidateTemplate {
  file: string;
  type: 'snippet' | 'section' | 'layout' | 'template' | 'asset' | 'unknown';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  signals: {
    markupClassMatch: boolean;
    renderCallMatch: boolean | 'unknown';
    referencedBySection: boolean | 'unknown';
    dataAttributeMatch?: boolean;
  };
  matchCount: number;
  sampleLines?: Array<{ line: number; content: string }>;
}

export interface SourceMappingResult {
  candidates: CandidateTemplate[];
  primaryCandidate?: CandidateTemplate;
  querySummary: {
    classesQueried: string[];
    attributesQueried: string[];
    workspaceRoot: string;
    filesScannedCount: number;
  };
}

export class ThemeSourceMapper {
  private static readonly COMMON_UTILITY_CLASSES = new Set([
    'flex', 'grid', 'hidden', 'block', 'inline', 'inline-block', 'relative', 'absolute',
    'fixed', 'w-full', 'h-full', 'container', 'wrapper', 'active', 'open', 'show',
  ]);

  public static mapElementToSource(
    workspaceRoot: string,
    hints: ElementSourceHints
  ): ThemeEvidenceEnvelope<SourceMappingResult> {
    const startTime = Date.now();
    const normalizedRoot = path.resolve(workspaceRoot);

    if (!fs.existsSync(normalizedRoot)) {
      return createThemeEvidenceEnvelope<SourceMappingResult>({
        success: false,
        evidenceQuality: 'LOW',
        signals: {
          markupClassMatch: false,
          renderCallMatch: 'unknown',
          referencedBySection: 'unknown',
        },
        error: `Theme workspace root does not exist: ${workspaceRoot}`,
      });
    }

    const files = this.collectLiquidFiles(normalizedRoot);
    const distinctiveClasses = (hints.classes || [])
      .map((c) => c.trim())
      .filter((c) => c.length > 2 && !this.COMMON_UTILITY_CLASSES.has(c.toLowerCase()));

    const candidates: CandidateTemplate[] = [];

    // Map of snippet name to list of files referencing it via {% render '...' %} or {% include '...' %}
    const renderReferences = new Map<string, string[]>();
    // First pass: index render calls across all files
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const renderMatches = content.matchAll(/\{%-?\s*(?:render|include)\s+['"]([^'"]+)['"]/g);
        for (const match of renderMatches) {
          const snippetName = match[1];
          if (snippetName) {
            const list = renderReferences.get(snippetName) || [];
            list.push(filePath.replace(/\\/g, '/'));
            renderReferences.set(snippetName, list);
          }
        }
      } catch {}
    }

    for (const filePath of files) {
      const relPath = path.relative(normalizedRoot, filePath).replace(/\\/g, '/');
      const fileType = this.inferFileType(relPath);
      const baseName = path.basename(relPath, '.liquid');

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let matchCount = 0;
        const sampleLines: Array<{ line: number; content: string }> = [];

        // Check 1: Distinctive Class Matching
        let markupClassMatch = false;
        for (const cls of distinctiveClasses) {
          if (content.includes(cls)) {
            markupClassMatch = true;
            matchCount++;
            for (let i = 0; i < lines.length; i++) {
              const currentLine = lines[i];
              if (currentLine && currentLine.includes(cls) && sampleLines.length < 5) {
                sampleLines.push({ line: i + 1, content: currentLine.trim() });
              }
            }
          }
        }

        // Check 2: Render Call Matching
        const isRendered = renderReferences.has(baseName);
        const renderCallMatch: boolean | 'unknown' = fileType === 'snippet' ? isRendered : 'unknown';

        // Check 3: Section References
        let referencedBySection: boolean | 'unknown' = 'unknown';
        if (fileType === 'snippet') {
          const refs = renderReferences.get(baseName) || [];
          referencedBySection = refs.some((r) => r.replace(/\\/g, '/').includes('sections/'));
        }

        // Check 4: Data Attribute Matches
        let dataAttributeMatch = false;
        if (hints.attributes) {
          for (const [attrKey, attrVal] of Object.entries(hints.attributes)) {
            if (attrVal && typeof attrVal === 'string' && attrVal.length > 2) {
              if (content.includes(attrVal) || content.includes(attrKey)) {
                dataAttributeMatch = true;
                matchCount += 2;
              }
            }
          }
        }
        // Check 5: HTML comment breadcrumb match (e.g. <!-- snippets/example-snippet.liquid -->)
        if (hints.commentHints) {
          for (const comment of hints.commentHints) {
            if (comment && comment.includes(baseName)) {
              matchCount += 3;
            }
          }
        }

        if (markupClassMatch || dataAttributeMatch || matchCount > 0) {
          // Strict Confidence Evaluation:
          // HIGH requires at least 2 independent signals
          const signalCount =
            (markupClassMatch ? 1 : 0) +
            (renderCallMatch === true ? 1 : 0) +
            (referencedBySection === true ? 1 : 0) +
            (dataAttributeMatch ? 1 : 0);

          let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
          if (signalCount >= 2) {
            confidence = 'HIGH';
          } else if (signalCount === 1) {
            confidence = 'MEDIUM';
          }

          candidates.push({
            file: relPath,
            type: fileType,
            confidence,
            signals: {
              markupClassMatch,
              renderCallMatch,
              referencedBySection,
              dataAttributeMatch,
            },
            matchCount,
            sampleLines,
          });
        }
      } catch {}
    }

    // Sort candidates: HIGH > MEDIUM > LOW, then by matchCount descending
    candidates.sort((a, b) => {
      const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      const rankDiff = rank[b.confidence] - rank[a.confidence];
      if (rankDiff !== 0) return rankDiff;
      return b.matchCount - a.matchCount;
    });

    const primary = candidates[0];
    const overallQuality = primary ? primary.confidence : 'LOW';

    return createThemeEvidenceEnvelope<SourceMappingResult>({
      success: true,
      evidenceQuality: overallQuality,
      data: {
        candidates,
        primaryCandidate: primary,
        querySummary: {
          classesQueried: distinctiveClasses,
          attributesQueried: Object.keys(hints.attributes || {}),
          workspaceRoot: normalizedRoot,
          filesScannedCount: files.length,
        },
      },
      signals: primary
        ? {
            markupClassMatch: primary.signals.markupClassMatch,
            renderCallMatch: primary.signals.renderCallMatch,
            referencedBySection: primary.signals.referencedBySection,
          }
        : {
            markupClassMatch: false,
            renderCallMatch: 'unknown',
            referencedBySection: 'unknown',
          },
      timestamp: startTime,
    });
  }

  private static collectLiquidFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip node_modules and dot-directories
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            results.push(...this.collectLiquidFiles(fullPath));
          }
        } else if (entry.isFile() && entry.name.endsWith('.liquid')) {
          results.push(fullPath);
        }
      }
    } catch {}
    return results;
  }

  private static inferFileType(relPath: string): CandidateTemplate['type'] {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.includes('snippets/')) return 'snippet';
    if (normalized.includes('sections/')) return 'section';
    if (normalized.includes('layout/')) return 'layout';
    if (normalized.includes('templates/')) return 'template';
    if (normalized.includes('assets/')) return 'asset';
    return 'unknown';
  }
}
