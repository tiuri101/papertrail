import { expect, test } from '@playwright/test'

test('reviewer completes every criterion and excludes a publication with a reason', async ({ page }) => {
  let submittedDecision: unknown = null

  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'reviewer', username: 'reviewer', displayName: 'Reviewer', isAdmin: false, isActive: true },
        csrfToken: 'csrf-token',
      }),
    })
  })
  await page.route('**/api/v1/projects/project-1', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        exclusionReasons: [{ id: 'wrong-topic', stage: 'title_abstract', label: 'Wrong topic' }],
      }),
    })
  })
  await page.route('**/api/v1/projects/project-1/screening/title_abstract/next', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'work-1',
        publication: {
          title: 'Immersive Urban Analytics',
          authors: 'A. Author',
          abstract: 'Urban analytics in virtual reality.',
          doi: '10.1000/example',
          publisherUrl: null,
        },
        criteria: [
          { id: 'include-vr', kind: 'inclusion', text: 'Uses virtual reality' },
          { id: 'exclude-editorial', kind: 'exclusion', text: 'Is an editorial' },
        ],
        draft: {},
      }),
    })
  })
  await page.route('**/api/v1/projects/project-1/screening/work-items/work-1/decision', async (route) => {
    submittedDecision = route.request().postDataJSON()
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'decision-1' }) })
  })

  await page.goto('/projects/project-1/screening/title_abstract')
  await page.getByRole('button', { name: 'Get next publication' }).click()
  await expect(page.getByRole('heading', { name: 'Immersive Urban Analytics' })).toBeVisible()

  const submit = page.getByRole('button', { name: 'Submit decision' })
  await expect(submit).toBeDisabled()
  await page.getByLabel('inclusion: Uses virtual reality').selectOption('true')
  await page.getByLabel('exclusion: Is an editorial').selectOption('false')
  await page.getByLabel('Decision').selectOption('exclude')
  await expect(submit).toBeDisabled()
  await page.getByLabel('Exclusion reason').selectOption('wrong-topic')
  await page.getByLabel('Notes').fill('Outside the intended scope.')
  await submit.click()

  await expect(page.getByRole('button', { name: 'Get next publication' })).toBeVisible()
  expect(submittedDecision).toEqual({
    outcome: 'exclude',
    criteriaAnswers: { 'include-vr': true, 'exclude-editorial': false },
    exclusionReasonId: 'wrong-topic',
    notes: 'Outside the intended scope.',
  })
})
