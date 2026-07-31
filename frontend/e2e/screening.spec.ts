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
              body: JSON.stringify({ id: 'decision-1' }),
            })
          },
      )

      await page.goto(
          '/projects/project-1/screening/full_text',
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

      await expect(page.getByLabel('Decision')).toHaveValue('exclude')
      await expect(submit).toBeEnabled()

      await page
          .getByLabel('Notes')
          .fill('Outside the intended scope.')

      await expect(submit).toBeEnabled()
      await submit.click()

      await expect(
          page.getByText('No publications are currently available.'),
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
