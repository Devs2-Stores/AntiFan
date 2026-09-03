/**
 * Model 3: Responsive Scanner
 * Detects, models, and asserts layout behaviors across Desktop, Tablet, and Mobile viewports
 */

export interface ViewportDefinition {
  name: 'desktop' | 'tablet' | 'mobile';
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  mediaQuery: string;
}

export interface ResponsiveLayoutConstraint {
  archetype: string;
  desktop: {
    columns: number;
    gapPx: number;
    containerMaxWidthPx: number;
    direction: 'row' | 'column';
    visible: boolean;
  };
  tablet: {
    columns: number;
    gapPx: number;
    containerMaxWidthPx: number;
    direction: 'row' | 'column';
    visible: boolean;
  };
  mobile: {
    columns: number;
    gapPx: number;
    containerMaxWidthPx: number;
    direction: 'row' | 'column';
    visible: boolean;
  };
}

export interface ResponsiveBreakpointConfig {
  desktop: ViewportDefinition;
  tablet: ViewportDefinition;
  mobile: ViewportDefinition;
}

export class ResponsiveScanner {
  public static readonly BREAKPOINTS: ResponsiveBreakpointConfig = {
    desktop: {
      name: 'desktop',
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      mediaQuery: '@media (min-width: 1025px)'
    },
    tablet: {
      name: 'tablet',
      width: 768,
      height: 1024,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      mediaQuery: '@media (min-width: 768px) and (max-width: 1024px)'
    },
    mobile: {
      name: 'mobile',
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      mediaQuery: '@media (max-width: 767px)'
    }
  };

  public getViewport(name: 'desktop' | 'tablet' | 'mobile'): ViewportDefinition {
    return ResponsiveScanner.BREAKPOINTS[name];
  }

  public getAllViewports(): ViewportDefinition[] {
    return [
      ResponsiveScanner.BREAKPOINTS.desktop,
      ResponsiveScanner.BREAKPOINTS.tablet,
      ResponsiveScanner.BREAKPOINTS.mobile
    ];
  }

  public inferLayoutConstraints(archetype: string, itemCount: number = 4): ResponsiveLayoutConstraint {
    switch (archetype) {
      case 'product_grid':
      case 'featured_products':
      case 'collection_list':
        return {
          archetype,
          desktop: {
            columns: Math.min(itemCount, 4) || 4,
            gapPx: 24,
            containerMaxWidthPx: 1200,
            direction: 'row',
            visible: true
          },
          tablet: {
            columns: Math.min(itemCount, 2) || 2,
            gapPx: 16,
            containerMaxWidthPx: 768,
            direction: 'row',
            visible: true
          },
          mobile: {
            columns: 1,
            gapPx: 12,
            containerMaxWidthPx: 390,
            direction: 'row',
            visible: true
          }
        };

      case 'hero_slider':
      case 'slider':
        return {
          archetype,
          desktop: {
            columns: 1,
            gapPx: 0,
            containerMaxWidthPx: 1440,
            direction: 'row',
            visible: true
          },
          tablet: {
            columns: 1,
            gapPx: 0,
            containerMaxWidthPx: 768,
            direction: 'row',
            visible: true
          },
          mobile: {
            columns: 1,
            gapPx: 0,
            containerMaxWidthPx: 390,
            direction: 'column',
            visible: true
          }
        };

      case 'header':
      case 'category_navigation':
        return {
          archetype,
          desktop: {
            columns: 1,
            gapPx: 16,
            containerMaxWidthPx: 1440,
            direction: 'row',
            visible: true
          },
          tablet: {
            columns: 1,
            gapPx: 12,
            containerMaxWidthPx: 768,
            direction: 'row',
            visible: true
          },
          mobile: {
            columns: 1,
            gapPx: 8,
            containerMaxWidthPx: 390,
            direction: 'column',
            visible: true
          }
        };

      default:
        return {
          archetype,
          desktop: {
            columns: 1,
            gapPx: 16,
            containerMaxWidthPx: 1200,
            direction: 'column',
            visible: true
          },
          tablet: {
            columns: 1,
            gapPx: 16,
            containerMaxWidthPx: 768,
            direction: 'column',
            visible: true
          },
          mobile: {
            columns: 1,
            gapPx: 12,
            containerMaxWidthPx: 390,
            direction: 'column',
            visible: true
          }
        };
    }
  }

  public generateResponsiveCss(constraint: ResponsiveLayoutConstraint, selector: string): string {
    const desktopRules = constraint.desktop.direction === 'row' && constraint.desktop.columns > 1
      ? `display: grid; grid-template-columns: repeat(${constraint.desktop.columns}, 1fr); gap: ${constraint.desktop.gapPx}px;`
      : `display: flex; flex-direction: ${constraint.desktop.direction}; gap: ${constraint.desktop.gapPx}px;`;

    const tabletRules = constraint.tablet.direction === 'row' && constraint.tablet.columns > 1
      ? `display: grid; grid-template-columns: repeat(${constraint.tablet.columns}, 1fr); gap: ${constraint.tablet.gapPx}px;`
      : `display: flex; flex-direction: ${constraint.tablet.direction}; gap: ${constraint.tablet.gapPx}px;`;

    const mobileRules = constraint.mobile.direction === 'row' && constraint.mobile.columns > 1
      ? `display: grid; grid-template-columns: repeat(${constraint.mobile.columns}, 1fr); gap: ${constraint.mobile.gapPx}px;`
      : `display: flex; flex-direction: ${constraint.mobile.direction}; gap: ${constraint.mobile.gapPx}px;`;

    return [
      `/* Desktop */`,
      `${ResponsiveScanner.BREAKPOINTS.desktop.mediaQuery} {`,
      `  ${selector} { ${desktopRules} }`,
      `}`,
      `/* Tablet */`,
      `${ResponsiveScanner.BREAKPOINTS.tablet.mediaQuery} {`,
      `  ${selector} { ${tabletRules} }`,
      `}`,
      `/* Mobile */`,
      `${ResponsiveScanner.BREAKPOINTS.mobile.mediaQuery} {`,
      `  ${selector} { ${mobileRules} }`,
      `}`
    ].join('\n');
  }
}
