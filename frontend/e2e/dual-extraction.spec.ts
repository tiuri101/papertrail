import { expect, test } from '@playwright/test'

test(
    'dual extraction: reviewer submits an independent slot, then a manager reconciles a disagreement',
    async ({ page }) => {
      await page.route('**/api/v1/auth/session', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 'manager',
              username: 'manager',
              displayName: 'Manager',
              isAdmin: false,
              isActive: true,
            },
            csrfToken: 'csrf-token',
          }),
        })
      })

      await page.route('**/api/v1/projects/project-1', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ canManage: true, canAdjudicate: true }),
        })
      })

      // --- Step 1: reviewer independently submits their extraction slot ---
      let submittedAnswers: unknown = null
      await page.route(
          '**/api/v1/projects/project-1/extraction/next',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                id: 'item-a',
                publicationId: 'publication-1',
                status: 'reserved',
                draft: {},
                publication: {
                  title: 'Immersive Urban Analytics',
                  authors: 'A. Author',
                  publicationYear: 2024,
                  doi: null,
                  publisherUrl: null,
                },
                fields: [
                  { stableKey: 'outcome', label: 'Outcome', fieldType: 'single_select', required: true, options: ['Positive', 'Negative'] },
                ],
                currentResponse: null,
                slotNumber: 1,
                requiredReviewers: 2,
              }),
            })
          },
      )
      await page.route(
          '**/api/v1/projects/project-1/publications/publication-1/full-text',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ available: false, document: null, retrievalStatus: null }),
            })
          },
      )
      await page.route(
          '**/api/v1/projects/project-1/extraction/item-a/llm-suggestions',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                state: 'disabled',
                runId: null,
                documentId: null,
                schemaVersion: null,
                model: null,
                outdated: false,
                error: null,
                suggestions: [],
              }),
            })
          },
      )
      await page.route(
          '**/api/v1/projects/project-1/extraction/item-a',
          async (route) => {
            submittedAnswers = route.request().postDataJSON()
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                id: 'response-a',
                answers: (submittedAnswers as { answers: Record<string, unknown> }).answers,
                version: 1,
                formVersionId: 'fv-1',
              }),
            })
          },
      )

      await page.goto('/projects/project-1/extraction')

      await expect(page.getByRole('heading', { name: 'Immersive Urban Analytics' })).toBeVisible()
      await expect(page.getByText('Independent extraction 1 of 2')).toBeVisible()

      await page.getByLabel('Outcome *').selectOption('Positive')
      await page.getByRole('button', { name: 'Submit Extraction' }).click()

      await expect.poll(() => submittedAnswers).not.toBeNull()
      expect((submittedAnswers as { answers: Record<string, unknown> }).answers).toEqual({
        outcome: 'Positive',
      })

      // --- Step 2: the other reviewer's independent slot (submitted earlier,
      // out of band) disagreed, so the publication is now in the
      // reconciliation queue. A manager resolves it. ---
      let reconciled = false
      await page.route(
          '**/api/v1/projects/project-1/extraction/reconciliation',
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(
                  reconciled
                      ? []
                      : [{
                        publication: {
                          id: 'publication-1',
                          title: 'Immersive Urban Analytics',
                          authors: 'A. Author',
                          doi: null,
                          publisherUrl: null,
                        },
                      }],
              ),
            })
          },
      )
      await page.route(
          '**/api/v1/projects/project-1/extraction/reconciliation/publication-1',
          async (route) => {
            if (route.request().method() === 'POST') {
              reconciled = true
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                  id: 'final-1',
                  publicationId: 'publication-1',
                  answers: { outcome: 'Positive' },
                  resolutionMethod: 'reconciliation',
                }),
              })
              return
            }
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                publication: {
                  id: 'publication-1',
                  title: 'Immersive Urban Analytics',
                  authors: 'A. Author',
                  doi: null,
                  publisherUrl: null,
                },
                fullTextAvailable: false,
                fields: [
                  { stableKey: 'outcome', label: 'Outcome', fieldType: 'single_select', required: true, position: 0, options: ['Positive', 'Negative'] },
                ],
                comparisons: [
                  { stableKey: 'outcome', fieldType: 'single_select', valueA: 'Positive', valueB: 'Negative', agree: false },
                ],
              }),
            })
          },
      )

      await page.goto('/projects/project-1/extraction/reconciliation')

      await expect(page.getByRole('heading', { name: 'Immersive Urban Analytics' })).toBeVisible()
      await expect(page.getByText('1 publication awaiting reconciliation')).toBeVisible()

      await page.getByRole('button', { name: 'Reconcile' }).click()
      await expect(page.getByText('Positive')).toBeVisible()
      await expect(page.getByText('Negative')).toBeVisible()

      await page.getByRole('button', { name: 'Use A' }).click()
      await page.getByLabel('Reconciliation note').fill('Reviewer A matches the source PDF.')

      const submitReconciliation = page.getByRole('button', { name: 'Submit Reconciliation' })
      await expect(submitReconciliation).toBeEnabled()
      await submitReconciliation.click()

      await expect(page.getByText('0 publications awaiting reconciliation')).toBeVisible()
    },
)
