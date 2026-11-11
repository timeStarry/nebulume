import { isTextEntry } from './model';

/**
 * Desktop-shell behaviour shared by every window: the WebView's own context menu
 * (reload, inspect, back) never appears. Our `ContextMenu` handlers call
 * `preventDefault` themselves; text fields and selected text keep the native menu
 * so copy and paste still work.
 */
export function shouldSuppressNativeMenu(
  target: EventTarget | null,
  selection: string,
  devOverride: boolean,
): boolean {
  if (devOverride) return false;
  if (isTextEntry(target)) return false;
  if (selection.trim()) return false;
  return true;
}

let installed = false;
export function installDesktopShell() {
  if (installed) return;
  installed = true;
  document.addEventListener('contextmenu', (event) => {
    // Shift+right-click in development builds still reaches the inspector.
    const devOverride = import.meta.env.DEV && event.shiftKey;
    if (
      shouldSuppressNativeMenu(event.target, window.getSelection()?.toString() ?? '', devOverride)
    )
      event.preventDefault();
  });
}
