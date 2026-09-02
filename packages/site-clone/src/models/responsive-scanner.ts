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
}
