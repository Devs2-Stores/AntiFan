/**
 * Which tabs each execution attachment created through `anti.browser.tabs.create`.
 *
 * The session tab pool the browser host keeps answers "may this session drive that tab" only for
 * tabs in the same pool as the bound one. A rebind onto a tab outside the pool orphans every tab
 * the session opened earlier: the catalogue gate and `closeTab` both refuse them. A tab an
 * attachment created itself stays under that attachment's authority whatever it is bound to now,
 * so the creator can close or switch back to it; no other attachment inherits that authority.
 *
 * In memory only: a tab outlives the app process no more than the attachment that opened it.
 */
export class AttachmentTabLedger {
  private readonly tabsByAttachment = new Map<string, Set<string>>();

  /** Note that `attachmentId` created `tabId`. */
  record(attachmentId: string, tabId: string): void {
    if (!attachmentId || !tabId) return;
    let tabs = this.tabsByAttachment.get(attachmentId);
    if (!tabs) {
      tabs = new Set();
      this.tabsByAttachment.set(attachmentId, tabs);
    }
    tabs.add(tabId);
  }

  /** Whether `attachmentId` itself created `tabId`. */
  owns(attachmentId: string, tabId: string): boolean {
    return this.tabsByAttachment.get(attachmentId)?.has(tabId) === true;
  }

  /** Forget the tabs `isLive` reports gone, and any attachment left with none. */
  prune(isLive: (tabId: string) => boolean): void {
    for (const [attachmentId, tabs] of this.tabsByAttachment) {
      for (const tabId of tabs) {
        if (!isLive(tabId)) tabs.delete(tabId);
      }
      if (tabs.size === 0) this.tabsByAttachment.delete(attachmentId);
    }
  }

  /** Drop every tab recorded for an attachment that is gone. */
  release(attachmentId: string): void {
    this.tabsByAttachment.delete(attachmentId);
  }

  /** Drop the record of every attachment that is not in `liveAttachmentIds`. */
  retainAttachments(liveAttachmentIds: ReadonlySet<string>): void {
    for (const attachmentId of [...this.tabsByAttachment.keys()]) {
      if (!liveAttachmentIds.has(attachmentId)) this.release(attachmentId);
    }
  }
}
