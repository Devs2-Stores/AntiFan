/**
 * AntiFan Core — Theme Source Mapper
 *
 * Maps rendered DOM hints to bounded, explainable source candidates. Candidates
 * remain guidance until a unique HIGH result satisfies the authoritative policy.
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

export type SourceEvidenceKind =
  | 'breadcrumb'
  | 'class_token'
  | 'data_attribute_value'
  | 'render_edge'
  | 'section_lineage'
  | 'attribute_key'
  | 'tag';

export interface SourceEvidenceLocator {
  kind: SourceEvidenceKind;
  file: string;
  line: number;
  matched: string;
  weight: number;
  parentFile?: string;
}

export interface CandidateTemplate {
  file: string;
  type: 'snippet' | 'section' | 'layout' | 'template' | 'asset' | 'unknown';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  correlated: boolean;
  evidence: SourceEvidenceLocator[];
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
  ambiguous: boolean;
  selectionReason: string;
  querySummary: {
    classesQueried: string[];
    attributesQueried: string[];
    workspaceRoot: string;
    filesScannedCount: number;
  };
}

interface LiquidDocument {
  absolutePath: string;
  relativePath: string;
  content: string;
  lines: string[];
}

interface RenderEdge {
  snippetName: string;
  parentFile: string;
  line: number;
}

export function isAuthoritativeSourceCandidate(result?: SourceMappingResult): boolean {
  const primary = result?.primaryCandidate;
  if (!primary || result?.ambiguous) return false;
  return primary.confidence === 'HIGH'
    && primary.score >= 7
    && primary.correlated
    && new Set(primary.evidence.map((item) => item.kind)).size >= 2;
}

export class ThemeSourceMapper {
  private static readonly MAX_FILES = 2_000;
  private static readonly MAX_CANDIDATES = 100;
  private static readonly MAX_EVIDENCE_PER_CANDIDATE = 12;
  private static readonly AMBIGUITY_MARGIN = 2;
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
          ambiguous: false,
        },
        error: `Theme workspace root does not exist: ${workspaceRoot}`,
      });
    }

    const distinctiveClasses = Array.from(new Set((hints.classes || [])
      .map((value) => value.trim())
      .filter((value) => /^[A-Za-z0-9_-]{3,}$/.test(value) && !this.COMMON_UTILITY_CLASSES.has(value.toLowerCase()))))
      .sort();
    const attributes = Object.entries(hints.attributes || {})
      .filter(([key]) => /^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right));
    const sectionHints = attributes
      .filter(([key, value]) => key.toLowerCase().includes('section') && value.trim().length > 0)
      .map(([, value]) => value.trim());
    const documents = this.readLiquidDocuments(normalizedRoot);
    const documentsByPath = new Map(documents.map((document) => [document.relativePath, document]));
    const renderEdges = this.indexRenderEdges(documents);
    const edgesBySnippet = new Map<string, RenderEdge[]>();
    for (const edge of renderEdges) {
      const current = edgesBySnippet.get(edge.snippetName) || [];
      current.push(edge);
      edgesBySnippet.set(edge.snippetName, current);
    }

    const candidates: CandidateTemplate[] = [];
    for (const document of documents) {
      const fileType = this.inferFileType(document.relativePath);
      const baseName = path.posix.basename(document.relativePath, '.liquid');
      const evidence: SourceEvidenceLocator[] = [];
      const pushEvidence = (locator: SourceEvidenceLocator): void => {
        if (evidence.length < this.MAX_EVIDENCE_PER_CANDIDATE) evidence.push(locator);
      };

      const classMatches: Array<{ token: string; line: number }> = [];
      for (let index = 0; index < document.lines.length; index++) {
        const staticTokens = this.extractStaticClassTokens(document.lines[index] || '');
        for (const token of distinctiveClasses) {
          if (staticTokens.has(token)) classMatches.push({ token, line: index + 1 });
        }
      }
      if (classMatches.length > 0) {
        pushEvidence({
          kind: 'class_token',
          file: document.relativePath,
          line: classMatches[0]!.line,
          matched: Array.from(new Set(classMatches.map((item) => item.token))).sort().join(' '),
          weight: 3,
        });
      }

      let matchedAttributeValue: { key: string; value: string; line: number } | undefined;
      let matchedAttributeKey: { key: string; line: number } | undefined;
      for (const [key, value] of attributes) {
        const attributePattern = new RegExp(`\\b${this.escapeRegExp(key)}\\s*=`, 'i');
        for (let index = 0; index < document.lines.length; index++) {
          const line = document.lines[index] || '';
          if (!attributePattern.test(line)) continue;
          if (!matchedAttributeKey) matchedAttributeKey = { key, line: index + 1 };
          if (value.trim().length > 0 && line.includes(value.trim())) {
            matchedAttributeValue = { key, value: value.trim(), line: index + 1 };
            break;
          }
        }
        if (matchedAttributeValue) break;
      }
      if (matchedAttributeValue) {
        pushEvidence({
          kind: 'data_attribute_value',
          file: document.relativePath,
          line: matchedAttributeValue.line,
          matched: `${matchedAttributeValue.key}=${matchedAttributeValue.value}`,
          weight: 3,
        });
      } else if (matchedAttributeKey) {
        pushEvidence({
          kind: 'attribute_key',
          file: document.relativePath,
          line: matchedAttributeKey.line,
          matched: matchedAttributeKey.key,
          weight: 1,
        });
      }

      const breadcrumb = (hints.commentHints || []).find((hint) => {
        const normalized = hint.replace(/\\/g, '/').toLowerCase();
        return normalized.includes(document.relativePath.toLowerCase()) || normalized.includes(baseName.toLowerCase());
      });
      if (breadcrumb) {
        pushEvidence({ kind: 'breadcrumb', file: document.relativePath, line: 1, matched: breadcrumb.slice(0, 160), weight: 5 });
      }

      const edges = fileType === 'snippet' ? (edgesBySnippet.get(baseName) || []) : [];
      if (edges.length > 0) {
        const edge = edges[0]!;
        pushEvidence({
          kind: 'render_edge',
          file: document.relativePath,
          line: edge.line,
          matched: edge.snippetName,
          weight: 2,
          parentFile: edge.parentFile,
        });
        const sectionEdge = edges.find((candidate) => candidate.parentFile.startsWith('sections/'));
        if (sectionEdge) {
          const parent = documentsByPath.get(sectionEdge.parentFile);
          const lineageHint = sectionHints.find((hint) => parent?.content.includes(hint));
          if (lineageHint) {
            pushEvidence({
              kind: 'section_lineage',
              file: document.relativePath,
              line: sectionEdge.line,
              matched: lineageHint,
              weight: 2,
              parentFile: sectionEdge.parentFile,
            });
          }
        }
      }

      if (hints.tagName && /^[A-Za-z][A-Za-z0-9-]*$/.test(hints.tagName)) {
        const tagPattern = new RegExp(`<${this.escapeRegExp(hints.tagName)}\\b`, 'i');
        const tagLine = document.lines.findIndex((line) => tagPattern.test(line));
        if (tagLine >= 0) {
          pushEvidence({ kind: 'tag', file: document.relativePath, line: tagLine + 1, matched: hints.tagName, weight: 1 });
        }
      }

      if (evidence.length === 0) continue;
      const kinds = new Set(evidence.map((item) => item.kind));
      const directKinds = new Set(evidence.filter((item) => item.kind === 'breadcrumb' || item.kind === 'class_token' || item.kind === 'data_attribute_value').map((item) => item.kind));
      const hasLineage = kinds.has('render_edge') || kinds.has('section_lineage');
      const correlated = directKinds.size > 0 && (hasLineage || directKinds.size >= 2);
      const score = evidence.reduce((total, item) => total + item.weight, 0);
      const sampleLines = evidence.slice(0, 5).map((item) => ({
        line: item.line,
        content: `${item.kind}: ${item.matched}`,
      }));
      candidates.push({
        file: document.relativePath,
        type: fileType,
        confidence: score >= 3 ? 'MEDIUM' : 'LOW',
        score,
        correlated,
        evidence,
        signals: {
          markupClassMatch: kinds.has('class_token'),
          renderCallMatch: fileType === 'snippet' ? kinds.has('render_edge') : 'unknown',
          referencedBySection: fileType === 'snippet' ? evidence.some((item) => item.kind === 'render_edge' && item.parentFile?.startsWith('sections/')) : 'unknown',
          dataAttributeMatch: kinds.has('data_attribute_value'),
        },
        matchCount: evidence.length,
        sampleLines,
      });
    }

    candidates.sort((left, right) => right.score - left.score || right.evidence.length - left.evidence.length || left.file.localeCompare(right.file));
    const boundedCandidates = candidates.slice(0, this.MAX_CANDIDATES);
    const first = boundedCandidates[0];
    const second = boundedCandidates[1];
    const ambiguous = Boolean(first && second && first.score - second.score < this.AMBIGUITY_MARGIN);
    if (first && first.score >= 7 && first.correlated && !ambiguous && new Set(first.evidence.map((item) => item.kind)).size >= 2) {
      first.confidence = 'HIGH';
    }
    const primary = ambiguous ? undefined : first;
    const selectionReason = !first
      ? 'No bounded source evidence matched the observed element hints.'
      : ambiguous
        ? `Top candidates are within ${this.AMBIGUITY_MARGIN - 1} point of each other; source identity remains ambiguous.`
        : first.confidence === 'HIGH'
          ? `Unique correlated HIGH candidate leads by ${second ? first.score - second.score : first.score} point(s).`
          : 'Best candidate is guidance only because authoritative HIGH criteria were not met.';

    return createThemeEvidenceEnvelope<SourceMappingResult>({
      success: true,
      evidenceQuality: primary?.confidence || 'LOW',
      data: {
        candidates: boundedCandidates,
        primaryCandidate: primary,
        ambiguous,
        selectionReason,
        querySummary: {
          classesQueried: distinctiveClasses,
          attributesQueried: attributes.map(([key]) => key),
          workspaceRoot: normalizedRoot,
          filesScannedCount: documents.length,
        },
      },
      signals: primary
        ? {
            markupClassMatch: primary.signals.markupClassMatch,
            renderCallMatch: primary.signals.renderCallMatch,
            referencedBySection: primary.signals.referencedBySection,
            ambiguous: false,
          }
        : {
            markupClassMatch: first?.signals.markupClassMatch || false,
            renderCallMatch: first?.signals.renderCallMatch ?? 'unknown',
            referencedBySection: first?.signals.referencedBySection ?? 'unknown',
            ambiguous,
          },
      timestamp: startTime,
    });
  }

  private static readLiquidDocuments(root: string): LiquidDocument[] {
    const paths = this.collectLiquidFiles(root).sort((left, right) => left.localeCompare(right));
    const documents: LiquidDocument[] = [];
    for (const absolutePath of paths) {
      try {
        const content = fs.readFileSync(absolutePath, 'utf8');
        documents.push({
          absolutePath,
          relativePath: path.relative(root, absolutePath).replace(/\\/g, '/'),
          content,
          lines: content.split(/\r?\n/),
        });
      } catch {}
    }
    return documents;
  }

  private static indexRenderEdges(documents: LiquidDocument[]): RenderEdge[] {
    const edges: RenderEdge[] = [];
    for (const document of documents) {
      for (let index = 0; index < document.lines.length; index++) {
        const line = document.lines[index] || '';
        for (const match of line.matchAll(/\{%-?\s*(?:render|include)\s+['"]([^'"]+)['"]/g)) {
          const rawName = match[1];
          if (!rawName) continue;
          const snippetName = rawName.replace(/\\/g, '/').replace(/^snippets\//, '').replace(/\.liquid$/, '');
          edges.push({ snippetName, parentFile: document.relativePath, line: index + 1 });
        }
      }
    }
    return edges.sort((left, right) => left.snippetName.localeCompare(right.snippetName) || left.parentFile.localeCompare(right.parentFile) || left.line - right.line);
  }

  private static extractStaticClassTokens(line: string): Set<string> {
    const tokens = new Set<string>();
    for (const match of line.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gi)) {
      for (const token of (match[2] || '').split(/\s+/)) {
        if (/^[A-Za-z0-9_-]+$/.test(token)) tokens.add(token);
      }
    }
    return tokens;
  }

  private static collectLiquidFiles(dir: string, results: string[] = []): string[] {
    if (results.length >= this.MAX_FILES) return results;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (results.length >= this.MAX_FILES) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') this.collectLiquidFiles(fullPath, results);
        } else if (entry.isFile() && entry.name.endsWith('.liquid')) {
          results.push(fullPath);
        }
      }
    } catch {}
    return results;
  }

  private static inferFileType(relPath: string): CandidateTemplate['type'] {
    if (relPath.startsWith('snippets/')) return 'snippet';
    if (relPath.startsWith('sections/')) return 'section';
    if (relPath.startsWith('layout/')) return 'layout';
    if (relPath.startsWith('templates/')) return 'template';
    if (relPath.startsWith('assets/')) return 'asset';
    return 'unknown';
  }

  private static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
