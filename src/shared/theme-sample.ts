// The sample document the theme panel opens (PRD §6.13). It is written to the
// config directory as `Theme sample.md` and opened as an ordinary tab, so it
// renders exactly as any document does. Every construct from PRD §6.1 appears,
// and the text of each one says which theme value colors it.

export const THEME_SAMPLE_FILE_NAME = 'Theme sample.md'

export const THEME_SAMPLE_MARKDOWN = `# This is a level-one heading

It uses the **Main headings** color from the Document text group. Level-two headings use the same color.

## A level-two heading, also "Main headings"

Paragraphs like this one use **Paragraph text**. Inside a paragraph, **bold words use the Bold text color**, *italic words use the Italic text color*, and ~~struck-through words stay paragraph colored with a line through them~~. Words in \`backticks are inline code\` and use the Code text color on the Code and preview background. [Links use the Links color](https://example.com).

### A level-three heading

Levels three through six are "Smaller headings". Below is level four:

#### A level-four heading

- Bullet lists use Paragraph text; the bullet markers use **Quotes and list markers**.
- A second bullet, to show spacing.
  - A nested bullet, one level in.

1. Numbered lists work the same way.
2. The numbers use Quotes and list markers.

- [x] A finished task. The check uses the Accept, keep, and save color.
- [ ] An open task. The box border mixes Borders and rules with the Primary actions color.

> A block quote. Its text and the bar on its left use **Quotes and list markers**.

| Tables | use Borders and rules for lines |
|---|---|
| Header cells | sit on the Inset and hover background with Table heading text |
| Body cells | use Paragraph text |

\`\`\`
A code block. The text is Code text, the box is the Code and preview
background, and the font is the Code and keyboard font.
\`\`\`

The line below is a horizontal rule, drawn in Borders and rules.

---

Timestamps in the panels use **Fine print and timestamps**; panel headings use **Titles and active labels**; dialog paragraphs and change rows use **Interface body text**; file rows and quiet controls use **Secondary interface text**.

What you cannot see here: the panels around this document use the **Panel background** on the **Window background**; hovered rows and chips use the **Inset and hover background**; what you type into goes on the **Text field background**; the menu that appears when you select text uses the **Popover and toast background**. Your annotations are **Your changes** and each attached agent has its own color. The glows and motes behind everything come from the five effect colors in Decoration and motion.
`
