import { renderConnectionPanel } from '../shared/connection-panel'
import { requireElement } from '../shared/dom'

async function boot(): Promise<void> {
  requireElement<HTMLElement>('app').innerHTML = `
    <h1>Papertrail Browser Helper</h1>
    <div id="connection-panel"></div>
  `
  await renderConnectionPanel('connection-panel')
}

void boot()
