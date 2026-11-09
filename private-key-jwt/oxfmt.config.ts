import { defineConfig } from 'oxfmt'

export default defineConfig({
    semi: false,
    trailingComma: 'all',
    singleQuote: true,
    printWidth: 120,
    tabWidth: 4,
    sortPackageJson: false,
    sortImports: {
        newlinesBetween: true,
        groups: [['builtin', 'external'], 'internal', 'parent', 'sibling', 'index'],
    },
})
