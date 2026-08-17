export interface PopupWindowOptions {
  width?: number
  height?: number
  focused?: boolean
}

const DEFAULT_WIDTH = 440
const DEFAULT_HEIGHT = 620

// Approximates the height of the tab strip + address bar + bookmarks bar
// above a normal browser window's content area, so the anchored window
// doesn't land on top of them. Chrome doesn't expose the real toolbar
// height to extensions, so this is a reasonable fixed offset rather than
// something computed precisely.
const TOOLBAR_OFFSET = 90
const EDGE_MARGIN = 12

async function anchorNearExtensionButton(
  width: number,
): Promise<{ left?: number; top?: number }> {
  try {
    const current = await chrome.windows.getCurrent()
    if (
      typeof current.left !== 'number'
      || typeof current.top !== 'number'
      || typeof current.width !== 'number'
    ) {
      return {}
    }
    // The extensions toolbar (where this extension's button lives) sits at
    // the top-right of the browser window, so anchor new windows there
    // too, rather than wherever Chrome would otherwise place them.
    const left = Math.max(current.left, current.left + current.width - width - EDGE_MARGIN)
    const top = current.top + TOOLBAR_OFFSET
    return { left, top }
  } catch {
    return {}
  }
}

/**
 * Opens an extension page in a small chrome-less window (`type: 'popup'`)
 * instead of a normal browser tab -- no tab strip, no bookmarks bar, no
 * menu, and no navigable address bar, just the page itself. Used for the
 * pairing/settings page and the retrieval session page so they read as
 * part of the Papertrail Browser Helper rather than a generic browser tab.
 * Unlike the toolbar action popup, this window does not close when it
 * loses focus, so a retrieval session can keep running in the background.
 * Positioned near the top-right of the current browser window, close to
 * where the extension's own toolbar button lives.
 */
export async function openExtensionPopupWindow(
  path: string,
  options: PopupWindowOptions = {},
): Promise<chrome.windows.Window> {
  const width = options.width ?? DEFAULT_WIDTH
  const height = options.height ?? DEFAULT_HEIGHT
  const { left, top } = await anchorNearExtensionButton(width)
  return chrome.windows.create({
    url: chrome.runtime.getURL(path),
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: options.focused ?? true,
  })
}
