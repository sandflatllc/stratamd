import { expect, test } from '@playwright/test'
import { Scenario, primaryKey, selectTextInVisualEditor, sourceEditor } from './harness'

// Link and image forms (usability round 2 §2.8). window.prompt does not exist
// in Electron, so these used to fail silently; now an in-editor form opens,
// prefilled from the existing link or image, Enter applies, Escape cancels.
const document = '# Links\n\nVisit the docs site today.\n\nAn [old link](https://old.example) sits here.\n'

test('Ctrl+K adds a link to the selection, edits an existing link, and the Image menu inserts an image', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, document, 'links.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })

    // A selection plus Ctrl+K: the address becomes the link.
    await selectTextInVisualEditor(page, 'docs site')
    await page.keyboard.press(primaryKey('k'))
    const addLink = page.getByRole('dialog', { name: 'Add link' })
    await expect(addLink).toBeVisible()
    const address = addLink.getByRole('textbox', { name: 'Address' })
    await expect(address).toBeFocused()
    await address.fill('https://example.com/docs')
    await page.keyboard.press('Enter')
    await expect(addLink).toBeHidden()
    await expect(editor).toBeFocused()
    await expect(editor.locator('a[href="https://example.com/docs"]')).toHaveText('docs site')

    // A caret inside an existing link edits that link, prefilled.
    await page.getByText('old link').click()
    await expect(page.getByRole('dialog', { name: 'Open web link', exact: true })).toBeVisible()
    await page.keyboard.press(primaryKey('k'))
    await expect(page.getByRole('dialog', { name: 'Open web link', exact: true })).toHaveCount(0)
    const editLink = page.getByRole('dialog', { name: 'Edit link' })
    await expect(editLink).toBeVisible()
    await expect(editLink.getByRole('textbox', { name: 'Address' })).toHaveValue('https://old.example')
    await editLink.getByRole('textbox', { name: 'Address' }).fill('https://new.example')
    await editLink.getByRole('textbox', { name: 'Title (optional)' }).fill('New home')
    await page.keyboard.press('Enter')
    await expect(editLink).toBeHidden()
    await expect(editor.locator('a[href="https://new.example"]')).toHaveText('old link')

    // Escape cancels without touching the text and returns focus to the editor.
    await selectTextInVisualEditor(page, 'today')
    await page.keyboard.press(primaryKey('k'))
    await expect(addLink).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(addLink).toBeHidden()
    await expect(editor).toBeFocused()
    await expect(editor.locator('a')).toHaveCount(2)

    // The Image menu inserts an image with alt text.
    await page.getByText('sits here').click()
    await page.keyboard.press('End')
    await page.getByRole('toolbar', { name: 'Formatting' }).getByLabel('Image', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Insert image…' }).click()
    const addImage = page.getByRole('dialog', { name: 'Add image' })
    await expect(addImage).toBeVisible()
    await addImage.getByRole('textbox', { name: 'Path or address' }).fill('images/figure.png')
    await addImage.getByRole('textbox', { name: 'Alt text' }).fill('A figure')
    await page.keyboard.press('Enter')
    await expect(addImage).toBeHidden()

    const source = await sourceEditor(page)
    const markdown = await source.inputValue()
    expect(markdown).toContain('[docs site](https://example.com/docs)')
    expect(markdown).toContain('[old link](https://new.example "New home")')
    expect(markdown).toContain('![A figure](images/figure.png)')
  } finally {
    await scenario.dispose()
  }
})
