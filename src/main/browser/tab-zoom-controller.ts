/**
 * AntiFan Browser Desktop — Tab Zoom Controller
 * Manages zoom factors for the application UI and individual webview tabs.
 */

export class TabZoomController {
  private appZoomFactor: number = 1.0;

  public getAppZoom(): number {
    return this.appZoomFactor;
  }

  public setAppZoom(zoomFactor: number): number {
    this.appZoomFactor = Math.max(0.25, Math.min(3.0, Number(zoomFactor.toFixed(2))));
    return this.appZoomFactor;
  }

  public adjustAppZoom(delta: number): number {
    return this.setAppZoom(this.appZoomFactor + delta);
  }

  public clampTabZoom(zoomFactor: number): number {
    return Math.max(0.25, Math.min(5.0, Number(zoomFactor.toFixed(2))));
  }

  public calculateNextTabZoom(currentZoom: number, direction: 'in' | 'out'): number {
    const step = 0.1;
    const next = direction === 'in' ? currentZoom + step : currentZoom - step;
    return this.clampTabZoom(next);
  }
}
