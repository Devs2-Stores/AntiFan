/**
 * Script: Verify Independent Clone Fidelity against Reference
 * Executes visual compare on Chromium across Desktop (1440px) and Mobile (375px) breakpoints.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

export async function verifyCloneFidelity(port: any, referenceTabId: string, cloneTabId: string, target: any) {
  const desktopResult = await port.visualCompare(
    target,
    'run-fidelity',
    'att-desktop',
    {
      comparisonTabId: cloneTabId,
      tolerance: 2.0,
      normalizeScroll: true,
      allowHeightDrift: true,
      fullPage: true
    }
  );

  const mobileResult = await port.visualCompare(
    target,
    'run-fidelity',
    'att-mobile',
    {
      comparisonTabId: cloneTabId,
      tolerance: 2.0,
      normalizeScroll: true,
      allowHeightDrift: true,
      fullPage: true,
      paneId: 'mobile'
    }
  );

  return {
    desktop: desktopResult,
    mobile: mobileResult,
    fidelityPassed: desktopResult.match && mobileResult.match
  };
}
