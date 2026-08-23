/** Prefix used to derive matching tab/tabpanel ids, e.g. "analysis" -> "analysis-tab-x" / "analysis-tabpanel-x". */
export function tabId(idPrefix: string, id: string) {
  return `${idPrefix}-tab-${id}`
}

export function tabPanelId(idPrefix: string, id: string) {
  return `${idPrefix}-tabpanel-${id}`
}
