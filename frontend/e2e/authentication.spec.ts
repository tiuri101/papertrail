import { expect, test } from '@playwright/test'

const adminSession = {
  user: {
    id: 'admin',
    username: 'admin',
    displayName: 'Administrator',
    isAdmin: true,
    isActive: true,
  },
  csrfToken: 'csrf-token',
}

test('unauthenticated users can sign in and see administrator navigation', async ({
                                                                                    page,
                                                                                  }) => {
  let signedIn = false

  await page.route('**/api/v1/auth/session', async (route) => {
    if (!signedIn) {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Not authenticated' },
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(adminSession),
    })
  })

  await page.route('**/api/v1/auth/login', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      username: 'admin',
      password: 'secret-password',
    })

    signedIn = true

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(adminSession),
    })
  })

  await page.route('**/api/v1/projects', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    })
  })

  await page.goto('/')

  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('secret-password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(
      page.getByRole('link', { name: 'Papertrail home' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Users' })).toBeVisible()
})

test('reviewers do not see administrator-only navigation', async ({
                                                                    page,
                                                                  }) => {
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

  await page.route('**/api/v1/projects', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    })
  })

  await page.goto('/')

  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0)
})