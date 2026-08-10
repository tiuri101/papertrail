import { expect, test } from '@playwright/test'

test('administrator generates and downloads an Excel export', async ({ page }) => {
  const artifacts: Array<{ id: string; type: string; filename: string; createdAt: string }> = []

  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'admin', username: 'admin', displayName: 'Administrator', isAdmin: true, isActive: true },
        csrfToken: 'csrf-token',
      }),
    })
  })
  await page.route('**/api/v1/projects/project-1/prisma', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ recordsScreened: 120, reportsIncluded: 18 }) })
  })
  await page.route('**/api/v1/projects/project-1/exports', async (route) => {
    if (route.request().method() === 'POST') {
      const artifact = { id: 'export-1', type: 'xlsx', filename: 'papertrail-project-1.xlsx', createdAt: '2026-07-30T08:00:00Z' }
      artifacts.push(artifact)
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(artifact) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(artifacts) })
  })

  await page.goto('/projects/project-1/reporting')
  const counts = page.locator('.reporting-counts-card')
  await expect(counts.getByText('Records Screened')).toBeVisible()
  await expect(counts.getByText('120', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Generate Excel Workbook' }).click()
  await expect(page.getByRole('link', { name: 'papertrail-project-1.xlsx' })).toHaveAttribute(
    'href',
    '/api/v1/projects/project-1/exports/export-1/download',
  )
})
