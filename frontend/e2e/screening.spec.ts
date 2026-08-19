import { expect, test } from '@playwright/test'

test(
    'reviewer completes every criterion and excludes a publication',
    async ({ page }) => {
      let submittedDecision: unknown = null
      let decisionSubmitted = false

      await page.route('**/api/v1/auth/session', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 'reviewer',
              username: 'reviewer',
              displayName: 'Reviewer',
              isAdmin: false,
              isActive: true,
            },
            csrfToken: 'csrf-token',
          }),
        })
      })

      await page.route(
          '**/api/v1/projects/project-1',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({}),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/screening/full_text/next',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(
                  decisionSubmitted
                      ? null
                      : {
                        id: 'work-1',
                        publication: {
                          id: 'publication-1',
                          title: 'Immersive Urban Analytics',
                          authors: 'A. Author',
                          abstract: 'Urban analytics in virtual reality.',
                          doi: '10.1000/example',
                          publisherUrl: null,
                        },
                        criteria: [
                          {
                            id: 'include-vr',
                            kind: 'inclusion',
                            text: 'Uses virtual reality',
                          },
                          {
                            id: 'exclude-editorial',
                            kind: 'exclusion',
                            text: 'Is an editorial',
                          },
                        ],
                        draft: {},
                      },
              ),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/screening/work-items/work-1/decision',
          async (route) => {
            submittedDecision = route.request().postDataJSON()
            decisionSubmitted = true

            await route.fulfill({
              status: 201,
              contentType: 'application/json',
              body: JSON.stringify({
                id: 'decision-1',
                ...(submittedDecision as Record<string, unknown>),
              }),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/screening/work-items/work-1/llm-full-text',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                state: 'text_unavailable',
                hidden: false,
                stale: false,
                error: 'Usable full text is not available yet.',
              }),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/screening/full_text/progress',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                assigned: 1,
                completed: decisionSubmitted ? 1 : 0,
                remaining: decisionSubmitted ? 0 : 1,
                claimMode: false,
              }),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/full-text/progress',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ total: 1, addressed: 1 }),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/full-text/next',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(null),
            })
          },
      )

      await page.route(
          '**/api/v1/browser-agents',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify([]),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/pdf-retrieval-batches/missing-count',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ missingCount: 0 }),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/pdf-retrieval-batches',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify([]),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/publications/publication-1/full-text',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ available: false, document: null }),
            })
          },
      )

      await page.route(
          '**/api/v1/projects/project-1/highlight-keywords',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ keywords: [] }),
            })
          },
      )

      await page.goto(
          '/projects/project-1/full-text',
      )

      await expect(
          page.getByRole('heading', {
            name: 'Immersive Urban Analytics',
          }),
      ).toBeVisible()

      const submit = page.getByRole('button', {
        name: 'Submit Decision',
      })

      await page
          .getByRole('checkbox', {
            name: /Inclusion: Uses virtual reality.*Not fulfilled/,
          })
          .check()

      await expect(page.getByRole('radio', { name: 'Exclude' })).toBeChecked()
      await expect(submit).toBeEnabled()

      await page
          .getByLabel('Notes')
          .fill('Outside the intended scope.')

      await expect(submit).toBeEnabled()
      await submit.click()

      // Full-text screening has no separate confirmation step: a single
      // click stores the decision and immediately advances to the next item.
      await expect.poll(() => decisionSubmitted).toBe(true)

      await expect(
          page.getByText('No full-text work is currently available for you.'),
      ).toBeVisible()

      expect(submittedDecision).toEqual({
        outcome: 'exclude',
        criteriaAnswers: {
          'include-vr': false,
          'exclude-editorial': false,
        },
        notes: 'Outside the intended scope.',
      })
    },
)
